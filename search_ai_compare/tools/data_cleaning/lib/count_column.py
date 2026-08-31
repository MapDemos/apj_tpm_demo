"""
main.py count-column サブコマンドが使うロジック（旧 count_queries.py / count_classifications.py を統合）。

指定した列（デフォルト "query"）の値が全体で何回出現するかを、行の近さに関係なく
カウントする。"ai_classification" 列を指定した場合のみ、lib/classification_common.py
のカテゴリ順（想定外ラベルは件数降順で末尾）に並べる。それ以外の列は件数降順、
同数なら初出順の安定ソート。
"""

import csv
from collections import Counter

from lib.classification_common import CATEGORIES

# このセットに含まれる列は、出現順ではなくclassification_common.pyのカテゴリ順で並べる。
KNOWN_ORDER_COLUMNS = {"ai_classification"}


def extract_values(input_path: str, column: str) -> list[str]:
    values: list[str] = []
    with open(input_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None or column not in reader.fieldnames:
            raise ValueError(f'入力CSVに "{column}" 列が見つかりません')
        for row in reader:
            values.append(row[column])
    return values


def count_values(values: list[str], column: str) -> list[tuple[str, int]]:
    counts = Counter(values)

    if column in KNOWN_ORDER_COLUMNS:
        remaining = dict(counts)
        items: list[tuple[str, int]] = []
        for label in CATEGORIES.values():
            if label in remaining:
                items.append((label, remaining.pop(label)))
        # 想定外のラベルが残っていれば、件数降順で末尾に追加
        items.extend(sorted(remaining.items(), key=lambda kv: -kv[1]))
        return items

    # 初出順を記録しておき、同countの場合は初出順で安定ソート
    first_seen: dict[str, int] = {}
    for i, v in enumerate(values):
        first_seen.setdefault(v, i)
    items = list(counts.items())
    items.sort(key=lambda kv: (-kv[1], first_seen[kv[0]]))
    return items


def write_counts(output_path: str, column: str, items: list[tuple[str, int]], total: int) -> None:
    # 2026-08-31、Excel等での文字化け対策としてBOM付きUTF-8で出力するようにした
    # （project memory参照）。
    with open(output_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        writer.writerow([column, "count", "ratio"])
        for label, count in items:
            ratio = f"{count / total * 100:.1f}%" if total else "0.0%"
            writer.writerow([label, count, ratio])
