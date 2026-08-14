#!/usr/bin/env python3
"""
classify_queries.py（または retry_others_queries.py）の出力CSVにある
"ai_classification" 列を件数集計するスクリプト

出力先は output/ 配下に自動生成
（<入力ファイル名>_classification_count_analysis_result_<タイムスタンプ>.csv）。
出力CSV列: ai_classification, count, ratio
（classification_common.py のカテゴリ順で出力。
 想定外のラベルが含まれる場合は、その他として末尾に件数の降順で追加する）

使い方:
    python3 count_classifications.py input.csv
"""

import csv
import sys

from lib.classification_common import CATEGORIES
from lib.output_utils import make_output_path

SUFFIX = "classification_count_analysis_result"


def extract_labels(input_path: str) -> list[str]:
    labels: list[str] = []
    with open(input_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None or "ai_classification" not in reader.fieldnames:
            raise ValueError('入力CSVに "ai_classification" 列が見つかりません')
        for row in reader:
            labels.append(row["ai_classification"])
    return labels


def count_labels(labels: list[str]) -> list[tuple[str, int]]:
    counts: dict[str, int] = {}
    for label in labels:
        counts[label] = counts.get(label, 0) + 1

    known_order = list(CATEGORIES.values())
    items: list[tuple[str, int]] = []

    # classification_common.py のカテゴリ順（1〜7）でまず並べる
    for label in known_order:
        if label in counts:
            items.append((label, counts.pop(label)))

    # 想定外のラベルが残っていれば、件数降順で末尾に追加
    unknown = sorted(counts.items(), key=lambda kv: -kv[1])
    items.extend(unknown)

    return items


def write_counts(output_path: str, items: list[tuple[str, int]], total: int) -> None:
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["ai_classification", "count", "ratio"])
        for label, count in items:
            ratio = f"{count / total * 100:.1f}%" if total else "0.0%"
            writer.writerow([label, count, ratio])


def main() -> None:
    if len(sys.argv) != 2:
        print("使い方: python3 count_classifications.py <input.csv>", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = make_output_path(input_path, SUFFIX)

    labels = extract_labels(input_path)
    items = count_labels(labels)
    total = len(labels)

    write_counts(output_path, items, total)

    print(f"総行数: {total}")
    for label, count in items:
        ratio = f"{count / total * 100:.1f}%" if total else "0.0%"
        print(f"  {label}: {count}件（{ratio}）")
    print(f"出力先: {output_path}")


if __name__ == "__main__":
    main()
