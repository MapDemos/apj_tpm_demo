#!/usr/bin/env python3
"""
classify_queries.py の出力CSVのうち、"ai_classification" 列が "others" になっている
行だけを対象に再分類し、その列を更新したCSVを別ファイルとして出力するスクリプト。

バッチ内の要素数不一致（LLM応答の要素数が期待と異なる場合）等で失敗し
othersで埋められた行を狙い撃ちで再実行する用途を想定している。
（本来 others が正しい判定だった行も対象に含まれるが、再送しても
 othersのまま返ってくるだけなので実害はない）

分類ロジック（バッチ分割・並行実行・番号→ラベル変換）は classify_queries.py の
classify_all をそのまま再利用する。

出力先は output/ 配下に自動生成
（<入力ファイル名>_classified_retry_analysis_result_<タイムスタンプ>.csv）。

使い方:
    python3 retry_others_queries.py input.csv [--batch-size 30] [--workers 8] [--max-batches N]

input.csv は classify_queries.py（または本スクリプト）が出力した、
"ai_classification" 列を含むCSVを想定している。

--max-batches は再実行対象（othersの行）の先頭から指定バッチ数までに処理を絞る
オプション（動作確認用）。未指定なら対象全件を処理する。
"""

import argparse
import csv
import sys
import time

from classify_queries import classify_all
from output_utils import make_output_path

SUFFIX = "classified_retry_analysis_result"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_csv")
    parser.add_argument("--batch-size", type=int, default=30)
    parser.add_argument("--workers", type=int, default=8, help="並行実行するリクエスト数")
    parser.add_argument(
        "--max-batches",
        type=int,
        default=None,
        help="先頭から指定バッチ数までに処理を絞る（動作確認用。未指定なら全件処理）",
    )
    args = parser.parse_args()

    output_path = make_output_path(args.input_csv, SUFFIX)

    with open(args.input_csv, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        if fieldnames is None or "query" not in fieldnames:
            raise ValueError('入力CSVに "query" 列が見つかりません')
        if "ai_classification" not in fieldnames:
            raise ValueError('入力CSVに "ai_classification" 列が見つかりません')
        rows = list(reader)

    target_indices = [i for i, row in enumerate(rows) if row.get("ai_classification") == "others"]

    if not target_indices:
        print("othersの行が見つかりませんでした。再実行対象なし。")
        with open(output_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
        print(f"出力先: {output_path}（入力をそのままコピー）")
        return

    if args.max_batches is not None:
        limit = args.max_batches * args.batch_size
        target_indices = target_indices[:limit]

    target_queries = [rows[i]["query"] for i in target_indices]

    print(f"再実行対象: {len(target_indices)}件（全{len(rows)}件中）", file=sys.stderr)

    t0 = time.time()
    labels, total_in, total_out = classify_all(target_queries, args.batch_size, args.workers)
    elapsed = time.time() - t0

    for i, label in zip(target_indices, labels):
        rows[i]["ai_classification"] = label

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    still_others = sum(1 for i in target_indices if rows[i]["ai_classification"] == "others")

    print(f"\n再実行件数: {len(target_indices)}")
    print(f"再実行後もothersのまま: {still_others}件")
    print(f"所要時間: {elapsed:.1f}秒")
    print(f"input tokens合計 : {total_in}")
    print(f"output tokens合計: {total_out}")
    print(f"出力先: {output_path}")


if __name__ == "__main__":
    main()
