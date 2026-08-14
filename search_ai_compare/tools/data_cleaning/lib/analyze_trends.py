"""
main.py analyze サブコマンドが使うクエリ傾向分析ロジック（旧 analyze_query_trends.py）。

分析する3観点:
  A. カテゴリ別頻出クエリ（各カテゴリ上位N件）
  B. 日別のカテゴリ比率推移（datetime列の日付部分でグループ化）
  C. カテゴリ×列指定率クロス集計（bbox/proximity/near がそれぞれ
     指定されている行の割合を、カテゴリごとに集計）

CSV出力・HTMLレポート生成の関数を提供する。ファイルパスの決定（output_utils）や
CLI引数の処理は main.py 側が担当し、このモジュールは集計・整形ロジックに専念する。
"""

import csv
import html
import sys
from collections import Counter, defaultdict

from lib.classification_common import CATEGORIES
from lib.output_utils import make_output_path, current_timestamp

REQUIRED_COLUMNS = ["query", "ai_classification", "datetime", "bbox", "proximity", "near"]

# classification_common.py のカテゴリ順（1〜7）に、
# dataviz skillの参照カラーパレット（categorical, fixed order）のスロット1〜7を対応させる。
# スロット8(red)は今回使わない。
CATEGORY_COLORS_LIGHT = ["#2a78d6", "#008300", "#e87ba4", "#eda100", "#1baf7a", "#eb6834", "#4a3aa7"]
CATEGORY_COLORS_DARK = ["#3987e5", "#008300", "#d55181", "#c98500", "#199e70", "#d95926", "#9085e9"]


def read_rows(input_path: str) -> tuple[list[str], list[dict]]:
    with open(input_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        if fieldnames is None:
            raise ValueError("入力CSVが空です")
        missing = [c for c in REQUIRED_COLUMNS if c not in fieldnames]
        if missing:
            raise ValueError(f"入力CSVに必要な列がありません: {missing}")
        rows = list(reader)
    return list(fieldnames), rows


def extract_date(datetime_str: str) -> str:
    """"2026-08-11 23:59:53 UTC" のような文字列から日付部分だけを取り出す。
    パースできない・空の場合は "unknown" とする。"""
    s = (datetime_str or "").strip()
    if not s or len(s) < 10:
        return "unknown"
    return s[:10]


# --- A. カテゴリ別頻出クエリ ---------------------------------------------

def compute_top_queries(rows: list[dict], top_n: int) -> dict[str, list[tuple[str, int]]]:
    per_category_queries: dict[str, list[str]] = defaultdict(list)
    for row in rows:
        per_category_queries[row.get("ai_classification", "")].append(row.get("query", ""))

    result: dict[str, list[tuple[str, int]]] = {}
    for category, queries in per_category_queries.items():
        counts = Counter(queries)
        first_seen = {}
        for i, q in enumerate(queries):
            first_seen.setdefault(q, i)
        items = sorted(counts.items(), key=lambda kv: (-kv[1], first_seen[kv[0]]))
        result[category] = items[:top_n]
    return result


# --- B. 日別カテゴリ比率推移 -----------------------------------------------

def compute_daily_category(rows: list[dict]) -> dict[str, dict[str, int]]:
    daily: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for row in rows:
        date = extract_date(row.get("datetime", ""))
        category = row.get("ai_classification", "")
        daily[date][category] += 1
    return dict(daily)


# --- C. カテゴリ×列指定率クロス集計 ----------------------------------------

def compute_column_usage(rows: list[dict]) -> dict[str, dict[str, int]]:
    usage: dict[str, dict[str, int]] = defaultdict(lambda: {"total": 0, "bbox": 0, "proximity": 0, "near": 0})
    for row in rows:
        category = row.get("ai_classification", "")
        stats = usage[category]
        stats["total"] += 1
        for col in ("bbox", "proximity", "near"):
            if (row.get(col) or "").strip():
                stats[col] += 1
    return dict(usage)


def category_order(seen_categories: set) -> list[str]:
    """classification_common.py のカテゴリ順（1〜7）を優先し、
    想定外のラベルが含まれる場合は末尾にアルファベット順で追加する。"""
    known_order = list(CATEGORIES.values())
    ordered = [c for c in known_order if c in seen_categories]
    unknown = sorted(c for c in seen_categories if c not in known_order)
    return ordered + unknown


# --- CSV出力 ---------------------------------------------------------------

def write_top_queries_csv(path: str, top_queries: dict[str, list[tuple[str, int]]], order: list[str]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["ai_classification", "rank", "query", "count"])
        for category in order:
            for rank, (query, count) in enumerate(top_queries.get(category, []), start=1):
                writer.writerow([category, rank, query, count])


def write_daily_category_csv(path: str, daily: dict[str, dict[str, int]], order: list[str]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["date", "ai_classification", "count", "ratio"])
        for date in sorted(daily.keys()):
            day_total = sum(daily[date].values())
            for category in order:
                count = daily[date].get(category, 0)
                ratio = f"{count / day_total * 100:.1f}%" if day_total else "0.0%"
                writer.writerow([date, category, count, ratio])


def write_column_usage_csv(path: str, usage: dict[str, dict[str, int]], order: list[str]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["ai_classification", "total", "bbox_rate", "proximity_rate", "near_rate"])
        for category in order:
            stats = usage.get(category, {"total": 0, "bbox": 0, "proximity": 0, "near": 0})
            total = stats["total"]

            def rate(col: str) -> str:
                return f"{stats[col] / total * 100:.1f}%" if total else "0.0%"

            writer.writerow([category, total, rate("bbox"), rate("proximity"), rate("near")])


# --- HTMLレポート ------------------------------------------------------------

def esc(s) -> str:
    return html.escape(str(s), quote=True)


def render_top_queries_section(top_queries: dict[str, list[tuple[str, int]]], order: list[str], top_n: int) -> str:
    blocks = []
    for category in order:
        items = top_queries.get(category, [])
        rows_html = "\n".join(
            f'<tr><td class="rank">{rank}</td><td>{esc(query)}</td><td class="num">{count}</td></tr>'
            for rank, (query, count) in enumerate(items, start=1)
        )
        blocks.append(f"""
        <details class="card" {"open" if category == order[0] else ""}>
          <summary><span class="cat-dot" style="background:var(--cat-{esc(category)})"></span>{esc(category)}
            <span class="muted">({len(items)} queries)</span></summary>
          <table class="data-table">
            <thead><tr><th>#</th><th>query</th><th class="num">count</th></tr></thead>
            <tbody>{rows_html if rows_html else '<tr><td colspan="3" class="muted">No data</td></tr>'}</tbody>
          </table>
        </details>""")
    return f"""
    <section>
      <h2>A. Top Queries by Category (top {top_n})</h2>
      {"".join(blocks)}
    </section>"""


def render_daily_category_section(daily: dict[str, dict[str, int]], order: list[str]) -> str:
    dates = sorted(daily.keys())
    legend = "".join(
        f'<span class="legend-item"><span class="swatch" style="background:var(--cat-{esc(c)})"></span>{esc(c)}</span>'
        for c in order
    )

    bars = []
    for date in dates:
        day_total = sum(daily[date].values()) or 1
        segments = []
        for category in order:
            count = daily[date].get(category, 0)
            if count <= 0:
                continue
            ratio = count / day_total
            pct = ratio * 100
            segments.append(
                f'<div class="segment" style="flex-grow:{ratio:.6f};background:var(--cat-{esc(category)})" '
                f'title="{esc(date)} / {esc(category)}: {count} ({pct:.1f}%)"></div>'
            )
        bars.append(f"""
          <div class="bar-col">
            <div class="bar">{"".join(segments)}</div>
            <div class="bar-label">{esc(date[5:])}</div>
          </div>""")

    table_rows = []
    for date in dates:
        day_total = sum(daily[date].values())
        for category in order:
            count = daily[date].get(category, 0)
            ratio = f"{count / day_total * 100:.1f}%" if day_total else "0.0%"
            table_rows.append(
                f"<tr><td>{esc(date)}</td><td>{esc(category)}</td><td class='num'>{count}</td><td class='num'>{ratio}</td></tr>"
            )

    return f"""
    <section>
      <h2>B. Daily Category Ratio Trend</h2>
      <div class="legend">{legend}</div>
      <div class="chart stacked-bars">{"".join(bars)}</div>
      <details class="card">
        <summary>Show data table</summary>
        <table class="data-table">
          <thead><tr><th>date</th><th>ai_classification</th><th class="num">count</th><th class="num">ratio</th></tr></thead>
          <tbody>{"".join(table_rows)}</tbody>
        </table>
      </details>
    </section>"""


def render_column_usage_section(usage: dict[str, dict[str, int]], order: list[str]) -> str:
    def metric_chart(col: str, label: str) -> str:
        rated = []
        for category in order:
            stats = usage.get(category, {"total": 0, col: 0})
            total = stats["total"]
            rate = (stats[col] / total * 100) if total else 0.0
            rated.append((category, rate))
        rated.sort(key=lambda kv: -kv[1])

        rows_html = "".join(
            f"""<div class="hbar-row">
                  <div class="hbar-label">{esc(category)}</div>
                  <div class="hbar-track"><div class="hbar-fill" style="width:{rate:.1f}%"></div></div>
                  <div class="hbar-value">{rate:.1f}%</div>
                </div>"""
            for category, rate in rated
        )
        return f"""
        <div class="hbar-chart">
          <h3>{esc(label)}</h3>
          {rows_html}
        </div>"""

    table_rows = []
    for category in order:
        stats = usage.get(category, {"total": 0, "bbox": 0, "proximity": 0, "near": 0})
        total = stats["total"]

        def rate(col: str) -> str:
            return f"{stats[col] / total * 100:.1f}%" if total else "0.0%"

        table_rows.append(
            f"<tr><td>{esc(category)}</td><td class='num'>{total}</td>"
            f"<td class='num'>{rate('bbox')}</td><td class='num'>{rate('proximity')}</td><td class='num'>{rate('near')}</td></tr>"
        )

    return f"""
    <section>
      <h2>C. Column Usage Rate by Category</h2>
      <div class="hbar-grid">
        {metric_chart("bbox", "bbox specified rate")}
        {metric_chart("proximity", "proximity specified rate")}
        {metric_chart("near", "near specified rate")}
      </div>
      <details class="card">
        <summary>Show data table</summary>
        <table class="data-table">
          <thead><tr><th>ai_classification</th><th class="num">total</th>
            <th class="num">bbox_rate</th><th class="num">proximity_rate</th><th class="num">near_rate</th></tr></thead>
          <tbody>{"".join(table_rows)}</tbody>
        </table>
      </details>
    </section>"""


def render_html_report(
    input_path: str,
    generated_at: str,
    total_rows: int,
    order: list[str],
    top_queries: dict[str, list[tuple[str, int]]],
    daily: dict[str, dict[str, int]],
    usage: dict[str, dict[str, int]],
    top_n: int,
) -> str:
    cat_vars_light = "\n".join(
        f"      --cat-{esc(c)}: {CATEGORY_COLORS_LIGHT[i % len(CATEGORY_COLORS_LIGHT)]};" for i, c in enumerate(order)
    )
    cat_vars_dark = "\n".join(
        f"      --cat-{esc(c)}: {CATEGORY_COLORS_DARK[i % len(CATEGORY_COLORS_DARK)]};" for i, c in enumerate(order)
    )

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Query Trend Analysis Report</title>
<style>
  :root {{
    color-scheme: light;
    --surface-1: #fcfcfb;
    --page: #f9f9f7;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --muted: #898781;
    --gridline: #e1e0d9;
    --border: rgba(11,11,11,0.10);
{cat_vars_light}
  }}
  @media (prefers-color-scheme: dark) {{
    :root:where(:not([data-theme="light"])) {{
      color-scheme: dark;
      --surface-1: #1a1a19;
      --page: #0d0d0d;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --muted: #898781;
      --gridline: #2c2c2a;
      --border: rgba(255,255,255,0.10);
{cat_vars_dark}
    }}
  }}
  :root[data-theme="dark"] {{
    color-scheme: dark;
    --surface-1: #1a1a19;
    --page: #0d0d0d;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --muted: #898781;
    --gridline: #2c2c2a;
    --border: rgba(255,255,255,0.10);
{cat_vars_dark}
  }}

  * {{ box-sizing: border-box; }}
  body {{
    margin: 0;
    padding: 32px 16px 64px;
    background: var(--page);
    color: var(--text-primary);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  }}
  main {{ max-width: 960px; margin: 0 auto; }}
  h1 {{ font-size: 1.5rem; margin-bottom: 4px; }}
  .meta {{ color: var(--text-secondary); font-size: 0.875rem; margin-bottom: 32px; }}
  h2 {{ font-size: 1.125rem; margin: 0 0 12px; border-bottom: 1px solid var(--gridline); padding-bottom: 8px; }}
  h3 {{ font-size: 0.9375rem; margin: 0 0 8px; color: var(--text-secondary); }}
  section {{ margin-bottom: 40px; }}
  .muted {{ color: var(--muted); font-size: 0.8125rem; }}

  .card {{
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 16px;
    margin-bottom: 8px;
  }}
  .card summary {{ cursor: pointer; font-weight: 600; display: flex; align-items: center; gap: 8px; }}
  .cat-dot {{ width: 10px; height: 10px; border-radius: 50%; display: inline-block; }}

  .data-table {{
    width: 100%;
    border-collapse: collapse;
    margin-top: 12px;
    font-size: 0.8125rem;
  }}
  .data-table th, .data-table td {{
    text-align: left;
    padding: 6px 8px;
    border-bottom: 1px solid var(--gridline);
  }}
  .data-table th {{ color: var(--text-secondary); font-weight: 600; }}
  .data-table td.num, .data-table th.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
  .data-table td.rank {{ color: var(--muted); width: 2em; }}

  .legend {{ display: flex; flex-wrap: wrap; gap: 12px 20px; margin-bottom: 16px; font-size: 0.8125rem; }}
  .legend-item {{ display: flex; align-items: center; gap: 6px; color: var(--text-secondary); }}
  .swatch {{ width: 10px; height: 10px; border-radius: 2px; display: inline-block; }}

  .chart.stacked-bars {{
    display: flex;
    align-items: flex-end;
    gap: 4px;
    height: 240px;
    padding: 8px 8px 0;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow-x: auto;
  }}
  .bar-col {{ display: flex; flex-direction: column; align-items: center; flex: 1 0 20px; min-width: 20px; height: 100%; }}
  .bar {{ width: 100%; flex: 1; display: flex; flex-direction: column; border-radius: 3px 3px 0 0; overflow: hidden; }}
  .segment {{ width: 100%; border-bottom: 2px solid var(--surface-1); }}
  .segment:last-child {{ border-bottom: none; }}
  .bar-label {{ font-size: 0.6875rem; color: var(--muted); margin-top: 6px; writing-mode: vertical-rl; }}

  .hbar-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-bottom: 8px; }}
  .hbar-chart {{ background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }}
  .hbar-row {{ display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 0.8125rem; }}
  .hbar-label {{ width: 30%; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
  .hbar-track {{ flex: 1; height: 10px; background: var(--gridline); border-radius: 4px; overflow: hidden; }}
  .hbar-fill {{ height: 100%; background: var(--series-1, #2a78d6); border-radius: 4px; }}
  .hbar-value {{ width: 3.5em; text-align: right; font-variant-numeric: tabular-nums; color: var(--text-secondary); }}
</style>
</head>
<body>
<main>
  <h1>Query Trend Analysis Report</h1>
  <div class="meta">Input file: {esc(input_path)} / Total rows: {total_rows} / Generated at: {esc(generated_at)}</div>

  {render_top_queries_section(top_queries, order, top_n)}
  {render_daily_category_section(daily, order)}
  {render_column_usage_section(usage, order)}
</main>
</body>
</html>
"""
