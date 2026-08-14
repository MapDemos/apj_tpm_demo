"""
main.py count-classifications サブコマンドが使うロジック（旧 count_classifications.py）。

ai-classify（または ai-retry）の出力CSVにある "ai_classification" 列を件数集計する。
"""

import csv

from lib.classification_common import CATEGORIES


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
