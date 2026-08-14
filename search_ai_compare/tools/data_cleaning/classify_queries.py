#!/usr/bin/env python3
"""
LLM(Claude Haiku)を使って query 列を分類し、判定結果列を追加したCSVを出力するスクリプト
（プロキシ経由・並行処理版）

分類カテゴリの定義は classification_common.py を参照（番号1〜7で返させ、
Python側でカテゴリ名に変換する。出力トークン削減のため、
"unsupported_query_location_intent" のような長いカテゴリ名文字列を
そのまま返させない）。

送信するのは "query" 列の値のみ（他の列はLLMに渡さない）。
判定結果は元のCSVに "ai_classification" 列を追加して出力する（列の値はカテゴリ名の文字列）。

出力先は output/ 配下に自動生成
（<入力ファイル名>_classified_analysis_result_<タイムスタンプ>.csv）。

使い方:
    python3 classify_queries.py input.csv [--batch-size 30] [--workers 8] [--max-batches N]

--workers はバッチリクエストを何件同時に投げるかの並列数。
プロキシ側のスループット次第だが、まずは 5〜10 程度を推奨。

--max-batches は先頭から指定バッチ数までに処理を絞るオプション（動作確認用）。
未指定なら全件処理する。指定した場合、出力CSVも処理した範囲の行のみになる点に注意。

事前準備:
    特になし（このスクリプトが直接叩くのはプロキシ経由のLambda URLで、
    x-api-key等の認証情報はプロキシ側で付与されるためローカルには不要）
"""

import argparse
import csv
import json
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

from classification_common import (
    MODEL,
    SYSTEM_PROMPT,
    numbers_to_labels,
    parse_response_text,
)
from output_utils import make_output_path

PROXY_URL = "https://okqfpyxf4oe6htegrlcgrwdssa0yoxcr.lambda-url.us-east-1.on.aws/"
SUFFIX = "classified_analysis_result"


def call_claude(queries: list[str]) -> tuple[list[str], dict]:
    """queriesのバッチをLLMに送り、分類結果リストと usage を返す"""
    user_content = json.dumps(queries, ensure_ascii=False)

    body = {
        "model": MODEL,
        "max_tokens": 4096,
        "temperature": 0,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_content}],
    }

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

    numbers = json.loads(text)

    if not isinstance(numbers, list) or len(numbers) != len(queries):
        raise ValueError(
            f"LLM応答の要素数が不正です（期待{len(queries)}件、実際{len(numbers) if isinstance(numbers, list) else '不明'}件）"
        )

    labels = numbers_to_labels(numbers)
    usage = data.get("usage") or {}
    return labels, usage


def _classify_single_safe(query: str) -> tuple[str, dict]:
    """1件だけを分類する。失敗時は others を返す。"""
    try:
        labels, usage = call_claude([query])
        return labels[0], usage
    except (urllib.error.URLError, ValueError, json.JSONDecodeError) as e:
        print(f"    警告: 個別再試行も失敗（othersにします）: {query!r}: {e}", file=sys.stderr)
        return "others", {}


def _classify_batch_safe(batch: list[str], start: int, end: int, n: int) -> tuple[int, list[str], dict]:
    """1バッチ分の分類を実行。バッチ全体が失敗した場合は、その行だけを丸ごと
    othersで埋めるのではなく、1件ずつ個別に再試行し、それでも失敗した行だけを
    othersにフォールバックする。"""
    try:
        labels, usage = call_claude(batch)
        return start, labels, usage
    except (urllib.error.URLError, ValueError, json.JSONDecodeError) as e:
        print(
            f"  警告: バッチ {start + 1}〜{end} の分類に失敗。1件ずつ個別に再試行します: {e}",
            file=sys.stderr,
        )

    labels = []
    usage = {"input_tokens": 0, "output_tokens": 0}
    for query in batch:
        label, single_usage = _classify_single_safe(query)
        labels.append(label)
        usage["input_tokens"] += single_usage.get("input_tokens", 0) or 0
        usage["output_tokens"] += single_usage.get("output_tokens", 0) or 0

    return start, labels, usage


def classify_all(queries: list[str], batch_size: int, max_workers: int) -> tuple[list[str], int, int]:
    n = len(queries)
    batches = []
    for start in range(0, n, batch_size):
        end = min(start + batch_size, n)
        batches.append((start, end, queries[start:end]))

    results: dict[int, list[str]] = {}
    total_in = 0
    total_out = 0
    done_count = 0

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(_classify_batch_safe, batch, start, end, n): (start, end)
            for start, end, batch in batches
        }
        for future in as_completed(futures):
            start, labels, usage = future.result()
            results[start] = labels
            total_in += usage.get("input_tokens", 0) or 0
            total_out += usage.get("output_tokens", 0) or 0
            done_count += 1
            print(
                f"分類中... {done_count}/{len(batches)} バッチ完了 "
                f"(累計 in={total_in} out={total_out})",
                file=sys.stderr,
            )

    # start位置順に結合して元の順序を復元
    labels: list[str] = []
    for start, end, _ in batches:
        labels.extend(results[start])

    return labels, total_in, total_out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_csv")
    parser.add_argument("--batch-size", type=int, default=30)
    parser.add_argument("--workers", type=int, default=8, help="並行実行するリクエスト数")
    parser.add_argument(
        "--max-batches",
        type=int,
        default=None,
        help="先頭から指定バッチ数までに処理を絞る（動作確認用。未指定なら全件処理。"
        "出力CSVも処理した範囲の行のみになる）",
    )
    args = parser.parse_args()

    output_path = make_output_path(args.input_csv, SUFFIX)

    with open(args.input_csv, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        if fieldnames is None or "query" not in fieldnames:
            raise ValueError('入力CSVに "query" 列が見つかりません')
        rows = list(reader)

    if args.max_batches is not None:
        rows = rows[: args.max_batches * args.batch_size]

    queries = [row.get("query", "") for row in rows]

    t0 = time.time()
    labels, total_in, total_out = classify_all(queries, args.batch_size, args.workers)
    elapsed = time.time() - t0

    out_fieldnames = list(fieldnames) + ["ai_classification"]
    for row, label in zip(rows, labels):
        row["ai_classification"] = label

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=out_fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f"\n処理件数: {len(rows)}")
    print(f"所要時間: {elapsed:.1f}秒")
    print(f"input tokens合計 : {total_in}")
    print(f"output tokens合計: {total_out}")
    print(f"出力先: {output_path}")


if __name__ == "__main__":
    main()
