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
その場合でも2フェーズに分けることで、taxonomyを含む重いsystem prompt
（SYSTEM_PROMPT_LEVEL3）をaddress/semantic_query/unknown行に送らずに済む
メリットは残る。

2026-08-27、ai_classify.pyと同じ修正を適用: LLM応答の要素数が入力とズレて
頻発していた問題への対策として、入出力の各要素にインデックスを付与し、応答から
実質的に欠落した要素だけを個別リトライする方式に変更（以前はチャンクの応答配列長が
1件でも合わないとチャンク全体・既定30件を個別リトライしていた）。

2026-08-27〜08-29、level3対象をsubtype（brand_poi / unique_poi・category）で
2グループに分けてSYSTEM_PROMPT_LEVEL3_BRAND（BRAND_KNOWLEDGE埋め込みあり）/
SYSTEM_PROMPT_LEVEL3_LIGHT（埋め込みなし）に振り分ける実装を一時期使っていたが、
実データ検証で辞書埋め込みの効果が確認できなかった一方、他プロンプトの8〜13倍の
トークンを消費していたと判明したため撤去し、全subtype共通のSYSTEM_PROMPT_LEVEL3
1本に統合した（classification_common.pyのモジュールdocstring・project memory参照）。
これに伴い、level3対象の2グループ分割自体も不要になったため撤去した。

2026-08-28、ai_classify.py（同期経路）と同じ第3フェーズを追加: "category"×
taxonomy unknown（ai_classification_2="category"かつai_classification_3=
"unknown"）の組み合わせだけを対象に、level2判定自体を再確認する
（classification_common.build_system_prompt_category_recheckのdocstring・
project memory参照）。ジョブ台帳は"jobs_recheck"（再判定本体）・
"jobs_level3_recheck"（再判定でunique_poi/brand_poiに訂正された行のtaxonomy
再判定）で管理し、--resume-batch-jobでの再開にも対応する。
"""

import json
import math
import os
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

import anthropic
from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
from anthropic.types.messages.batch_create_params import Request

from lib import brand_match
from lib.classification_common import (
    POI_SUBTYPE_VALUES,
    SYSTEM_PROMPT_CATEGORY_RECHECK,
    SYSTEM_PROMPT_LEVEL12,
    SYSTEM_PROMPT_LEVEL3,
    add_usage,
    build_level12_user_content,
    build_level3_user_content,
    decode_indexed_leaf_responses,
    decode_indexed_level12_responses,
    decode_indexed_recheck_responses,
    leaves_for_matched_brand,
    new_usage_totals,
    parse_response_text,
    raise_if_cancelled,
)
from lib.output_utils import OUTPUT_DIR

MAX_REQUESTS_PER_JOB = 100_000
POLL_INTERVAL_SECONDS = 30
# ポーリング中にネットワークエラー（PCスリープからの復帰直後など）が起きた場合の
# リトライ間隔。ジョブ自体はAnthropic側で動き続けているので、繋がるまで無限に
# リトライする（スリープでプロセスが落ちない限り、ユーザーの操作なしで復帰できる）。
NETWORK_RETRY_SECONDS = 30
# 2026-08-29、チャンク失敗時の欠落要素リトライを1件ずつの個別呼び出しから
# このサイズ単位のグループ呼び出しに変更した際の単位（project memory参照）。
# 1件ずつだとチャンク丸ごと失敗時にsystem promptを欠落件数分（最大batch_size件）
# 再送する無駄が大きい（batch_size=300なら最大300倍）ため、グループにまとめて
# 再送信の回数自体を減らす。このグループリトライでもなお欠落した要素は、
# それ以上の再試行はせずunknown_recordにフォールバックする。
RETRY_GROUP_SIZE = 100

Record = tuple[str, str, str, str]  # (ai_classification, ai_classification_2, ai_classification_3, brand)
# ai_classification_3は複数リーフを持てる場合、classification_common.LEAF_DELIMITER
# ("|") で連結した1文字列として入る（classification_common.encode_leaves参照）。

# 2026-08-29実測（08-26データ、level3の1件あたり出力トークン: 平均17・p99 24・
# 最大39）を基にした、1件あたりの安全マージン込み必要トークン数（39÷安全率0.8）。
# Batches API本体（_build_request_level12/_build_request_recheck/
# _build_request_level3）用のmax_tokensをbatch_sizeから動的に計算する
# _batch_max_tokens()と、個別/グループリトライ用の固定値RETRY_MAX_TOKENSの
# 両方がこの係数を根拠にしている（project memory参照）。
_PER_ITEM_MAX_TOKENS_WITH_MARGIN = 39 / 0.8  # = 48.75
# Claude Haiku 4.5のmax_tokensハード上限（shared/models.md参照）。
_HAIKU_MAX_OUTPUT_TOKENS = 64000


def _batch_max_tokens(chunk_size: int) -> int:
    """Batches API本体（非同期ジョブ登録、client.messages.batches.create()）の
    1リクエスト分のmax_tokensを、そのチャンクの件数から動的に計算する。

    非同期ジョブ登録は同期待ちしないため、非ストリーミングSDKの「max_tokens>約
    16,000だとValueError」ガードの対象外（後述のRETRY_MAX_TOKENSと違う点）。
    実際の制約はHaiku 4.5のmax_tokensハード上限(64,000)だけなので、そこまで
    使い切る（project memory参照: --batch-sizeを300超に引き上げる際の設計）。"""
    return min(_HAIKU_MAX_OUTPUT_TOKENS, math.ceil(chunk_size * _PER_ITEM_MAX_TOKENS_WITH_MARGIN))


# 個別/グループリトライ（_classify_group_direct、同期の直接client.messages.create()
# 呼び出し）専用のmax_tokens。RETRY_GROUP_SIZE(=100固定、--batch-sizeとは無関係)
# に対しては十分すぎる値だが、非ストリーミングSDKがmax_tokens>約16,000で
# ValueErrorを返すため、_batch_max_tokens()とは別に、その手前に固定した値を
# 使う（project memory参照: --batch-sizeを300超に引き上げる際、Batches API
# 本体側だけmax_tokensを動的に増やせるよう分離した）。
RETRY_MAX_TOKENS = 15800


def _build_params(system_prompt: str, user_content: str, model: str, max_tokens: int) -> MessageCreateParamsNonStreaming:
    params: MessageCreateParamsNonStreaming = {
        "model": model,
        # max_tokens自体を上げてもコストは増えない＝実際に生成された分にしか
        # 課金されないため、安全マージンを出し惜しみする理由が無い（project
        # memory参照）。呼び出し元がBatches API本体か個別/グループリトライかで
        # 異なる値を渡す（_batch_max_tokens()/RETRY_MAX_TOKENS参照）。
        "max_tokens": max_tokens,
        # Batches API内の各リクエストは独立実行だが、同一ジョブ内で同じsystem promptを
        # 使い回すためcache_controlを付けておく（Anthropic Messages APIのプロンプト
        # キャッシュ機能。2026-08-29、SYSTEM_PROMPT_LEVEL3からBRAND_KNOWLEDGE全文
        # 埋め込みを撤去した後はプロンプトが最低キャッシュサイズ未満になり、キャッシュ
        # 自体がほぼ発生しなくなった可能性が高いが、cache_controlの付与自体は害が無い
        # ためそのまま残している）。
        "system": [{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
        "messages": [{"role": "user", "content": user_content}],
    }
    # temperatureは以前はhaiku指定時に付与していたが、anthropicパッケージ1.0.0で
    # Messages.create()からtemperature引数自体が削除され、グループリトライ
    # （_classify_group_direct、同期client.messages.create()を直接呼ぶ経路）が
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
    max_tokens = _batch_max_tokens(len(chunk_items))
    return Request(custom_id=custom_id, params=_build_params(SYSTEM_PROMPT_LEVEL12, user_content, model, max_tokens))


def _build_request_recheck(chunk_items: list[tuple[str, list[str] | None]], model: str, custom_id: str) -> Request:
    """chunk_itemsは_build_request_level12と同じ形式（query, 機械マッチした
    ブランド候補配列 or None）。入出力の形自体がlevel12と同一のため、
    build_level12_user_contentをそのまま再利用する（2026-08-28新設、
    ai_classify.pyのcall_claude_category_recheck参照）。"""
    queries = [q for q, _ in chunk_items]
    candidates = [c for _, c in chunk_items]
    user_content = build_level12_user_content(queries, candidates)
    max_tokens = _batch_max_tokens(len(chunk_items))
    return Request(
        custom_id=custom_id, params=_build_params(SYSTEM_PROMPT_CATEGORY_RECHECK, user_content, model, max_tokens),
    )


def _build_request_level3(
    chunk_items: list[tuple[str, str]], model: str, custom_id: str,
) -> Request:
    """chunk_itemsは(query, サブタイプ)の組。subtypeを問わずSYSTEM_PROMPT_LEVEL3
    （2026-08-29、brand_poi用/unique_poi・category用の2本を統合。classification_common.
    build_system_prompt_level3のdocstring参照）を使う。"""
    user_content = build_level3_user_content(chunk_items)
    max_tokens = _batch_max_tokens(len(chunk_items))
    return Request(custom_id=custom_id, params=_build_params(SYSTEM_PROMPT_LEVEL3, user_content, model, max_tokens))


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
    phase_label: str = "", cancel_event=None,
) -> dict:
    """1つのバッチジョブを送信し、完了までポーリングしてから結果を返す。
    戻り値は custom_id -> result.result のマッピング。

    jobs_section（"jobs_level12" or "jobs_level3"）でフェーズごとにジョブ台帳を
    分けて管理する。state[jobs_section][job_key]に既にjob_idがあれば
    （--resume-batch-job経由の再開、またはAnthropic側で既に完了済みのジョブの
    再ポーリング）ジョブ作成をスキップしてそのjob_idのポーリングから再開する。
    新規作成した場合は、結果取得前に必ずstate_pathへjob_idを書き込む。

    phase_label（2026-08-30新設）はログ出力にだけ使う（呼び出し元の
    _run_phase_batchesが渡す"レベル1/2分類"等の表示名）。GUI側の進捗バーが
    このログ行を解析してフェーズ名と進捗率(%)を出す（gui_app.pyの
    _update_progress_from_log参照）ため、ジョブ作成行・ポーリング行の両方に
    含める。省略時（空文字）はログにフェーズ名を出さないだけで動作に影響しない。

    cancel_event（threading.Event、GUI専用）がポーリング中にセットされた場合、
    classification_common.OperationCancelledを送出してポーリングを打ち切る。
    ジョブ自体はAnthropic側で動き続け、job_idは既にstate_pathへ保存済みなので、
    CLIから--resume-batch-jobで後から結果を取りに戻れる（何も無駄にしない）。"""
    prefix = f"[{phase_label}] " if phase_label else ""
    existing = state.setdefault(jobs_section, {}).get(job_key)
    if existing:
        job_id = existing["job_id"]
        print(f"{prefix}バッチジョブ再開: {job_id}（{len(requests)}リクエスト）", file=sys.stderr)
    else:
        job = client.messages.batches.create(requests=requests)
        job_id = job.id
        print(f"{prefix}バッチジョブ作成: {job_id}（{len(requests)}リクエスト）", file=sys.stderr)
        state[jobs_section][job_key] = {"job_id": job_id}
        _save_state(state_path, state)

    while True:
        raise_if_cancelled(cancel_event)
        job = _retrieve_with_retry(client, job_id)
        counts = job.request_counts
        total = counts.processing + counts.succeeded + counts.errored + counts.canceled + counts.expired
        done = total - counts.processing
        print(
            f"{prefix}status={job.processing_status} "
            f"processing={counts.processing} succeeded={counts.succeeded} "
            f"errored={counts.errored} canceled={counts.canceled} expired={counts.expired} "
            f"done={done}/{total}",
            file=sys.stderr,
        )
        if job.processing_status == "ended":
            break
        time.sleep(POLL_INTERVAL_SECONDS)

    results_by_id = {}
    for result in client.messages.batches.results(job_id):
        results_by_id[result.custom_id] = result.result
    return results_by_id


def _classify_group_direct(client: anthropic.Anthropic, system_prompt: str, user_content: str, model: str):
    """チャンクが失敗した際に、欠落した要素をRETRY_GROUP_SIZE件単位のグループに
    まとめ直し、通常の(非バッチ)Messages APIで即時に再試行する共通処理
    （2026-08-29、1件ずつの個別リトライから変更。project memory参照）。
    Batches APIをもう一度使うと数分〜のポーリング待ちが再発生するため、
    グループリトライにも同期APIを使う（ai_classify.pyの
    _retry_missing_onceと同じ考え方）。パース済みのitems配列（複数要素の
    リストの場合もある）と usage集計辞書（classification_common.
    new_usage_totals参照）の組を返す。失敗時はitemsがNone・usageは空辞書
    （呼び出し元でadd_usageすれば0加算になる）。"""
    params = _build_params(system_prompt, user_content, model, RETRY_MAX_TOKENS)
    try:
        message = client.messages.create(**params)
        content_blocks = message.content or []
        text = "".join(b.text for b in content_blocks if b.type == "text")
        text = parse_response_text(text)
        try:
            items = json.loads(text)
        except json.JSONDecodeError as e:
            # 生のLLM応答をエラーメッセージに含める（2026-08-27、ai_classify.pyの
            # _call_claude_rawと同じ修正。以前は「パースに失敗した」しか分からず
            # 原因究明ができなかった）。2026-08-28、stop_reasonも付記
            # （max_tokens切れでの途中終了か、モデルが自主的にJSON以外の文章を
            # 混ぜて壊したのかを区別できるようにする。project memory参照）。
            snippet = text if len(text) <= 500 else text[:500] + "…(以下省略)"
            raise ValueError(
                f"JSONパースに失敗（stop_reason={message.stop_reason}）: {e}\n応答内容: {snippet}"
            ) from e
        if not isinstance(items, list):
            raise ValueError(f"応答がJSON配列ではありません（実際: {items!r}）")
        # 2026-08-28、cache_creation_input_tokens/cache_read_input_tokens
        # （プロンプトキャッシュの書き込み・読み込み分）も集計に含めるようにした
        # （project memory参照）。
        usage_obj = message.usage
        usage = {
            "input_tokens": usage_obj.input_tokens or 0,
            "output_tokens": usage_obj.output_tokens or 0,
            "cache_creation_input_tokens": usage_obj.cache_creation_input_tokens or 0,
            "cache_read_input_tokens": usage_obj.cache_read_input_tokens or 0,
        }
        return items, usage
    except (anthropic.APIError, ValueError, json.JSONDecodeError, TypeError) as e:
        print(f"    警告: グループ再試行も失敗（フォールバックします）: {e}", file=sys.stderr)
        return None, {}


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
    build_group_content_fn,
    decode_fn,
    unknown_record,
    phase_label: str,
    max_workers: int,
    cancel_event=None,
) -> tuple[list, dict[str, int], int, set[int]]:
    """1フェーズ分（level1/2 または level3）のBatches APIジョブを、
    MAX_REQUESTS_PER_JOBごとに分割して実行し、各チャンクの結果をdecode_fnで
    デコードして input_items と同じ順序のrecordsリストを返す。
    戻り値は (records, usage集計辞書（classification_common.new_usage_totals
    参照。input_tokens/output_tokensに加えてcache_creation_input_tokens/
    cache_read_input_tokensも含む。2026-08-28）, 個別リトライに回った回数,
    フォールバックになったinput_items内のインデックス集合)。

    2026-08-27、ai_classify.py（同期経路）と同じインデックス方式に変更した。
    以前は「チャンクの応答配列の長さがchunk_lenと一致するか」だけを見ており、
    1件でもズレるとチャンク全体（既定30件）を1件ずつ個別に再試行していた
    （project memory参照）。今はdecode_fnがLLM応答から実質的に欠落していた
    要素のインデックスだけを返すので、その分だけ個別リトライする（チャンクの
    応答が丸ごと不正な場合のみチャンク全体を個別リトライする、という区別は
    維持）。

    decode_fn(items, chunk_input_items) -> (records, missing_local_indices)。
    itemsはLLM応答をパースした配列、chunk_input_itemsは対応するinput_items
    [start:end]（レベル1/2のブランド候補付き判定で、各要素にどの候補配列を
    渡したかをデコード側でも参照する必要があるため。レベル3では使わない）。
    recordsはchunk_input_itemsと同じ長さで、欠落していた位置はNone。
    missing_local_indicesはNoneのまま残った位置（chunk内の0始まり相対
    インデックス）の集合。

    build_group_content_fn(items) -> user_content文字列。itemsは複数件の
    リスト（2026-08-29、1件用のbuild_single_content_fnから改名・汎用化。
    グループリトライで複数件をまとめて1回のリクエストに乗せるため）。

    2026-08-29、欠落要素の同期API再試行をThreadPoolExecutorで並行実行する
    ように変更（project memory参照。実運用ログで24137件中1365件が個別リトライに
    回り、全て逐次実行だったため9時間中の大半を占めていたことが判明した）。
    さらに同日、1件ずつの個別リトライをRETRY_GROUP_SIZE件単位のグループ
    リトライに変更した（チャンク丸ごと失敗時、1件ずつだとsystem promptを
    欠落件数分＝最大batch_size件分再送する無駄が大きい。project memory参照）。
    このグループリトライでもなお欠落した要素は、それ以上の再試行はせず
    unknown_recordにフォールバックする。リトライ対象はここでは即座に実行せず
    pending_retry_indicesにキューしておき、全チャンクの一次処理（Batches API
    の結果取得・デコード）が終わった後にRETRY_GROUP_SIZE件ずつのグループに
    分けてまとめて並行実行する。同期経路のai_classify.py
    （_run_batches_concurrently）と同じく、anthropic.Anthropicクライアントは
    スレッドセーフなので複数スレッドから同時にmessages.create()を呼んでも問題
    ない。usage集計・records書き込み・failed_indices追加は、ワーカースレッドの
    戻り値をメインスレッド側のas_completedループで反映することで、共有dictへの
    並行書き込み（レース条件）を避けている。"""
    n = len(input_items)
    records: list = [unknown_record] * n
    totals = new_usage_totals()
    failed_ranges = 0
    failed_indices: set[int] = set()
    pending_retry_indices: list[int] = []

    chunks = []  # (start, end, custom_id, Request)
    for start in range(0, n, batch_size):
        end = min(start + batch_size, n)
        custom_id = f"batch-{start}"
        chunks.append((start, end, custom_id, build_request_fn(input_items[start:end], model, custom_id)))

    def queue_retry(indices: list[int], reason: str) -> None:
        nonlocal failed_ranges
        print(
            f"  警告({phase_label}): {reason}。{len(indices)}件を個別リトライ待ち行列に追加します",
            file=sys.stderr,
        )
        failed_ranges += 1
        pending_retry_indices.extend(indices)

    def retry_group(indices: list[int]):
        """indices（グローバルインデックス、最大RETRY_GROUP_SIZE件）をまとめて
        1回だけ同期APIでリトライする。ThreadPoolExecutorのワーカーから呼ばれる
        想定で、共有状態（records/totals/failed_indices）には触れず、結果を
        タプルで返すだけにする（メインスレッド側で反映してレース条件を避ける
        ため。ai_classify.pyの_retry_missing_onceと同じ設計）。戻り値は
        (indices, {グローバルインデックス: record}（欠落分は含まない）, usage)。"""
        group_items = [input_items[i] for i in indices]
        items, group_usage = _classify_group_direct(
            client, system_prompt, build_group_content_fn(group_items), model,
        )
        if items is None:
            return indices, {}, group_usage
        group_records, missing_local = decode_fn(items, group_items)
        records_by_index = {
            indices[local_i]: record
            for local_i, record in enumerate(group_records)
            if local_i not in missing_local and record is not None
        }
        return indices, records_by_index, group_usage

    for job_start in range(0, len(chunks), MAX_REQUESTS_PER_JOB):
        raise_if_cancelled(cancel_event)
        job_chunks = chunks[job_start:job_start + MAX_REQUESTS_PER_JOB]
        job_requests = [req for _, _, _, req in job_chunks]
        job_key = str(job_start)

        results_by_id = run_batch_job(
            client, job_requests, state_path, state, jobs_section, job_key,
            phase_label=phase_label, cancel_event=cancel_event,
        )

        for start, end, custom_id, _ in job_chunks:
            result = results_by_id.get(custom_id)
            chunk_range = list(range(start, end))

            if result is None:
                queue_retry(chunk_range, f"batch-{start}: 結果が見つかりません")
                continue

            if result.type != "succeeded":
                detail = ""
                if result.type == "errored":
                    detail = f": {result.error.error.type} - {result.error.error.message}"
                queue_retry(chunk_range, f"batch-{start}: {result.type}{detail}")
                continue

            message = result.message
            content_blocks = message.content or []
            text = "".join(b.text for b in content_blocks if b.type == "text")
            text = parse_response_text(text)

            try:
                items = json.loads(text)
            except json.JSONDecodeError as e:
                # 2026-08-28、stop_reasonも付記（max_tokens切れでの途中終了か、
                # モデルが自主的にJSON以外の文章を混ぜて壊したのかを区別できる
                # ようにする。project memory参照）。
                snippet = text if len(text) <= 500 else text[:500] + "…(以下省略)"
                queue_retry(
                    chunk_range,
                    f"batch-{start}: JSONパースに失敗（stop_reason={message.stop_reason}）: {e}\n応答内容: {snippet}",
                )
                continue
            if not isinstance(items, list):
                queue_retry(
                    chunk_range, f"batch-{start}: 応答がJSON配列ではありません（実際: {type(items).__name__}）",
                )
                continue

            chunk_records, missing_local = decode_fn(items, input_items[start:end])
            for i, record in enumerate(chunk_records):
                if record is not None:
                    records[start + i] = record

            # 2026-08-28、cache_creation_input_tokens/cache_read_input_tokens
            # （プロンプトキャッシュの書き込み・読み込み分）も集計に含めるように
            # した（project memory参照）。
            usage = message.usage
            add_usage(totals, {
                "input_tokens": usage.input_tokens or 0,
                "output_tokens": usage.output_tokens or 0,
                "cache_creation_input_tokens": usage.cache_creation_input_tokens or 0,
                "cache_read_input_tokens": usage.cache_read_input_tokens or 0,
            })

            if missing_local:
                missing_global = [start + i for i in sorted(missing_local)]
                queue_retry(
                    missing_global,
                    f"batch-{start}: {len(missing_local)}/{end - start}件が応答から欠落"
                    f"（stop_reason={message.stop_reason}）",
                )

    if pending_retry_indices:
        total_retry = len(pending_retry_indices)
        retry_groups = [
            pending_retry_indices[i:i + RETRY_GROUP_SIZE]
            for i in range(0, total_retry, RETRY_GROUP_SIZE)
        ]
        print(
            f"  {phase_label}: リトライ対象 {total_retry}件を{len(retry_groups)}グループ"
            f"（{RETRY_GROUP_SIZE}件単位）に分けて並行実行します（並行数={max_workers}）",
            file=sys.stderr,
        )
        done_count = 0
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(retry_group, grp): grp for grp in retry_groups}
            for future in as_completed(futures):
                indices, records_by_index, group_usage = future.result()
                add_usage(totals, group_usage)
                for i in indices:
                    record = records_by_index.get(i)
                    if record is None:
                        print(
                            f"    警告({phase_label}): グループ再試行でもこのクエリが応答から欠落しました"
                            f"（フォールバックします）: {input_items[i]!r}",
                            file=sys.stderr,
                        )
                        failed_indices.add(i)
                    else:
                        records[i] = record
                done_count += 1
                print(
                    f"  {phase_label}: グループリトライ {done_count}/{len(retry_groups)}グループ完了",
                    file=sys.stderr,
                )

    return records, totals, failed_ranges, failed_indices


def classify_unique(
    queries: list[str],
    batch_size: int,
    level12_model: str,
    level3_model: str,
    api_key: str | None = None,
    resume_state_path: str | None = None,
    max_workers: int = 8,
    cancel_event=None,
) -> tuple[dict[str, Record], dict[str, int], int, set[str]]:
    """queriesからユニークな値だけを抽出し、Batches APIで3段階に分けて分類する。
    {query文字列: (ai_classification, ai_classification_2, ai_classification_3)} の辞書・
    usage集計辞書（全フェーズ合算。classification_common.new_usage_totals参照。
    input_tokens/output_tokensに加えてcache_creation_input_tokens/cache_read_
    input_tokensも含む。2026-08-28、プロンプトキャッシュのコストが可視化されて
    いなかった問題への対応。project memory参照）・失敗レンジ数（個別リトライに
    回った回数の合計）・個別リトライでも失敗しfallbackになったquery集合を
    返す。ai_classify.classify_unique（同期API版）と同じ3段階設計（モジュール
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
    含めている）。

    max_workers は、Batches APIの結果に対する個別リトライ（要素欠落・チャンク
    全体不正時のフォールバック）をThreadPoolExecutorで並行実行する際の並行数
    （2026-08-29新設。project memory参照）。Batches APIジョブ自体の処理は
    Anthropic側で並行実行されるため対象外で、あくまで同期APIでの個別リトライ
    にのみ効く。

    cancel_event（threading.Event、GUI専用。CLI実行時は常にNone）がセットされて
    いる場合、ジョブのポーリング中・各フェーズの境目でclassification_common.
    OperationCancelledを送出して中断する。ジョブ自体はAnthropic側で動き続けるため、
    state_pathに保存済みのjob_idを使って後から--resume-batch-jobで再開できる。"""
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
                "--resume-batch-job: 状態ファイルの内容が今回の入力（クエリ内容/--batch-size/"
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
            "jobs_recheck": {},
            "jobs_level3_recheck": {},
        }
        _save_state(state_path, state)

    level12_input = list(zip(unique_queries, candidates_per_query))

    triples, level12_totals, failed_ranges, failed_idx12 = _run_phase_batches(
        client, level12_input, batch_size, level12_model, state, state_path, "jobs_level12",
        SYSTEM_PROMPT_LEVEL12,
        _build_request_level12,
        lambda items: build_level12_user_content([it[0] for it in items], [it[1] for it in items]),
        lambda items, chunk: decode_indexed_level12_responses(items, [c for _, c in chunk]),
        ("unknown", "", None),
        "レベル1/2分類",
        max_workers,
        cancel_event=cancel_event,
    )
    usage_totals = new_usage_totals()
    add_usage(usage_totals, level12_totals)
    failed_queries: set[str] = {unique_queries[i] for i in failed_idx12}

    raise_if_cancelled(cancel_event)

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

    def run_level3_group(
        indices: list[int], jobs_section: str, group_label: str,
    ) -> tuple[dict[int, str], dict[str, int], int, set[str]]:
        if not indices:
            return {}, new_usage_totals(), 0, set()
        items = [(unique_queries[i], triples[i][1]) for i in indices]

        leaves, totals, failed_ranges_g, failed_local = _run_phase_batches(
            client, items, batch_size, level3_model, state, state_path, jobs_section,
            SYSTEM_PROMPT_LEVEL3,
            _build_request_level3,
            build_level3_user_content,
            lambda resp_items, chunk: decode_indexed_leaf_responses(resp_items, len(chunk)),
            "unknown",
            group_label,
            max_workers,
            cancel_event=cancel_event,
        )
        leaf_map = {global_i: leaves[local_i] for local_i, global_i in enumerate(indices)}
        failed = {items[local_i][0] for local_i in failed_local}
        return leaf_map, totals, failed_ranges_g, failed

    # 2026-08-29、subtypeでbrand_poi/unique_poi・categoryの2グループに分けて別々の
    # ジョブに送っていたのを統合した（SYSTEM_PROMPT_LEVEL3のdocstring参照。
    # BRAND_KNOWLEDGE埋め込みを撤去したことで両者のプロンプトが同一になったため）。
    level3_leaf_map, level3_totals, fr_level3, failed_level3 = run_level3_group(
        poi_indices_needing_llm, "jobs_level3", "レベル3分類(taxonomy)",
    )
    leaf_by_index.update(level3_leaf_map)
    add_usage(usage_totals, level3_totals)
    failed_ranges += fr_level3
    failed_queries |= failed_level3

    raise_if_cancelled(cancel_event)

    # フェーズ3: "category"×taxonomy unknownの再判定（2026-08-28新設、ai_classify.py
    # と同じ設計。classification_common.build_system_prompt_category_recheckの
    # docstring・project memory参照）。"category"は定義上「実在する業種を表す
    # 一般名詞」なので、正しく判定できていればtaxonomyのどれかに当てはまるのが
    # 本来の姿。taxonomyがどれにも一致しなかった（leaf_by_index[i] == "unknown"）
    # という事実は、level2の"category"判定自体が誤りだった可能性を示すシグナル
    # として扱う。unique_poi/brand_poi側のtaxonomy unknownは「実在する施設・
    # ブランドだがtaxonomyがカバーしていない」正当なケースがあり得るため対象外。
    recheck_indices = [
        i for i in poi_indices
        if triples[i][1] == "category" and leaf_by_index.get(i) == "unknown"
    ]

    broken_indices: set[int] = set()
    if recheck_indices:
        recheck_items = [(unique_queries[i], candidates_per_query[i]) for i in recheck_indices]

        # 失敗時のフォールバックは("category", None)＝据え置き（何も破壊しない）。
        recheck_records, recheck_totals, fr_re, failed_re = _run_phase_batches(
            client, recheck_items, batch_size, level12_model, state, state_path, "jobs_recheck",
            SYSTEM_PROMPT_CATEGORY_RECHECK,
            _build_request_recheck,
            lambda items: build_level12_user_content([it[0] for it in items], [it[1] for it in items]),
            lambda items, chunk: decode_indexed_recheck_responses(items, [c for _, c in chunk]),
            ("category", None),
            "カテゴリ再判定",
            max_workers,
            cancel_event=cancel_event,
        )
        add_usage(usage_totals, recheck_totals)
        failed_ranges += fr_re
        failed_queries |= {recheck_items[i][0] for i in failed_re}

        promote_unique: list[int] = []
        promote_brand: list[int] = []
        for local_i, global_i in enumerate(recheck_indices):
            choice, matched_brand = recheck_records[local_i]
            if choice == "broken":
                broken_indices.add(global_i)
            elif choice == "unique_poi":
                triples[global_i] = (triples[global_i][0], "unique_poi", matched_brand)
                promote_unique.append(global_i)
            elif choice == "brand_poi":
                triples[global_i] = (triples[global_i][0], "brand_poi", matched_brand)
                promote_brand.append(global_i)
            # choice == "category": 据え置き（leaf_by_indexも"unknown"のまま）

        # unique_poi/brand_poiに訂正された行は、訂正後のsubtypeでtaxonomyを
        # 再度判定し直す（brand_poiは通常のlevel3と同様、まずBRAND_CATEGORY_MAPの
        # 辞書ショートカットを試してからLLM判定に回す）。
        promote_needing_llm: list[int] = list(promote_unique)
        for i in promote_brand:
            shortcut_leaf = leaves_for_matched_brand(triples[i][2], "brand_poi")
            if shortcut_leaf is not None:
                leaf_by_index[i] = shortcut_leaf
            else:
                promote_needing_llm.append(i)

        promote_leaf_map, promote_totals, fr_promote, failed_promote = run_level3_group(
            promote_needing_llm, "jobs_level3_recheck", "レベル3再分類(taxonomy、再判定後)",
        )
        leaf_by_index.update(promote_leaf_map)
        add_usage(usage_totals, promote_totals)
        failed_ranges += fr_promote
        failed_queries |= failed_promote

    records: list[Record] = []
    for i, (c1, c2, matched) in enumerate(triples):
        if i in broken_indices:
            records.append(("unknown", "", "", ""))
            continue
        c3 = leaf_by_index.get(i, "") if c2 in POI_SUBTYPE_VALUES else ""
        # brand_poiの場合のみブランド名を出力する（matched_brandはunique_poiに
        # 訂正された行にも残っている場合があるが、それは「候補と一致した」という
        # 選定過程の副産物に過ぎず、そのクエリ自体をブランドとして扱う意味では
        # ないため対象外。leaves_for_matched_brandの判定基準と揃える。2026-08-29
        # 新設、project memory参照）。
        brand = matched if c2 == "brand_poi" and matched else ""
        records.append((c1, c2, c3, brand))

    # 全フェーズの結果を取り込めたので、再開用の状態ファイルはもう不要。
    try:
        os.remove(state_path)
    except OSError:
        pass

    mapping = dict(zip(unique_queries, records))
    return mapping, usage_totals, failed_ranges, failed_queries
