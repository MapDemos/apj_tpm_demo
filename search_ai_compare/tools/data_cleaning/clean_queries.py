#!/usr/bin/env python3
"""
CSVクレンジングスクリプト（query列のみ抽出版）

想定入力列:
"endpoint","query","bbox","proximity","types","poi_category",
"poi_category_exclusions","result_limit","language","country",
"near","navigation_profile","datetime"

処理内容:
1. "query" 列の値のみを抽出（元の出現順を保持）
2. 上から順に走査し、ある行の query が「後ろ5行以内」に再び出現する場合、
   最初に出てきた方を正として採用し、後方の重複行は削除する
3. 重複解消後の query 一覧を1列のCSVとして出力する

出力先は output/ 配下に自動生成（<入力ファイル名>_cleaning_queryonly_<タイムスタンプ>.csv）。

使い方:
    python3 clean_queries.py input.csv
"""

import csv
import sys

from lib.output_utils import make_output_path

WINDOW = 5  # 「後ろ5行以内」の窓幅
SUFFIX = "cleaning_queryonly"


def extract_queries(input_path: str) -> list[str]:
    """入力CSVから query 列の値だけを、出現順のリストとして取り出す"""
    queries: list[str] = []
    with open(input_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None or "query" not in reader.fieldnames:
            raise ValueError('入力CSVに "query" 列が見つかりません')
        for row in reader:
            queries.append(row["query"])
    return queries


def dedupe_within_window(queries: list[str], window: int = WINDOW) -> list[str]:
    """
    上から順に走査し、ある行の query が後ろ window 行以内に再出現する場合、
    後方の重複を削除する（最初の出現を正とする）。

    既に重複として削除された行は、以降の走査対象（起点）にはしない。
    """
    n = len(queries)
    deleted = [False] * n

    for i in range(n):
        if deleted[i]:
            continue
        for j in range(i + 1, min(i + window, n - 1) + 1):
            if deleted[j]:
                continue
            if queries[j] == queries[i]:
                deleted[j] = True

    return [q for i, q in enumerate(queries) if not deleted[i]]


def write_queries(output_path: str, queries: list[str]) -> None:
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["query"])
        for q in queries:
            writer.writerow([q])


def main() -> None:
    if len(sys.argv) != 2:
        print("使い方: python3 clean_queries.py <input.csv>", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = make_output_path(input_path, SUFFIX)

    queries = extract_queries(input_path)
    before = len(queries)

    cleaned = dedupe_within_window(queries, WINDOW)
    after = len(cleaned)

    write_queries(output_path, cleaned)

    print(f"抽出したquery件数: {before}")
    print(f"重複除去後のquery件数: {after}（{before - after}件削除）")
    print(f"出力先: {output_path}")


if __name__ == "__main__":
    main()
