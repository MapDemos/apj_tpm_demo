"""
main.py ai-classify / ai-retry サブコマンドが使う分類ロジック（旧 classify_queries.py）。

LLM（Claude Haiku、プロキシ経由）を使って query 配列を分類する。バッチ分割＋並行処理版。
1バッチがまるごと失敗した場合は、その中身を1件ずつ個別に再試行し、
それでも失敗した行だけを unknown にフォールバックする。

送信するのは query の値のみ（他の列はLLMに渡さない）。
分類カテゴリの定義（ai_classification/_2/_3の3階層）は classification_common.py を参照。
"""

import json
import sys
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

from lib.classification_common import (
    MODEL,
    SYSTEM_PROMPT,
    decode_triplets,
    parse_response_text,
)

PROXY_URL = "https://okqfpyxf4oe6htegrlcgrwdssa0yoxcr.lambda-url.us-east-1.on.aws/"

Record = tuple[str, str, str]  # (ai_classification, ai_classification_2, ai_classification_3)
# ai_classification_3は複数リーフを持てる場合、classification_common.LEAF_DELIMITER
# ("|") で連結した1文字列として入る（decode_triplet参照）。
UNKNOWN_RECORD: Record = ("unknown", "", "")


def call_claude(queries: list[str], model: str = MODEL) -> tuple[list[Record], dict]:
    """queriesのバッチをLLMに送り、分類結果（3階層タプルのリスト）と usage を返す"""
    user_content = json.dumps(queries, ensure_ascii=False)

    body = {
        "model": model,
        "max_tokens": 4096,
        # SYSTEM_PROMPTはBRAND_KNOWLEDGE(1500件超のブランド辞書)を埋め込んでおり
        # サイズが大きい。同一プロンプトをバッチごとに送り直すため、
        # cache_controlでプロンプトキャッシュを有効にし、2回目以降のリクエストの
        # input tokenコストを抑える（Anthropic Messages APIのプロンプトキャッシュ機能）。
        "system": [{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
        "messages": [{"role": "user", "content": user_content}],
    }
    # temperatureはSonnet 5では非推奨パラメータで、指定すると400 invalid_request_error
    # になる（ai_analyze.pyのgenerate_commentaryと同じ理由）。haiku指定時のみ付与する。
    if "haiku" in model:
        body["temperature"] = 0

    req = urllib.request.Request(
        PROXY_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=120) as res:
        data = json.loads(res.read().decode("utf-8"))

    content_blocks = data.get("content") or []
    text = "".join(
        b.get("text", "") for b in content_blocks if b.get("type") == "text"
    )
    text = parse_response_text(text)

    items = json.loads(text)

    if not isinstance(items, list) or len(items) != len(queries):
        raise ValueError(
            f"LLM応答の要素数が不正です（期待{len(queries)}件、実際{len(items) if isinstance(items, list) else '不明'}件）"
        )

    records = decode_triplets(items)
    usage = data.get("usage") or {}
    return records, usage


def _classify_single_safe(query: str, model: str) -> tuple[Record, dict]:
    """1件だけを分類する。失敗時は unknown を返す。"""
    try:
        records, usage = call_claude([query], model)
        return records[0], usage
    except (urllib.error.URLError, ValueError, json.JSONDecodeError) as e:
        print(f"    警告: 個別再試行も失敗（unknownにします）: {query!r}: {e}", file=sys.stderr)
        return UNKNOWN_RECORD, {}


def _classify_batch_safe(batch: list[str], start: int, end: int, n: int, model: str) -> tuple[int, list[Record], dict]:
    """1バッチ分の分類を実行。バッチ全体が失敗した場合は、その行だけを丸ごと
    unknownで埋めるのではなく、1件ずつ個別に再試行し、それでも失敗した行だけを
    unknownにフォールバックする。"""
    try:
        records, usage = call_claude(batch, model)
        return start, records, usage
    except (urllib.error.URLError, ValueError, json.JSONDecodeError) as e:
        print(
            f"  警告: バッチ {start + 1}〜{end} の分類に失敗。1件ずつ個別に再試行します: {e}",
            file=sys.stderr,
        )

    records: list[Record] = []
    usage = {"input_tokens": 0, "output_tokens": 0}
    for query in batch:
        record, single_usage = _classify_single_safe(query, model)
        records.append(record)
        usage["input_tokens"] += single_usage.get("input_tokens", 0) or 0
        usage["output_tokens"] += single_usage.get("output_tokens", 0) or 0

    return start, records, usage


def classify_all(queries: list[str], batch_size: int, max_workers: int, model: str = MODEL) -> tuple[list[Record], int, int]:
    n = len(queries)
    batches = []
    for start in range(0, n, batch_size):
        end = min(start + batch_size, n)
        batches.append((start, end, queries[start:end]))

    results: dict[int, list[Record]] = {}
    total_in = 0
    total_out = 0
    done_count = 0

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(_classify_batch_safe, batch, start, end, n, model): (start, end)
            for start, end, batch in batches
        }
        for future in as_completed(futures):
            start, records, usage = future.result()
            results[start] = records
            total_in += usage.get("input_tokens", 0) or 0
            total_out += usage.get("output_tokens", 0) or 0
            done_count += 1
            print(
                f"分類中... {done_count}/{len(batches)} バッチ完了 "
                f"(累計 in={total_in} out={total_out})",
                file=sys.stderr,
            )

    # start位置順に結合して元の順序を復元
    records: list[Record] = []
    for start, end, _ in batches:
        records.extend(results[start])

    return records, total_in, total_out


def classify_unique(queries: list[str], batch_size: int, max_workers: int, model: str = MODEL) -> tuple[dict[str, Record], int, int]:
    """queriesからユニークな値だけを抽出してLLMに渡し、{query文字列: (ai_classification,
    ai_classification_2, ai_classification_3)} の辞書を返す。同じqueryが何度出現しても
    分類は1回で済ませることで、API呼び出し回数を削減するとともに、同一クエリが別バッチに
    分かれて別々の判定結果になる不整合を防ぐ。呼び出し元は返ってきた辞書を
    row["query"] をキーに引くことで、行の位置(インデックス)に頼らず
    元データへマッピングできる。"""
    unique_queries = list(dict.fromkeys(queries))
    records, total_in, total_out = classify_all(unique_queries, batch_size, max_workers, model)
    mapping = dict(zip(unique_queries, records))
    return mapping, total_in, total_out
