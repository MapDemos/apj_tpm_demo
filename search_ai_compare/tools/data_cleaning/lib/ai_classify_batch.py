"""
ai-classify/ai-retry の --batch-api 指定時に使うロジック（旧 classify_queries_batch.py、
旧 ai-classify-batch 独立サブコマンドは廃止・統合済み）。

Anthropic Message Batches API を使って query 配列を分類する。
- 通常の /v1/messages ではなく /v1/messages/batches を使う非同期バッチ処理
- トークン単価が通常の50%（Anthropic公式の割引）
- 送信から結果取得まで数分〜最大24時間かかる（目安は1時間以内）
- プロキシ経由では動かない可能性が高いため、本物の ANTHROPIC_API_KEY で
  Anthropic API に直接アクセスする

事前準備:
    export ANTHROPIC_API_KEY=sk-ant-...   （プロキシ用キーではなく、本物のAPIキーが必要）
    ※anthropicパッケージ自体はmain.pyのensure_anthropic_venv_and_reexec()が
      .venv/ を自動作成してインストールするので手動インストール不要

anthropicパッケージは本機能専用の依存なので、main.py側で遅延import
（--batch-api指定時のみimport）し、他のサブコマンドには影響しないようにしている。

2026-08-26、ai_classify.py（プロキシ版）と同様に2段階分離方式へ変更: フェーズ1
（level12_model）でai_classification/_2を軽量プロンプトで判定し、フェーズ2
（level3_model）でunique_poi/brand_poi/categoryと判定された行だけを対象に
ai_classification_3（taxonomyリーフ）を判定する。--batch-api使用時はlevel12_model/
level3_modelに同じモデル（haiku or sonnet単独。main.py参照）を渡す運用だが、
その場合でも2フェーズに分けることで、taxonomy+BRAND_KNOWLEDGEを含む重い
system prompt（SYSTEM_PROMPT_LEVEL3）をaddress/semantic_query/unknown行に
送らずに済むメリットは残る。
"""

import json
import os
import sys
import time
import uuid

import anthropic
from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
from anthropic.types.messages.batch_create_params import Request

from lib import brand_match
from lib.classification_common import (
    POI_SUBTYPE_VALUES,
    SYSTEM_PROMPT_LEVEL12,
    SYSTEM_PROMPT_LEVEL3,
    build_level12_user_content,
    decode_leaf_responses,
    decode_pairs_with_candidates,
    leaves_for_matched_brand,
    parse_response_text,
)
from lib.output_utils import OUTPUT_DIR

MAX_REQUESTS_PER_JOB = 100_000
POLL_INTERVAL_SECONDS = 30
# ポーリング中にネットワークエラー（PCスリープからの復帰直後など）が起きた場合の
# リトライ間隔。ジョブ自体はAnthropic側で動き続けているので、繋がるまで無限に
# リトライする（スリープでプロセスが落ちない限り、ユーザーの操作なしで復帰できる）。
NETWORK_RETRY_SECONDS = 30

Record = tuple[str, str, str]  # (ai_classification, ai_classification_2, ai_classification_3)
# ai_classification_3は複数リーフを持てる場合、classification_common.LEAF_DELIMITER
# ("|") で連結した1文字列として入る（classification_common.encode_leaves参照）。


def _build_params(system_prompt: str, user_content: str, model: str) -> MessageCreateParamsNonStreaming:
    params: MessageCreateParamsNonStreaming = {
        "model": model,
        "max_tokens": 4096,
        # system_promptはSYSTEM_PROMPT_LEVEL3の場合BRAND_KNOWLEDGE(1500件超の
        # ブランド辞書)を埋め込んでおりサイズが大きい。Batches API内の各リクエストは
        # 独立実行だが、同一ジョブ内で同じsystem promptを使い回すためcache_controlを
        # 付けておく（Anthropic Messages APIのプロンプトキャッシュ機能）。
        "system": [{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
        "messages": [{"role": "user", "content": user_content}],
    }
    # temperatureは以前はhaiku指定時に付与していたが、anthropicパッケージ1.0.0で
    # Messages.create()からtemperature引数自体が削除され、個別リトライ
    # （_classify_single_direct、同期client.messages.create()を直接呼ぶ経路）が
    # `unexpected keyword argument 'temperature'`のTypeErrorで失敗するようになった
    # （2026-08-27発覚。Sonnet 5では元々invalid_request_errorになる非推奨パラメータ
    # でもあった）。決定性への寄与よりSDKバージョン間の互換性を優先し、temperatureは
    # 一切付与しない。
    if "haiku" not in model:
        # Sonnet 5はthinkingを省略すると（Sonnet 4.6以前と違い）自動的にadaptive
        # thinkingがONになり、max_tokensがthinking＋本文の合計消費になってしまう。
        # 分類タスクではthinkingは不要かつ有害（本文が出力される前にmax_tokensを
        # 使い切りJSONが不完全になる）ため明示的に無効化する
        # （search_ai_compareのAI診断機能で見つかった"thinking暴走"と同種のバグ）。
        params["thinking"] = {"type": "disabled"}
    return params


def _build_request_level12(chunk_items: list[tuple[str, list[str] | None]], model: str, custom_id: str) -> Request:
    """chunk_itemsは(query, 機械マッチしたブランド候補配列 or None)の組。
    候補が無い(None)クエリはbuild_level12_user_content側で文字列単体に戻される
    （BRAND_CANDIDATE_GUIDANCE参照）。"""
    queries = [q for q, _ in chunk_items]
    candidates = [c for _, c in chunk_items]
    user_content = build_level12_user_content(queries, candidates)
    return Request(custom_id=custom_id, params=_build_params(SYSTEM_PROMPT_LEVEL12, user_content, model))


def _build_request_level3(chunk_items: list[tuple[str, str]], model: str, custom_id: str) -> Request:
    user_content = json.dumps([[q, sub] for q, sub in chunk_items], ensure_ascii=False)
    return Request(custom_id=custom_id, params=_build_params(SYSTEM_PROMPT_LEVEL3, user_content, model))


def _state_file_path(run_id: str) -> str:
    return os.path.join(OUTPUT_DIR, f"batch_state_{run_id}.json")


def _save_state(state_path: str, state: dict) -> None:
    """途中経過をディスクに保存する。ジョブ作成直後（結果取得前）に必ず呼ぶことで、
    スクリプトがクラッシュ/強制終了してもjob_idを失わず--resume-batch-jobで
    再開できるようにする。"""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(state_path, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def load_resume_state(state_path: str) -> dict:
    with open(state_path, encoding="utf-8") as f:
        return json.load(f)


def _retrieve_with_retry(client: anthropic.Anthropic, job_id: str):
    """client.messages.batches.retrieve()をネットワークエラー耐性付きで呼ぶ。
    PCがスリープ→復帰した直後などで接続が一時的に切れているケースを想定し、
    ジョブ自体はAnthropic側で動き続けているという前提のもと無限にリトライする
    （APIキー不正など非ネットワーク系のエラーはそのまま送出し、呼び出し元で
    致命的エラーとして扱う）。"""
    while True:
        try:
            return client.messages.batches.retrieve(job_id)
        except anthropic.APIConnectionError as e:
            print(
                f"  警告: ネットワークエラーのため{NETWORK_RETRY_SECONDS}秒後にリトライします: {e}",
                file=sys.stderr,
            )
            time.sleep(NETWORK_RETRY_SECONDS)


def run_batch_job(
    client: anthropic.Anthropic, requests: list[Request], state_path: str, state: dict, jobs_section: str, job_key: str,
) -> dict:
    """1つのバッチジョブを送信し、完了までポーリングしてから結果を返す。
    戻り値は custom_id -> result.result のマッピング。

    jobs_section（"jobs_level12" or "jobs_level3"）でフェーズごとにジョブ台帳を
    分けて管理する。state[jobs_section][job_key]に既にjob_idがあれば
    （--resume-batch-job経由の再開、またはAnthropic側で既に完了済みのジョブの
    再ポーリング）ジョブ作成をスキップしてそのjob_idのポーリングから再開する。
    新規作成した場合は、結果取得前に必ずstate_pathへjob_idを書き込む。"""
    existing = state[jobs_section].get(job_key)
    if existing:
        job_id = existing["job_id"]
        print(f"バッチジョブ再開: {job_id}（{len(requests)}リクエスト）", file=sys.stderr)
    else:
        job = client.messages.batches.create(requests=requests)
        job_id = job.id
        print(f"バッチジョブ作成: {job_id}（{len(requests)}リクエスト）", file=sys.stderr)
        state[jobs_section][job_key] = {"job_id": job_id}
        _save_state(state_path, state)

    while True:
        job = _retrieve_with_retry(client, job_id)
        counts = job.request_counts
        print(
            f"  status={job.processing_status} "
            f"processing={counts.processing} succeeded={counts.succeeded} "
            f"errored={counts.errored} canceled={counts.canceled} expired={counts.expired}",
            file=sys.stderr,
        )
        if job.processing_status == "ended":
            break
        time.sleep(POLL_INTERVAL_SECONDS)

    results_by_id = {}
    for result in client.messages.batches.results(job_id):
        results_by_id[result.custom_id] = result.result
    return results_by_id


def _classify_single_direct(client: anthropic.Anthropic, system_prompt: str, user_content: str, model: str):
    """バッチ全体が失敗した際に、1件だけを通常の(非バッチ)Messages APIで即時に
    再試行する共通処理。Batches APIをもう一度使うと数分〜のポーリング待ちが
    再発生するため、個別リトライには同期APIを使う（ai_classify.pyの
    _classify_single_safeと同じ考え方）。パース済みのitems配列（1要素のリスト）
    またはNone（失敗時）を返す。"""
    params = _build_params(system_prompt, user_content, model)
    try:
        message = client.messages.create(**params)
        content_blocks = message.content or []
        text = "".join(b.text for b in content_blocks if b.type == "text")
        text = parse_response_text(text)
        items = json.loads(text)
        if not isinstance(items, list) or len(items) != 1:
            raise ValueError("要素数不一致")
        usage = message.usage
        return items, usage.input_tokens or 0, usage.output_tokens or 0
    except (anthropic.APIError, ValueError, json.JSONDecodeError, TypeError) as e:
        print(f"    警告: 個別再試行も失敗（フォールバックします）: {e}", file=sys.stderr)
        return None, 0, 0


def _run_phase_batches(
    client: anthropic.Anthropic,
    input_items: list,
    batch_size: int,
    model: str,
    state: dict,
    state_path: str,
    jobs_section: str,
    system_prompt: str,
    build_request_fn,
    build_single_content_fn,
    decode_fn,
    unknown_record,
    phase_label: str,
) -> tuple[list, int, int, int, set[int]]:
    """1フェーズ分（level1/2 または level3）のBatches APIジョブを、
    MAX_REQUESTS_PER_JOBごとに分割して実行し、各チャンクの結果をdecode_fnで
    デコードして input_items と同じ順序のrecordsリストを返す。バッチ全体が
    失敗した場合は1件ずつ個別に（同期APIで）再試行し、それでも失敗した要素だけを
    unknown_recordにフォールバックする。
    戻り値は (records, input tokens合計, output tokens合計,
    失敗レンジ数（個別リトライに回った回数）, フォールバックになったinput_items内の
    インデックス集合)。

    decode_fn(items, chunk_input_items)は、LLM応答をパースしたitemsに加えて
    対応するinput_items[start:end]（レベル1/2のブランド候補付き判定で、各要素に
    どの候補配列を渡したかをデコード側でも参照する必要があるため。レベル3では
    第2引数は使わない）も受け取る2引数関数。"""
    n = len(input_items)
    records: list = [unknown_record] * n
    total_in = 0
    total_out = 0
    failed_ranges = 0
    failed_indices: set[int] = set()

    chunks = []  # (start, end, custom_id, Request)
    for start in range(0, n, batch_size):
        end = min(start + batch_size, n)
        custom_id = f"batch-{start}"
        chunks.append((start, end, custom_id, build_request_fn(input_items[start:end], model, custom_id)))

    def retry_and_fill(start: int, end: int, reason: str) -> None:
        nonlocal total_in, total_out, failed_ranges
        print(f"  警告({phase_label}): batch-{start} は{reason}。1件ずつ個別に再試行します", file=sys.stderr)
        failed_ranges += 1
        for i in range(start, end):
            items, in_tok, out_tok = _classify_single_direct(
                client, system_prompt, build_single_content_fn(input_items[i]), model,
            )
            total_in += in_tok
            total_out += out_tok
            if items is None:
                failed_indices.add(i)
                continue
            records[i] = decode_fn(items, [input_items[i]])[0]

    for job_start in range(0, len(chunks), MAX_REQUESTS_PER_JOB):
        job_chunks = chunks[job_start:job_start + MAX_REQUESTS_PER_JOB]
        job_requests = [req for _, _, _, req in job_chunks]
        job_key = str(job_start)

        results_by_id = run_batch_job(client, job_requests, state_path, state, jobs_section, job_key)

        for start, end, custom_id, _ in job_chunks:
            result = results_by_id.get(custom_id)
            chunk_len = end - start

            if result is None:
                retry_and_fill(start, end, "結果が見つかりません")
                continue

            if result.type != "succeeded":
                detail = ""
                if result.type == "errored":
                    detail = f": {result.error.error.type} - {result.error.error.message}"
                retry_and_fill(start, end, f"{result.type}{detail}")
                continue

            message = result.message
            content_blocks = message.content or []
            text = "".join(b.text for b in content_blocks if b.type == "text")
            text = parse_response_text(text)

            try:
                items = json.loads(text)
                if not isinstance(items, list) or len(items) != chunk_len:
                    raise ValueError("要素数不一致")
                chunk_records = decode_fn(items, input_items[start:end])
            except (json.JSONDecodeError, ValueError) as e:
                retry_and_fill(start, end, f"パースに失敗: {e}")
                continue

            for i, record in enumerate(chunk_records):
                records[start + i] = record

            usage = message.usage
            total_in += usage.input_tokens or 0
            total_out += usage.output_tokens or 0

    return records, total_in, total_out, failed_ranges, failed_indices


def classify_unique(
    queries: list[str],
    batch_size: int,
    level12_model: str,
    level3_model: str,
    api_key: str | None = None,
    resume_state_path: str | None = None,
) -> tuple[dict[str, Record], int, int, int, set[str]]:
    """queriesからユニークな値だけを抽出し、Batches APIで2段階に分けて分類する。
    {query文字列: (ai_classification, ai_classification_2, ai_classification_3)} の辞書・
    input/outputトークン合計（フェーズ1・2の合算）・失敗レンジ数（個別リトライに
    回った回数の合計）・個別リトライでも失敗しfallbackのunknownになったquery集合を
    返す。ai_classify.classify_unique（プロキシ版）と同じ2段階設計（モジュール
    docstring参照）で、重複クエリをまとめて送ることでコストと不整合を抑える点も同様。

    api_key を渡すと ANTHROPIC_API_KEY 環境変数の代わりにそれを使う。

    resume_state_path を渡すと、そのパスに保存済みのjob_idを使ってポーリングから
    再開する（新規ジョブは作らない。フェーズ1が既に完了していれば、そのジョブは
    即座にended状態として返ってくるだけなのでフェーズ2から実質的に再開される）。
    前回と同じ入力から呼ばれたことを保証するため、unique_queries/batch_size/
    level12_model/level3_model/candidates_per_queryが状態ファイルの内容と
    完全一致するか検証し、ズレていれば例外を送出する（結果を誤った行に書き込むのを
    防ぐため。candidates_per_queryはbrand_match（BRAND_CATEGORY_MAP/BRAND_SYNONYMS）
    のデータが前回実行時から更新されていた場合、送信済みジョブの応答内の
    候補番号(idx)を誤って別の候補配列に対して解釈してしまう事故を防ぐために
    含めている）。"""
    unique_queries = list(dict.fromkeys(queries))
    client = anthropic.Anthropic(api_key=api_key) if api_key else anthropic.Anthropic()

    # brand_match: クエリごとに機械的な部分一致（表記体系をまたぐ）で検出した
    # ブランド名候補を求め、候補があるクエリだけレベル1/2の入力に添える
    # （BRAND_CANDIDATE_GUIDANCE参照。候補が無いクエリは今まで通り文字列単体で
    # 送るため挙動は変わらない）。
    brand_idx = brand_match.build_index()
    candidates_per_query: list[list[str] | None] = [
        sorted(brand_match.find_candidates(q, brand_idx)) or None for q in unique_queries
    ]

    if resume_state_path:
        state = load_resume_state(resume_state_path)
        if (
            state["unique_queries"] != unique_queries
            or state["batch_size"] != batch_size
            or state["level12_model"] != level12_model
            or state["level3_model"] != level3_model
            or state.get("candidates_per_query") != candidates_per_query
        ):
            raise ValueError(
                "--resume-batch-job: 状態ファイルの内容が今回の入力（クエリ内容/--batch-size/--model/"
                "ブランド辞書データ）と一致しません。前回と同じCSV・同じ絞り込み条件・同じオプションで"
                "実行してください。"
            )
        state_path = resume_state_path
    else:
        run_id = uuid.uuid4().hex[:12]
        state_path = _state_file_path(run_id)
        state = {
            "unique_queries": unique_queries,
            "batch_size": batch_size,
            "level12_model": level12_model,
            "level3_model": level3_model,
            "candidates_per_query": candidates_per_query,
            "jobs_level12": {},
            "jobs_level3": {},
        }
        _save_state(state_path, state)

    level12_input = list(zip(unique_queries, candidates_per_query))

    triples, total_in, total_out, failed_ranges, failed_idx12 = _run_phase_batches(
        client, level12_input, batch_size, level12_model, state, state_path, "jobs_level12",
        SYSTEM_PROMPT_LEVEL12,
        _build_request_level12,
        lambda item: build_level12_user_content([item[0]], [item[1]]),
        lambda items, chunk: decode_pairs_with_candidates(items, [c for _, c in chunk]),
        ("unknown", "", None),
        "レベル1/2分類",
    )
    failed_queries: set[str] = {unique_queries[i] for i in failed_idx12}

    poi_indices = [i for i, (_, sub, _matched) in enumerate(triples) if sub in POI_SUBTYPE_VALUES]
    leaf_by_index: dict[int, str] = {}

    # ④: ブランド候補の中からLLMが確定させたブランドで、かつBRAND_CATEGORY_MAPに
    # taxonomyリーフの参照データがある場合は、レベル3のLLM判定を省略して辞書から
    # 直接採用する（project memory参照。brand_poi判定は既にlevel12側で確定済み
    # なので、taxonomyリーフも同じ情報源から一貫して取れる場合はLLMに二度聞かない）。
    poi_indices_needing_llm = []
    for i in poi_indices:
        _c1, c2, matched_brand = triples[i]
        shortcut_leaf = leaves_for_matched_brand(matched_brand, c2)
        if shortcut_leaf is not None:
            leaf_by_index[i] = shortcut_leaf
        else:
            poi_indices_needing_llm.append(i)

    if poi_indices_needing_llm:
        level3_items = [(unique_queries[i], triples[i][1]) for i in poi_indices_needing_llm]
        leaves, in3, out3, failed_ranges3, failed_idx3 = _run_phase_batches(
            client, level3_items, batch_size, level3_model, state, state_path, "jobs_level3",
            SYSTEM_PROMPT_LEVEL3,
            _build_request_level3,
            lambda item: json.dumps([[item[0], item[1]]], ensure_ascii=False),
            lambda items, _chunk: decode_leaf_responses(items),
            "unknown",
            "レベル3分類(taxonomy)",
        )
        total_in += in3
        total_out += out3
        failed_ranges += failed_ranges3
        for local_i, global_i in enumerate(poi_indices_needing_llm):
            leaf_by_index[global_i] = leaves[local_i]
        for local_i in failed_idx3:
            failed_queries.add(level3_items[local_i][0])

    records: list[Record] = []
    for i, (c1, c2, _matched) in enumerate(triples):
        c3 = leaf_by_index.get(i, "") if c2 in POI_SUBTYPE_VALUES else ""
        records.append((c1, c2, c3))

    # 全フェーズの結果を取り込めたので、再開用の状態ファイルはもう不要。
    try:
        os.remove(state_path)
    except OSError:
        pass

    mapping = dict(zip(unique_queries, records))
    return mapping, total_in, total_out, failed_ranges, failed_queries
