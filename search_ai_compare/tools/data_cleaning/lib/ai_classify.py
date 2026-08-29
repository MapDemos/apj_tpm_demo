"""
main.py ai-classify / ai-retry サブコマンドが使う分類ロジック（旧 classify_queries.py）。

LLM（本物のAnthropic API、要ANTHROPIC_API_KEYまたは--token）を使って query 配列を
分類する。バッチ分割＋並行処理版。LLM応答から一部の要素だけが欠落した場合や
応答全体が不正（JSON配列ですらない等）だった場合は、欠落分をRETRY_GROUP_SIZE
件単位のグループにまとめ直して1回だけ再試行する。それでも失敗した行だけを
unknown にフォールバックする（2026-08-27、入出力の各要素にインデックスを
付与する方式に変更し、要素数ズレ時にバッチ全体を個別リトライしていた無駄を
解消。2026-08-29、その個別リトライ自体もRETRY_GROUP_SIZE件単位のグループ
リトライに変更——チャンク丸ごと失敗時、1件ずつだとsystem promptを欠落件数分
再送する無駄が大きいため。classification_common.pyのモジュールdocstring・
project memory参照）。

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

2026-08-26、ai_classification/_2とai_classification_3を別フェーズ・別プロンプトで
判定する2段階構成に変更した（呼び出し元がclassify_unique()にlevel12_model/
level3_modelを個別に渡す設計は残しているが、2026-08-27以降どちらも
classification_common.CLASSIFY_MODEL（Haiku）で統一している。当初はtaxonomy
285リーフからの正確な選択・BRAND_KNOWLEDGE無しでの業種推測がHaikuには荷が重く、
ai_classification_3のunknown率がunique_poi/categoryで5割超に達していたためSonnetに
分離していたが、taxonomyの45件フラット化とbrand_match.pyによる機械的ブランド候補
注入によりHaiku単体でも精度十分と確認できたため、Sonnetへの分離は廃止した）。

2026-08-28、"category"×taxonomy unknown（ai_classification_2="category"かつ
ai_classification_3="unknown"）の組み合わせだけを対象にした3つ目のフェーズを
追加した（classification_common.build_system_prompt_category_recheckの
docstring・project memory参照）。level2判定自体を疑うシグナルとして扱い、
category（据え置き）/unique_poi/brand_poi/broken（表記破綻＝ai_classification
自体をunknownへ）の4択で再判定する。unique_poi/brand_poiに訂正された行は
訂正後のsubtypeでtaxonomyも再判定する。
"""

import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

from lib import brand_match
from lib.classification_common import (
    CLASSIFY_MODEL,
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

Record = tuple[str, str, str, str]  # (ai_classification, ai_classification_2, ai_classification_3, brand)
# ai_classification_3は複数リーフを持てる場合、classification_common.LEAF_DELIMITER
# ("|") で連結した1文字列として入る（classification_common.encode_leaves参照）。
UNKNOWN_RECORD: Record = ("unknown", "", "", "")

# 2026-08-29、チャンク失敗時の欠落要素リトライを1件ずつの個別呼び出しから
# このサイズ単位のグループ呼び出しに変更した際の単位（ai_classify_batch.pyと
# 同じ値・同じ根拠。project memory参照）。
RETRY_GROUP_SIZE = 100


def _call_claude_raw(client, system_prompt: str, user_content: str, model: str) -> tuple[list, dict]:
    """本物のAnthropic APIに同期リクエストを送り、パース済みのJSON配列(items)と
    usageを返す。system_promptだけがcall_claude_level12/level3で異なり、リクエスト
    送信・レスポンスのコードフェンス除去・JSONパースは共通なのでここに集約する。
    clientはclassify_unique()で1回だけ作って使い回す（anthropicのクライアントは
    スレッドセーフなので、ThreadPoolExecutorの並行呼び出しでも問題ない。
    ai_classify_batch.pyのclassify_unique()と同じ流儀）。"""
    params: dict = {
        "model": model,
        # 2026-08-29、--batch-sizeを90→300に引き上げるのに合わせて4096→15800に変更
        # （ai_classify_batch.pyの_build_paramsと同じ根拠。project memory参照）。
        "max_tokens": 15800,
        # 同一プロンプトをバッチごとに送り直すため、cache_controlでプロンプト
        # キャッシュを有効にし、2回目以降のリクエストのinput tokenコストを抑える
        # （Anthropic Messages APIのプロンプトキャッシュ機能。2026-08-29、
        # SYSTEM_PROMPT_LEVEL3からBRAND_KNOWLEDGE全文埋め込みを撤去した後は
        # プロンプトが最低キャッシュサイズ未満になり、キャッシュ自体がほぼ
        # 発生しなくなった可能性が高いが、cache_controlの付与自体は害が無いため
        # そのまま残している）。
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
        # 2026-08-28、stop_reasonも付記するようにした（max_tokens切れによる
        # 途中終了なのか、モデルが自主的にJSON以外の文章を混ぜて壊したのかを
        # 区別できるようにするため。project memory参照）。
        snippet = text if len(text) <= 500 else text[:500] + "…(以下省略)"
        raise ValueError(
            f"LLM応答をJSONとしてパースできません（stop_reason={message.stop_reason}）: {e}\n応答内容: {snippet}"
        ) from e
    # 2026-08-28、cache_creation_input_tokens/cache_read_input_tokens（プロンプト
    # キャッシュの書き込み・読み込み分）とstop_reasonも集計に含めるようにした。
    # 従来はinput_tokens/output_tokensしか見ておらず、system promptに付けている
    # cache_control分のコストが一切可視化されていなかった（project memory参照）。
    usage = {
        "input_tokens": message.usage.input_tokens or 0,
        "output_tokens": message.usage.output_tokens or 0,
        "cache_creation_input_tokens": message.usage.cache_creation_input_tokens or 0,
        "cache_read_input_tokens": message.usage.cache_read_input_tokens or 0,
        "stop_reason": message.stop_reason,
    }
    return items, usage


def call_claude_level12(
    client, items: list[tuple[str, list[str] | None]], model: str,
) -> tuple[list[tuple[str, str, str | None] | None], dict]:
    """ai_classification/_2に加えて、機械的に検出したブランド候補のうちどれが
    一致したかを判定する。itemsは(query, brand_match.find_candidatesで検出した
    候補配列 or None)の組（BRAND_CANDIDATE_GUIDANCE参照）。SYSTEM_PROMPT_LEVEL12は
    CATEGORY_TAXONOMYの全カテゴリ一覧を含まない軽量版のため、SYSTEM_PROMPT_LEVEL3比で
    サイズが小さい（機械マッチで絞った少数の候補だけは別途この呼び出しに乗せる）。

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
    system_promptは呼び出し元(classify_unique)がSYSTEM_PROMPT_LEVEL3を渡す
    （2026-08-29、subtype別に分かれていたプロンプトを統合。classification_common.
    build_system_prompt_level3のdocstring参照）。

    戻り値の欠落時の扱いはcall_claude_level12と同じ（Noneで返し、部分的な
    個別リトライに委ねる）。"""
    user_content = build_level3_user_content(items)
    raw_items, usage = _call_claude_raw(client, system_prompt, user_content, model)
    if not isinstance(raw_items, list):
        raise ValueError(f"LLM応答がJSON配列ではありません（実際: {type(raw_items).__name__}）")
    leaves, _missing = decode_indexed_leaf_responses(raw_items, len(items))
    return leaves, usage


def call_claude_category_recheck(
    client, items: list[tuple[str, list[str] | None]], model: str,
) -> tuple[list[tuple[str, str | None] | None], dict]:
    """ai_classification_2="category"かつai_classification_3="unknown"（taxonomyの
    どのリーフにも一致しなかった）と判定された行だけを対象に、その判定自体が
    正しかったかを再確認する（2026-08-28新設。classification_common.
    build_system_prompt_category_recheckのdocstring・project memory参照）。
    itemsはcall_claude_level12と同じ形式（query, 機械マッチしたブランド候補配列
    or None）を流用する（入出力の形自体がlevel12と同一のため、
    build_level12_user_contentをそのまま再利用している）。

    戻り値のレコードは(choice, matched_brand)のタプルで、choiceは
    "category"/"unique_poi"/"brand_poi"/"broken"のいずれか。LLM応答から実質的に
    欠落していた位置はNone（call_claude_level12と同じ欠落時の扱い）。"""
    queries = [q for q, _ in items]
    candidates = [c for _, c in items]
    user_content = build_level12_user_content(queries, candidates)
    raw_items, usage = _call_claude_raw(client, SYSTEM_PROMPT_CATEGORY_RECHECK, user_content, model)
    if not isinstance(raw_items, list):
        raise ValueError(f"LLM応答がJSON配列ではありません（実際: {type(raw_items).__name__}）")
    records, _missing = decode_indexed_recheck_responses(raw_items, candidates)
    return records, usage


def _run_batches_concurrently(items, batch_size, max_workers, call_fn, unknown_value, label):
    """itemsをbatch_size件ずつに分けて並行処理する汎用ヘルパー。call_fn(batch)は
    (records, usage)を返す関数（call_claude_level12/level3どちらにも対応できるよう
    itemsの中身は問わない）。recordsはbatchと同じ長さで、LLM応答から実質的に
    欠落していた要素はNoneになっている想定（call_claude_level12/level3の
    インデックス方式デコード参照）。

    2026-08-27、バッチが応答全体として失敗（JSON配列ですらない等）した場合と、
    一部の要素だけが欠落した場合を区別するようにした（以前はcall_fnが要素数
    不一致を例外にしていたため、1件でもズレるとバッチ全体（既定30件）を
    無条件で個別リトライしており無駄が大きかった）。2026-08-29、欠落した要素の
    再試行を、1件ずつの個別呼び出しからRETRY_GROUP_SIZE件単位のグループ呼び出し
    に変更した（チャンク丸ごと失敗時、1件ずつだとsystem promptを欠落件数分＝
    最大batch_size件分再送する無駄が大きいため。project memory参照）。この
    グループリトライでもなお欠落したままの要素だけunknown_valueにフォールバック
    する。戻り値は (元の順序のrecordsリスト, usage集計辞書（classification_common.
    new_usage_totals参照。input_tokens/output_tokensに加えてcache_creation_
    input_tokens/cache_read_input_tokensも含む。2026-08-28）, フォールバックに
    なったitemsのインデックス集合)。labelはログ出力用の見出し。"""
    import anthropic

    n = len(items)
    batches = []
    for start in range(0, n, batch_size):
        end = min(start + batch_size, n)
        batches.append((start, end, items[start:end]))

    def retry_missing_group(missing_items: list):
        """欠落した要素をRETRY_GROUP_SIZE件単位のグループにまとめ直し、
        1回だけ再試行する。このグループリトライでもなお欠落した要素は、
        それ以上の再試行はせずunknown_valueにフォールバックする。戻り値は
        (missing_itemsと同じ順序のrecordsリスト, usage集計辞書, フォールバック
        になったmissing_items内のローカルインデックス集合)。"""
        n_missing = len(missing_items)
        records: list = [unknown_value] * n_missing
        totals = new_usage_totals()
        failed_local: set[int] = set()
        for start in range(0, n_missing, RETRY_GROUP_SIZE):
            end = min(start + RETRY_GROUP_SIZE, n_missing)
            group = missing_items[start:end]
            try:
                group_records, usage = call_fn(group)
                add_usage(totals, usage)
            except (anthropic.APIError, ValueError, json.JSONDecodeError, TypeError) as e:
                print(
                    f"    警告({label}): グループ再試行（{len(group)}件）も失敗"
                    f"（フォールバックします）: {e}",
                    file=sys.stderr,
                )
                group_records = [None] * len(group)
            for i, record in enumerate(group_records):
                if record is None:
                    failed_local.add(start + i)
                else:
                    records[start + i] = record
        return records, totals, failed_local

    def classify_batch_safe(batch, start, end):
        try:
            records, usage = call_fn(batch)
        except (anthropic.APIError, ValueError, json.JSONDecodeError, TypeError) as e:
            print(
                f"  警告({label}): バッチ {start + 1}〜{end} の分類に失敗（応答全体が不正）。"
                f"{len(batch)}件をグループにまとめて再試行します: {e}",
                file=sys.stderr,
            )
            records = [None] * len(batch)
            usage = new_usage_totals()

        missing_local = [i for i, r in enumerate(records) if r is None]
        if missing_local:
            missing_display = [start + i + 1 for i in missing_local]
            # 2026-08-28、stop_reasonを付記（max_tokens切れでの途中終了か、
            # モデルが正常終了しつつ要素数を間違えたのかを区別できるようにする）。
            print(
                f"  警告({label}): バッチ {start + 1}〜{end} 中 {len(missing_local)}/{len(batch)}件が"
                f"LLM応答から欠落（{missing_display}件目、stop_reason={usage.get('stop_reason')}）。"
                f"欠落分をグループにまとめて再試行します。",
                file=sys.stderr,
            )

        totals = new_usage_totals()
        add_usage(totals, usage)
        failed_indices: set[int] = set()
        if missing_local:
            missing_items = [batch[i] for i in missing_local]
            retry_records, retry_totals, retry_failed_local = retry_missing_group(missing_items)
            add_usage(totals, retry_totals)
            for local_pos, i in enumerate(missing_local):
                records[i] = retry_records[local_pos]
                if local_pos in retry_failed_local:
                    failed_indices.add(start + i)
        return start, records, totals, failed_indices

    results: dict[int, list] = {}
    overall_totals = new_usage_totals()
    done_count = 0
    failed_indices: set[int] = set()

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(classify_batch_safe, batch, start, end): (start, end)
            for start, end, batch in batches
        }
        for future in as_completed(futures):
            start, records, totals, batch_failed = future.result()
            results[start] = records
            add_usage(overall_totals, totals)
            failed_indices.update(batch_failed)
            done_count += 1
            print(
                f"{label}中... {done_count}/{len(batches)} バッチ完了 "
                f"(累計 in={overall_totals['input_tokens']} out={overall_totals['output_tokens']} "
                f"cache_write={overall_totals['cache_creation_input_tokens']} "
                f"cache_read={overall_totals['cache_read_input_tokens']})",
                file=sys.stderr,
            )

    records = []
    for start, end, _ in batches:
        records.extend(results[start])

    return records, overall_totals, failed_indices


def classify_unique(
    queries: list[str],
    batch_size: int,
    max_workers: int,
    level12_model: str = CLASSIFY_MODEL,
    level3_model: str = CLASSIFY_MODEL,
    api_key: str | None = None,
    cancel_event=None,
) -> tuple[dict[str, Record], dict[str, int], set[str]]:
    """queriesからユニークな値だけを抽出し、最大3段階でLLMに分類させる
    （フェーズ3はcategory×taxonomy unknownの行が無ければ実行されない）。
    {query文字列: (ai_classification, ai_classification_2, ai_classification_3)} の辞書・
    usage集計辞書（全フェーズ合算。classification_common.new_usage_totals参照。
    input_tokens/output_tokensに加えてcache_creation_input_tokens/cache_read_
    input_tokensも含む。2026-08-28、プロンプトキャッシュのコストが可視化されて
    いなかった問題への対応。project memory参照）・分類に失敗しfallbackになった
    query集合を返す。同じqueryが何度出現しても分類は1回で済ませることで、
    API呼び出し回数を削減するとともに、同一クエリが別バッチに分かれて別々の判定結果に
    なる不整合を防ぐ。

    フェーズ1（level12_model）: ai_classification/_2を軽量プロンプトで判定する。
    フェーズ2（level3_model）: フェーズ1でunique_poi/brand_poi/categoryと判定された
    行だけを対象に、ai_classification_3（taxonomyリーフ）を判定する。それ以外
    （address/semantic_query/unknown）の行はこのフェーズをスキップするため、level3_model
    への送信対象は全体の一部に絞られる（詳細はモジュールdocstring参照）。
    level12_model/level3_modelに同じモデルを渡しても動作する（2026-08-27以降、
    main.py/gui_app.pyは常に両方にclassification_common.CLASSIFY_MODELを渡す）。
    フェーズ3（level12_model、2026-08-28新設）: フェーズ2で"category"×taxonomy
    unknownになった行だけを対象に、level2判定自体を再確認する（category据え置き/
    unique_poi/brand_poi/broken＝ai_classificationを"unknown"化、の4択）。
    unique_poi/brand_poiに訂正された行は、訂正後のsubtypeでフェーズ2相当の
    taxonomy判定をもう一度行う（詳細はモジュールdocstring参照）。

    api_key を渡すと ANTHROPIC_API_KEY 環境変数の代わりにそれを使う。

    cancel_event（threading.Event、GUI専用。CLI実行時は常にNone）がセットされている
    場合、各フェーズの境目でclassification_common.OperationCancelledを送出して
    以降のフェーズを中断する。実行中のAPI呼び出し自体は打ち切れないため、
    直前のフェーズが完了するまでは通常通り待つ（project memory参照）。"""
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

    triples, level12_totals, failed_idx1 = _run_batches_concurrently(
        level12_input, batch_size, max_workers, call_level12, ("unknown", "", None), "レベル1/2分類",
    )
    usage_totals = new_usage_totals()
    add_usage(usage_totals, level12_totals)
    failed_queries: set[str] = {unique_queries[i] for i in failed_idx1}

    raise_if_cancelled(cancel_event)

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

    def run_level3_group(
        indices: list[int], group_label: str,
    ) -> tuple[dict[int, str], dict[str, int], set[str]]:
        if not indices:
            return {}, new_usage_totals(), set()
        items = [(unique_queries[i], triples[i][1]) for i in indices]

        def call_level3(batch: list[tuple[str, str]]):
            return call_claude_level3(client, batch, level3_model, SYSTEM_PROMPT_LEVEL3)

        leaves, totals, failed_local = _run_batches_concurrently(
            items, batch_size, max_workers, call_level3, "unknown", group_label,
        )
        leaf_map = {global_i: leaves[local_i] for local_i, global_i in enumerate(indices)}
        failed = {items[local_i][0] for local_i in failed_local}
        return leaf_map, totals, failed

    # 2026-08-29、subtypeでbrand_poi/unique_poi・categoryの2グループに分けて別々の
    # プロンプトに送っていたのを統合した（SYSTEM_PROMPT_LEVEL3のdocstring参照。
    # BRAND_KNOWLEDGE埋め込みを撤去したことで両者のプロンプトが同一になったため）。
    level3_leaf_map, level3_totals, failed_level3 = run_level3_group(
        poi_indices_needing_llm, "レベル3分類(taxonomy)",
    )
    leaf_by_index.update(level3_leaf_map)
    add_usage(usage_totals, level3_totals)
    failed_queries |= failed_level3

    raise_if_cancelled(cancel_event)

    # フェーズ3: "category"×taxonomy unknownの再判定（2026-08-28新設）。
    # "category"は定義上「実在する業種を表す一般名詞」なので、正しく判定できて
    # いればtaxonomyのどれかに当てはまるのが本来の姿。taxonomyがどれにも
    # 一致しなかった（leaf_by_index[i] == "unknown"）という事実は、level2の
    # "category"判定自体が誤りだった可能性を示すシグナルとして扱う
    # （build_system_prompt_category_recheckのdocstring・project memory参照）。
    # unique_poi/brand_poi側のtaxonomy unknownは「実在する施設・ブランドだが
    # taxonomyがカバーしていない」正当なケースがあり得るため対象外とする。
    recheck_indices = [
        i for i in poi_indices
        if triples[i][1] == "category" and leaf_by_index.get(i) == "unknown"
    ]

    broken_indices: set[int] = set()
    if recheck_indices:
        recheck_items = [(unique_queries[i], candidates_per_query[i]) for i in recheck_indices]

        def call_recheck(batch: list[tuple[str, list[str] | None]]):
            return call_claude_category_recheck(client, batch, level12_model)

        # 失敗時のフォールバックは("category", None)＝据え置き（何も破壊しない）。
        recheck_records, recheck_totals, failed_re = _run_batches_concurrently(
            recheck_items, batch_size, max_workers, call_recheck, ("category", None), "カテゴリ再判定",
        )
        add_usage(usage_totals, recheck_totals)
        failed_queries |= {recheck_items[local_i][0] for local_i in failed_re}

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

        promote_leaf_map, promote_totals, failed_promote = run_level3_group(
            promote_needing_llm, "レベル3再分類(taxonomy、再判定後)",
        )
        leaf_by_index.update(promote_leaf_map)
        add_usage(usage_totals, promote_totals)
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

    mapping = dict(zip(unique_queries, records))
    return mapping, usage_totals, failed_queries
