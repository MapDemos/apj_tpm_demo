"""
main.py ai-classify / ai-retry サブコマンドが使う分類ロジック（旧 classify_queries.py）。

LLM（本物のAnthropic API、要ANTHROPIC_API_KEYまたは--token）を使って query 配列を
分類する。バッチ分割＋並行処理版。LLM応答から一部の要素だけが欠落した場合は
その分だけ個別に再試行し、応答全体が不正（JSON配列ですらない等）だった場合のみ
バッチ全体を1件ずつ個別に再試行する。それでも失敗した行だけを unknown に
フォールバックする（2026-08-27、入出力の各要素にインデックスを付与する方式に
変更し、要素数ズレ時にバッチ全体を個別リトライしていた無駄を解消した。
classification_common.pyのモジュールdocstring参照）。

2026-08-27、プロキシ（Lambda URL）経由の呼び出しを廃止し、本物のAnthropic API
（anthropicパッケージ）を直接叩く同期呼び出しに変更した
（ai_analyze.pyのgenerate_commentaryが2026-08-25に同じ移行を済ませており、
そちらと同じ方式）。anthropicパッケージ未インストールの環境ではImportErrorを
送出する（main.pyのensure_anthropic_venv_and_reexec()がai-classify実行時に
常にvenvへの自動インストールを行う）。
--batch-api（ai_classify_batch.py、Anthropic Message Batches API）と違い、
こちらは即時レスポンスを返す同期APIのみを使うため、ジョブ作成・ポーリング待ちが
発生しない代わりに、Batches APIの50%割引は適用されない。

送信するのは query の値のみ（他の列はLLMに渡さない）。
分類カテゴリの定義（ai_classification/_2/_3の3階層）は classification_common.py を参照。

2026-08-26、2段階分離方式に変更: ai_classification/_2とai_classification_3を別々の
モデルで判定できるようにした（呼び出し元がclassify_unique()にlevel12_model/
level3_modelを個別に渡す。main.pyの--modelはclassification_common.MODEL_PRESETSで
プリセット化しており、既定の"haiku+sonnet"はai_classification/_2をHaiku、
ai_classification_3をSonnetで判定する）。実測でHaikuのai_classification_3の
unknown率がunique_poi/categoryで5割超に達していた（taxonomy 285リーフからの正確な
選択・BRAND_KNOWLEDGE無しでの業種推測はHaikuには荷が重い）一方、ai_classification/_2
自体の精度は十分だったため、安いHaikuで済む部分と精度が必要な部分を分けてコストと
精度を両立できるようにしている。
"""

import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

from lib import brand_match
from lib.classification_common import (
    MODEL,
    POI_SUBTYPE_VALUES,
    SYSTEM_PROMPT_LEVEL12,
    SYSTEM_PROMPT_LEVEL3_BRAND,
    SYSTEM_PROMPT_LEVEL3_LIGHT,
    build_level12_user_content,
    build_level3_user_content,
    decode_indexed_leaf_responses,
    decode_indexed_level12_responses,
    leaves_for_matched_brand,
    parse_response_text,
)

Record = tuple[str, str, str]  # (ai_classification, ai_classification_2, ai_classification_3)
# ai_classification_3は複数リーフを持てる場合、classification_common.LEAF_DELIMITER
# ("|") で連結した1文字列として入る（classification_common.encode_leaves参照）。
UNKNOWN_RECORD: Record = ("unknown", "", "")


def _call_claude_raw(client, system_prompt: str, user_content: str, model: str) -> tuple[list, dict]:
    """本物のAnthropic APIに同期リクエストを送り、パース済みのJSON配列(items)と
    usageを返す。system_promptだけがcall_claude_level12/level3で異なり、リクエスト
    送信・レスポンスのコードフェンス除去・JSONパースは共通なのでここに集約する。
    clientはclassify_unique()で1回だけ作って使い回す（anthropicのクライアントは
    スレッドセーフなので、ThreadPoolExecutorの並行呼び出しでも問題ない。
    ai_classify_batch.pyのclassify_unique()と同じ流儀）。"""
    params: dict = {
        "model": model,
        "max_tokens": 4096,
        # system promptはBRAND_KNOWLEDGE(1500件超)を含む場合サイズが大きい。
        # 同一プロンプトをバッチごとに送り直すため、cache_controlでプロンプト
        # キャッシュを有効にし、2回目以降のリクエストのinput tokenコストを抑える
        # （Anthropic Messages APIのプロンプトキャッシュ機能）。
        "system": [{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
        "messages": [{"role": "user", "content": user_content}],
    }
    # temperatureは以前はhaiku指定時に付与していたが、anthropicパッケージ1.0.0で
    # Messages.create()からtemperature引数自体が削除される破壊的変更があり
    # （2026-08-27発覚、ai_classify_batch.py参照）、以来一切付与しない方針にした。
    if "haiku" not in model:
        # Sonnet 5はthinkingを省略すると（Sonnet 4.6以前と違い）自動的にadaptive
        # thinkingがONになり、max_tokensがthinking＋本文の合計消費になってしまう。
        # 分類タスクではthinkingは不要かつ有害（本文が出力される前にmax_tokensを
        # 使い切りJSONが不完全になる）ため明示的に無効化する
        # （search_ai_compareのAI診断機能で見つかった"thinking暴走"と同種のバグ）。
        params["thinking"] = {"type": "disabled"}

    message = client.messages.create(**params)
    content_blocks = message.content or []
    text = "".join(b.text for b in content_blocks if b.type == "text")
    text = parse_response_text(text)
    try:
        items = json.loads(text)
    except json.JSONDecodeError as e:
        # 生のLLM応答をエラーメッセージに含める。以前はここで握りつぶされ、
        # 「パースに失敗した」ということしか分からず原因究明ができなかった
        # （応答の途中がmax_tokensで切れたのか、説明文が混ざったのか等）。
        snippet = text if len(text) <= 500 else text[:500] + "…(以下省略)"
        raise ValueError(f"LLM応答をJSONとしてパースできません: {e}\n応答内容: {snippet}") from e
    usage = {"input_tokens": message.usage.input_tokens or 0, "output_tokens": message.usage.output_tokens or 0}
    return items, usage


def call_claude_level12(
    client, items: list[tuple[str, list[str] | None]], model: str,
) -> tuple[list[tuple[str, str, str | None] | None], dict]:
    """ai_classification/_2に加えて、機械的に検出したブランド候補のうちどれが
    一致したかを判定する。itemsは(query, brand_match.find_candidatesで検出した
    候補配列 or None)の組（BRAND_CANDIDATE_GUIDANCE参照）。SYSTEM_PROMPT_LEVEL12は
    taxonomy(285リーフ)・BRAND_KNOWLEDGE(1500件超)を含まない軽量版のため、
    フルプロンプト比で1/10程度のサイズに収まる（機械マッチで絞った少数の候補だけは
    別途この呼び出しに乗せる）。

    戻り値のレコードリストは、LLM応答から実質的に欠落していた（インデックスが
    見つからなかった）位置にNoneが入る（2026-08-27、要素数ズレ対策のインデックス
    方式に変更。以前は要素数が1件でも合わないとバッチ全体を例外にしていたが、
    今は個々の欠落だけをNoneとして返し、呼び出し元(_run_batches_concurrently)が
    その位置だけ個別リトライする）。応答自体がJSON配列ですらない場合のみ、
    ここで例外にしてバッチ全体を個別リトライに回す。"""
    queries = [q for q, _ in items]
    candidates = [c for _, c in items]
    user_content = build_level12_user_content(queries, candidates)
    raw_items, usage = _call_claude_raw(client, SYSTEM_PROMPT_LEVEL12, user_content, model)
    if not isinstance(raw_items, list):
        raise ValueError(f"LLM応答がJSON配列ではありません（実際: {type(raw_items).__name__}）")
    records, _missing = decode_indexed_level12_responses(raw_items, candidates)
    return records, usage


def call_claude_level3(
    client, items: list[tuple[str, str]], model: str, system_prompt: str,
) -> tuple[list[str | None], dict]:
    """ai_classification_3（taxonomyリーフ）のみを判定する。itemsは[(query, サブタイプ), ...]
    で、サブタイプ（unique_poi/brand_poi/category）は呼び出し元で確定済みの前提。
    system_promptはSYSTEM_PROMPT_LEVEL3_BRAND（BRAND_KNOWLEDGE込み、brand_poi用）と
    SYSTEM_PROMPT_LEVEL3_LIGHT（unique_poi/category用）のどちらかを呼び出し元
    (classify_unique)が選んで渡す。

    戻り値の欠落時の扱いはcall_claude_level12と同じ（Noneで返し、部分的な
    個別リトライに委ねる）。"""
    user_content = build_level3_user_content(items)
    raw_items, usage = _call_claude_raw(client, system_prompt, user_content, model)
    if not isinstance(raw_items, list):
        raise ValueError(f"LLM応答がJSON配列ではありません（実際: {type(raw_items).__name__}）")
    leaves, _missing = decode_indexed_leaf_responses(raw_items, len(items))
    return leaves, usage


def _run_batches_concurrently(items, batch_size, max_workers, call_fn, unknown_value, label):
    """itemsをbatch_size件ずつに分けて並行処理する汎用ヘルパー。call_fn(batch)は
    (records, usage)を返す関数（call_claude_level12/level3どちらにも対応できるよう
    itemsの中身は問わない）。recordsはbatchと同じ長さで、LLM応答から実質的に
    欠落していた要素はNoneになっている想定（call_claude_level12/level3の
    インデックス方式デコード参照）。

    2026-08-27、バッチが応答全体として失敗（JSON配列ですらない等）した場合と、
    一部の要素だけが欠落した場合を区別するようにした。前者は従来通りbatch全体を
    1件ずつ個別リトライするが、後者は欠落した要素だけを個別リトライする
    （以前はcall_fnが要素数不一致を例外にしていたため、1件でもズレるとバッチ
    全体（既定30件）を無条件で個別リトライしており無駄が大きかった）。
    個別リトライでも欠落したままの要素だけunknown_valueにフォールバックする。
    戻り値は (元の順序のrecordsリスト, input tokens合計, output tokens合計,
    フォールバックになったitemsのインデックス集合)。labelはログ出力用の見出し。"""
    import anthropic

    n = len(items)
    batches = []
    for start in range(0, n, batch_size):
        end = min(start + batch_size, n)
        batches.append((start, end, items[start:end]))

    def classify_single_safe(item):
        try:
            records, usage = call_fn([item])
            record = records[0]
            if record is None:
                raise ValueError("個別リトライでもこのクエリが応答から欠落しました")
            return record, usage, False
        except (anthropic.APIError, ValueError, json.JSONDecodeError, TypeError) as e:
            print(f"    警告({label}): 個別再試行も失敗（フォールバックします）: {item!r}: {e}", file=sys.stderr)
            return unknown_value, {}, True

    def classify_batch_safe(batch, start, end):
        try:
            records, usage = call_fn(batch)
        except (anthropic.APIError, ValueError, json.JSONDecodeError, TypeError) as e:
            print(
                f"  警告({label}): バッチ {start + 1}〜{end} の分類に失敗（応答全体が不正）。"
                f"{len(batch)}件を1件ずつ個別に再試行します: {e}",
                file=sys.stderr,
            )
            records = [None] * len(batch)
            usage = {"input_tokens": 0, "output_tokens": 0}

        missing_local = [i for i, r in enumerate(records) if r is None]
        if missing_local:
            missing_display = [start + i + 1 for i in missing_local]
            print(
                f"  警告({label}): バッチ {start + 1}〜{end} 中 {len(missing_local)}/{len(batch)}件が"
                f"LLM応答から欠落（{missing_display}件目）。欠落分だけ個別に再試行します。",
                file=sys.stderr,
            )

        failed_indices: set[int] = set()
        for i in missing_local:
            record, single_usage, is_failed = classify_single_safe(batch[i])
            records[i] = record
            usage["input_tokens"] = (usage.get("input_tokens", 0) or 0) + (single_usage.get("input_tokens", 0) or 0)
            usage["output_tokens"] = (usage.get("output_tokens", 0) or 0) + (single_usage.get("output_tokens", 0) or 0)
            if is_failed:
                failed_indices.add(start + i)
        return start, records, usage, failed_indices

    results: dict[int, list] = {}
    total_in = 0
    total_out = 0
    done_count = 0
    failed_indices: set[int] = set()

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(classify_batch_safe, batch, start, end): (start, end)
            for start, end, batch in batches
        }
        for future in as_completed(futures):
            start, records, usage, batch_failed = future.result()
            results[start] = records
            total_in += usage.get("input_tokens", 0) or 0
            total_out += usage.get("output_tokens", 0) or 0
            failed_indices.update(batch_failed)
            done_count += 1
            print(
                f"{label}中... {done_count}/{len(batches)} バッチ完了 "
                f"(累計 in={total_in} out={total_out})",
                file=sys.stderr,
            )

    records = []
    for start, end, _ in batches:
        records.extend(results[start])

    return records, total_in, total_out, failed_indices


def classify_unique(
    queries: list[str],
    batch_size: int,
    max_workers: int,
    level12_model: str = MODEL,
    level3_model: str = MODEL,
    api_key: str | None = None,
) -> tuple[dict[str, Record], int, int, set[str]]:
    """queriesからユニークな値だけを抽出し、2段階でLLMに分類させる。
    {query文字列: (ai_classification, ai_classification_2, ai_classification_3)} の辞書・
    input/outputトークン合計（フェーズ1・2の合算）・分類に失敗しfallbackの
    unknownになったquery集合を返す。同じqueryが何度出現しても分類は1回で済ませることで、
    API呼び出し回数を削減するとともに、同一クエリが別バッチに分かれて別々の判定結果に
    なる不整合を防ぐ。

    フェーズ1（level12_model）: ai_classification/_2を軽量プロンプトで判定する。
    フェーズ2（level3_model）: フェーズ1でunique_poi/brand_poi/categoryと判定された
    行だけを対象に、ai_classification_3（taxonomyリーフ）を判定する。それ以外
    （address/semantic_query/unknown）の行はこのフェーズをスキップするため、level3_model
    への送信対象は全体の一部に絞られる（詳細はモジュールdocstring参照）。
    level12_model/level3_modelに同じモデルを渡しても動作する（main.pyのMODEL_PRESETS
    "haiku"/"sonnet"のように、比較検証目的で両階層を同一モデルに統一したい場合）。

    api_key を渡すと ANTHROPIC_API_KEY 環境変数の代わりにそれを使う。"""
    import anthropic

    unique_queries = list(dict.fromkeys(queries))
    client = anthropic.Anthropic(api_key=api_key) if api_key else anthropic.Anthropic()

    # brand_match: クエリごとに機械的な部分一致（表記体系をまたぐ）で検出した
    # ブランド名候補を求め、候補があるクエリだけレベル1/2の入力に添える
    # （BRAND_CANDIDATE_GUIDANCE参照。候補が無いクエリは今まで通り文字列単体で
    # 送るため挙動は変わらない。ai_classify_batch.pyのclassify_unique()と同じ設計）。
    brand_idx = brand_match.build_index()
    candidates_per_query: list[list[str] | None] = [
        sorted(brand_match.find_candidates(q, brand_idx)) or None for q in unique_queries
    ]
    level12_input = list(zip(unique_queries, candidates_per_query))

    def call_level12(batch: list[tuple[str, list[str] | None]]):
        return call_claude_level12(client, batch, level12_model)

    triples, total_in, total_out, failed_idx1 = _run_batches_concurrently(
        level12_input, batch_size, max_workers, call_level12, ("unknown", "", None), "レベル1/2分類",
    )
    failed_queries: set[str] = {unique_queries[i] for i in failed_idx1}

    poi_indices = [i for i, (_, sub, _matched) in enumerate(triples) if sub in POI_SUBTYPE_VALUES]
    leaf_by_index: dict[int, str] = {}

    # ④: ブランド候補の中からLLMが確定させたブランドで、かつBRAND_CATEGORY_MAPに
    # taxonomyリーフの参照データがある場合は、レベル3のLLM判定を省略して辞書から
    # 直接採用する（ai_classify_batch.pyのclassify_unique()と同じ設計。project
    # memory参照）。
    poi_indices_needing_llm = []
    for i in poi_indices:
        _c1, c2, matched_brand = triples[i]
        shortcut_leaf = leaves_for_matched_brand(matched_brand, c2)
        if shortcut_leaf is not None:
            leaf_by_index[i] = shortcut_leaf
        else:
            poi_indices_needing_llm.append(i)

    # レベル3対象をsubtypeで2グループに分けて送る（2026-08-27）。BRAND_KNOWLEDGE
    # （1500件超のブランド辞書）が実際に役立つのはbrand_poiだけで、unique_poi/
    # categoryには無関係。以前はsubtypeを問わず同じバッチに混ぜて送っていたため、
    # unique_poi/categoryだけのバッチにも無条件でBRAND_KNOWLEDGE込みの重量プロンプト
    # が使われていた（build_system_prompt_level3のdocstring参照）。
    brand_indices = [i for i in poi_indices_needing_llm if triples[i][1] == "brand_poi"]
    light_indices = [i for i in poi_indices_needing_llm if triples[i][1] != "brand_poi"]

    def run_level3_group(
        indices: list[int], system_prompt: str, group_label: str,
    ) -> tuple[dict[int, str], int, int, set[str]]:
        if not indices:
            return {}, 0, 0, set()
        items = [(unique_queries[i], triples[i][1]) for i in indices]

        def call_level3(batch: list[tuple[str, str]]):
            return call_claude_level3(client, batch, level3_model, system_prompt)

        leaves, in_tok, out_tok, failed_local = _run_batches_concurrently(
            items, batch_size, max_workers, call_level3, "unknown", group_label,
        )
        leaf_map = {global_i: leaves[local_i] for local_i, global_i in enumerate(indices)}
        failed = {items[local_i][0] for local_i in failed_local}
        return leaf_map, in_tok, out_tok, failed

    brand_leaf_map, in_brand, out_brand, failed_brand = run_level3_group(
        brand_indices, SYSTEM_PROMPT_LEVEL3_BRAND, "レベル3分類(taxonomy/brand_poi)",
    )
    light_leaf_map, in_light, out_light, failed_light = run_level3_group(
        light_indices, SYSTEM_PROMPT_LEVEL3_LIGHT, "レベル3分類(taxonomy/unique_poi・category)",
    )
    leaf_by_index.update(brand_leaf_map)
    leaf_by_index.update(light_leaf_map)
    total_in += in_brand + in_light
    total_out += out_brand + out_light
    failed_queries |= failed_brand | failed_light

    records: list[Record] = []
    for i, (c1, c2, _matched) in enumerate(triples):
        c3 = leaf_by_index.get(i, "") if c2 in POI_SUBTYPE_VALUES else ""
        records.append((c1, c2, c3))

    mapping = dict(zip(unique_queries, records))
    return mapping, total_in, total_out, failed_queries
