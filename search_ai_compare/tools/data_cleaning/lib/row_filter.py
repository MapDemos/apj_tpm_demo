"""
ai-classify の任意フィルタ機能（列×演算子×値で対象行を絞り込む）で使う比較ロジック。
main.py（CLI）とgui_app.py（GUIの少量実行して見積機能）の両方から使う。

旧ai-retryサブコマンド（ai_classificationの値一致のみに限定された絞り込み）は、
このフィルタに一般化されて ai-classify に統合され廃止した（2026-08-25）。
"""

OPERATORS = ["=", "!=", ">", "<", "Include", "Exclude"]

# GUIの列ドロップダウンで「絞り込みなし」を表す表示用の値。main.py側では
# filter_column が空文字/None のときに同じ意味（絞り込みなし）になる。
NO_FILTER_LABEL = "(指定なし)"


def _try_float(s: str) -> float | None:
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def matches(cell_value: str, op: str, target: str) -> bool:
    """cell_value（CSVの生の文字列値）がop・targetの条件を満たすか判定する。
    "="/"!=" は文字列の完全一致/不一致。
    ">"/"<" は両辺をfloatに変換できれば数値比較、どちらか片方でも変換できなければ
    文字列（辞書順）比較にフォールバックする（例: same_query_count列のような数値列は
    数値比較、query列のような文字列列は辞書順比較になる）。
    "Include"/"Exclude" は部分一致（contains）/部分不一致。"""
    if op == "=":
        return cell_value == target
    if op == "!=":
        return cell_value != target
    if op == "Include":
        return target in cell_value
    if op == "Exclude":
        return target not in cell_value
    if op in (">", "<"):
        a, b = _try_float(cell_value), _try_float(target)
        left, right = (a, b) if a is not None and b is not None else (cell_value, target)
        return left > right if op == ">" else left < right
    raise ValueError(f"未知の演算子です: {op}")


def filter_row_indices(rows: list[dict], column: str | None, op: str | None, value: str | None) -> list[int]:
    """columnが指定されていれば、rowsのうちmatches()を満たす行のインデックスだけを
    返す。column未指定（None/空文字）の場合は絞り込みなし＝全行のインデックスを返す。"""
    if not column:
        return list(range(len(rows)))
    if op not in OPERATORS:
        raise ValueError(f"未知の演算子です: {op!r}（有効な値: {OPERATORS}）")
    return [i for i, row in enumerate(rows) if matches(row.get(column, ""), op, value or "")]
