"""
main.py analyze サブコマンドが使うクエリ傾向分析ロジック（旧 analyze_query_trends.py）。

分析する4観点:
  A. カテゴリ別頻出クエリ（各カテゴリ上位N件）
  B. 日別のカテゴリ比率推移（datetime列の日付部分でグループ化）
  C. カテゴリ×列指定率クロス集計（bbox/proximity/near がそれぞれ
     指定されている行の割合を、カテゴリごとに集計）
  D. ロングテール分布（queryごとの総出現回数をバケット分けし、各バケットが
     総検索ボリュームの何%を占めるかを円グラフで示す。全体＋カテゴリ別）

CSV出力・HTMLレポート生成の関数を提供する。ファイルパスの決定（output_utils）や
CLI引数の処理は main.py 側が担当し、このモジュールは集計・整形ロジックに専念する。
"""

import csv
import html
import math
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

# D(ロングテール分布)のバケット定義。(ラベル, 下限, 上限。上限Noneは上限なし)
# 頻度が高いほど濃い色になるよう、blue系の単色グラデーション(sequential hue)を割り当てる
# （バケットはカテゴリ識別ではなく頻度という順序尺度なので、categoricalではなくsequentialを使う）。
LONG_TAIL_BUCKETS = [
    ("1000+", 1000, None),
    ("500-999", 500, 999),
    ("100-499", 100, 499),
    ("10-99", 10, 99),
    ("2-9", 2, 9),
    ("1", 1, 1),
]
LONG_TAIL_COLORS_LIGHT = ["#0d366b", "#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4"]
LONG_TAIL_COLORS_DARK = ["#104281", "#1c5cab", "#256abf", "#3987e5", "#6da7ec", "#86b6ef"]


def _bucket_for_count(count: int) -> str:
    for label, lo, hi in LONG_TAIL_BUCKETS:
        if hi is None:
            if count >= lo:
                return label
        elif lo <= count <= hi:
            return label
    return "unknown"


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


# --- D. ロングテール分布 ---------------------------------------------------

ALL_CATEGORIES_SCOPE = "All categories"


def compute_long_tail_distribution(queries: list[str]) -> dict:
    """queries全体を対象に、各queryの総出現回数をバケット分けし、
    バケットごとのユニークquery数・検索ボリューム(count合計)・
    総検索ボリュームに対する割合(volume_pct)を集計する。"""
    counts = Counter(queries)
    total_volume = sum(counts.values())

    buckets = {label: {"unique_queries": 0, "volume": 0} for label, _, _ in LONG_TAIL_BUCKETS}
    for query, c in counts.items():
        label = _bucket_for_count(c)
        buckets[label]["unique_queries"] += 1
        buckets[label]["volume"] += c

    for label in buckets:
        volume = buckets[label]["volume"]
        buckets[label]["volume_pct"] = (volume / total_volume * 100) if total_volume else 0.0

    return {"total_volume": total_volume, "buckets": buckets}


def compute_long_tail_by_scope(rows: list[dict], order: list[str]) -> dict[str, dict]:
    """"All categories"(全体)＋カテゴリごとに compute_long_tail_distribution を計算する。"""
    per_category_queries: dict[str, list[str]] = defaultdict(list)
    all_queries: list[str] = []
    for row in rows:
        query = row.get("query", "")
        per_category_queries[row.get("ai_classification", "")].append(query)
        all_queries.append(query)

    result = {ALL_CATEGORIES_SCOPE: compute_long_tail_distribution(all_queries)}
    for category in order:
        result[category] = compute_long_tail_distribution(per_category_queries.get(category, []))
    return result


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


def write_long_tail_csv(path: str, long_tail: dict[str, dict], order: list[str]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["scope", "bucket", "unique_query_count", "total_count", "volume_pct"])
        for scope in [ALL_CATEGORIES_SCOPE] + order:
            data = long_tail.get(scope)
            if not data:
                continue
            for label, _, _ in LONG_TAIL_BUCKETS:
                b = data["buckets"][label]
                writer.writerow([scope, label, b["unique_queries"], b["volume"], f"{b['volume_pct']:.1f}%"])


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

    # --- 折れ線グラフ（カテゴリごとに1本、x=日付、y=件数） ---
    svg_w, svg_h = 860, 260
    pad_l, pad_r, pad_t, pad_b = 48, 16, 16, 28
    plot_w = svg_w - pad_l - pad_r
    plot_h = svg_h - pad_t - pad_b
    n = len(dates)
    max_count = max((count for d in dates for count in daily[d].values()), default=0) or 1

    def x_at(i: int) -> float:
        return pad_l + (i / (n - 1) * plot_w if n > 1 else plot_w / 2)

    def y_at(count: int) -> float:
        return pad_t + plot_h - (count / max_count * plot_h)

    # 横方向のグリッド線＋y軸ラベル（0 / 50% / 100%目盛り）
    gridlines = []
    for frac in (0.0, 0.5, 1.0):
        y = pad_t + plot_h - frac * plot_h
        value = round(max_count * frac)
        gridlines.append(
            f'<line x1="{pad_l}" y1="{y:.1f}" x2="{svg_w - pad_r}" y2="{y:.1f}" '
            f'stroke="var(--gridline)" stroke-width="1"/>'
            f'<text x="{pad_l - 6}" y="{y:.1f}" text-anchor="end" dominant-baseline="middle" '
            f'class="axis-label">{value}</text>'
        )

    # x軸ラベル（日付。込み合う場合は間引く）
    label_stride = max(1, n // 10)
    x_labels = [
        f'<text x="{x_at(i):.1f}" y="{svg_h - 6}" text-anchor="middle" class="axis-label">{esc(date[5:])}</text>'
        for i, date in enumerate(dates)
        if i % label_stride == 0 or i == n - 1
    ]

    lines_svg = []
    for category in order:
        points = [(x_at(i), y_at(daily[date].get(category, 0))) for i, date in enumerate(dates)]
        path_d = "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in points)
        lines_svg.append(f'<path d="{path_d}" fill="none" stroke="var(--cat-{esc(category)})" stroke-width="2"/>')
        for i, date in enumerate(dates):
            count = daily[date].get(category, 0)
            day_total = sum(daily[date].values()) or 1
            pct = count / day_total * 100
            x, y = points[i]
            lines_svg.append(
                f'<circle cx="{x:.1f}" cy="{y:.1f}" r="4" fill="var(--cat-{esc(category)})">'
                f'<title>{esc(date)} / {esc(category)}: {count} ({pct:.1f}%)</title></circle>'
            )

    svg = f"""
      <svg class="line-chart" viewBox="0 0 {svg_w} {svg_h}" role="img" aria-label="Daily category count trend">
        {"".join(gridlines)}
        {"".join(x_labels)}
        {"".join(lines_svg)}
      </svg>"""

    # --- マトリクス表（行=ai_classification、列=date、セル=count(ratio%)） ---
    header_cells = "".join(f'<th class="num">{esc(date)}</th>' for date in dates)
    day_totals = {date: sum(daily[date].values()) for date in dates}
    matrix_rows = []
    for category in order:
        cells = []
        for date in dates:
            count = daily[date].get(category, 0)
            total = day_totals[date]
            pct = (count / total * 100) if total else 0.0
            cells.append(f'<td class="num">{count}({pct:.1f}%)</td>')
        matrix_rows.append(f"<tr><td>{esc(category)}</td>{''.join(cells)}</tr>")

    return f"""
    <section>
      <h2>B. Daily Category Trend</h2>
      <div class="legend">{legend}</div>
      <div class="chart-frame">{svg}</div>
      <details class="card">
        <summary>Show data table</summary>
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr><th>ai_classification</th>{header_cells}</tr></thead>
            <tbody>{"".join(matrix_rows)}</tbody>
          </table>
        </div>
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


def _pie_slice_paths(data: dict, cx: float, cy: float, r: float) -> list[str]:
    """1つのscope(全体 or カテゴリ)分の円グラフをSVG pathのリストとして組み立てる。
    バケットの volume_pct をそのまま弧の角度に変換する（時計回り、12時位置から開始）。"""
    total_volume = data["total_volume"]
    if not total_volume:
        return []

    slices = []
    start_angle = -90.0
    for i, (label, _, _) in enumerate(LONG_TAIL_BUCKETS):
        b = data["buckets"][label]
        frac = b["volume"] / total_volume
        if frac <= 0:
            continue
        # 360度ぴったりだと始点と終点が一致し弧が消えるため、わずかに手前で止める
        angle = min(frac * 360, 359.999)
        end_angle = start_angle + angle

        x1 = cx + r * math.cos(math.radians(start_angle))
        y1 = cy + r * math.sin(math.radians(start_angle))
        x2 = cx + r * math.cos(math.radians(end_angle))
        y2 = cy + r * math.sin(math.radians(end_angle))
        large_arc = 1 if angle > 180 else 0

        path_d = f"M{cx:.1f},{cy:.1f} L{x1:.2f},{y1:.2f} A{r:.1f},{r:.1f} 0 {large_arc} 1 {x2:.2f},{y2:.2f} Z"
        slices.append(
            f'<path d="{path_d}" fill="var(--lt-{i})" stroke="var(--surface-1)" stroke-width="2">'
            f'<title>{esc(label)}: {b["unique_queries"]} unique queries, {b["volume"]} searches ({b["volume_pct"]:.1f}%)</title>'
            f"</path>"
        )
        start_angle = end_angle
    return slices


def render_long_tail_section(long_tail: dict[str, dict], order: list[str]) -> str:
    scopes = [ALL_CATEGORIES_SCOPE] + order

    legend = "".join(
        f'<span class="legend-item"><span class="swatch" style="background:var(--lt-{i})"></span>{esc(label)}</span>'
        for i, (label, _, _) in enumerate(LONG_TAIL_BUCKETS)
    )

    pies = []
    for scope in scopes:
        data = long_tail.get(scope)
        if not data or not data["total_volume"]:
            continue
        slices = _pie_slice_paths(data, cx=60, cy=60, r=56)
        pies.append(f"""
          <div class="pie-cell">
            <svg viewBox="0 0 120 120" class="pie-chart" role="img" aria-label="Long-tail distribution for {esc(scope)}">
              {"".join(slices)}
            </svg>
            <div class="pie-label">{esc(scope)}</div>
          </div>""")

    table_rows = []
    for scope in scopes:
        data = long_tail.get(scope)
        if not data:
            continue
        for label, _, _ in LONG_TAIL_BUCKETS:
            b = data["buckets"][label]
            table_rows.append(
                f"<tr><td>{esc(scope)}</td><td>{esc(label)}</td>"
                f"<td class='num'>{b['unique_queries']}</td><td class='num'>{b['volume']}</td>"
                f"<td class='num'>{b['volume_pct']:.1f}%</td></tr>"
            )

    return f"""
    <section>
      <h2>D. Long-tail Distribution</h2>
      <p class="muted">Share of total search volume by how often each query repeats
        (bucketed by each query's total occurrence count). A high share in the
        low-frequency buckets means a lot of volume comes from queries that rarely
        repeat individually &mdash; frequency alone understates their importance.</p>
      <div class="legend">{legend}</div>
      <div class="pie-grid">{"".join(pies)}</div>
      <details class="card">
        <summary>Show data table</summary>
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr><th>scope</th><th>bucket</th><th class="num">unique_queries</th>
              <th class="num">total_count</th><th class="num">volume_pct</th></tr></thead>
            <tbody>{"".join(table_rows)}</tbody>
          </table>
        </div>
      </details>
    </section>"""


def render_ai_commentary_section(commentary: dict) -> str:
    overview = esc(commentary.get("overview", ""))
    highlights = commentary.get("highlights", []) or []
    items = "".join(f"<li>{esc(h)}</li>" for h in highlights)
    return f"""
    <section class="ai-summary">
      <h2><span class="ai-badge">AI</span> Analysis Summary</h2>
      <p>{overview}</p>
      <ul>{items}</ul>
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
    long_tail: dict[str, dict] | None = None,
    ai_commentary: dict | None = None,
) -> str:
    cat_vars_light = "\n".join(
        f"      --cat-{esc(c)}: {CATEGORY_COLORS_LIGHT[i % len(CATEGORY_COLORS_LIGHT)]};" for i, c in enumerate(order)
    )
    cat_vars_dark = "\n".join(
        f"      --cat-{esc(c)}: {CATEGORY_COLORS_DARK[i % len(CATEGORY_COLORS_DARK)]};" for i, c in enumerate(order)
    )
    lt_vars_light = "\n".join(f"      --lt-{i}: {c};" for i, c in enumerate(LONG_TAIL_COLORS_LIGHT))
    lt_vars_dark = "\n".join(f"      --lt-{i}: {c};" for i, c in enumerate(LONG_TAIL_COLORS_DARK))

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
{lt_vars_light}
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
{lt_vars_dark}
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
{lt_vars_dark}
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

  .ai-summary {{
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-left: 3px solid var(--series-1, #2a78d6);
    border-radius: 8px;
    padding: 16px 20px;
  }}
  .ai-summary h2 {{ display: flex; align-items: center; gap: 8px; }}
  .ai-badge {{
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.02em;
    color: #fff; background: var(--series-1, #2a78d6);
    border-radius: 4px; padding: 2px 6px;
  }}
  .ai-summary p {{ color: var(--text-primary); margin: 0 0 8px; }}
  .ai-summary ul {{ margin: 0; padding-left: 1.25em; }}
  .ai-summary li {{ margin-bottom: 4px; font-size: 0.9375rem; }}

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

  .chart-frame {{
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px;
    overflow-x: auto;
  }}
  .line-chart {{ width: 100%; min-width: 560px; height: auto; display: block; }}
  .line-chart .axis-label {{ font-size: 9px; fill: var(--muted); font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }}
  .line-chart circle {{ cursor: default; }}
  .table-scroll {{ overflow-x: auto; }}

  .hbar-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-bottom: 8px; }}
  .hbar-chart {{ background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }}
  .hbar-row {{ display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 0.8125rem; }}
  .hbar-label {{ width: 30%; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
  .hbar-track {{ flex: 1; height: 10px; background: var(--gridline); border-radius: 4px; overflow: hidden; }}
  .hbar-fill {{ height: 100%; background: var(--series-1, #2a78d6); border-radius: 4px; }}
  .hbar-value {{ width: 3.5em; text-align: right; font-variant-numeric: tabular-nums; color: var(--text-secondary); }}

  .pie-grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 16px; }}
  .pie-cell {{
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; padding: 12px;
  }}
  .pie-chart {{ width: 100%; max-width: 120px; height: auto; }}
  .pie-chart path {{ cursor: default; }}
  .pie-label {{ font-size: 0.8125rem; color: var(--text-secondary); text-align: center; }}
</style>
</head>
<body>
<main>
  <h1>Query Trend Analysis Report</h1>
  <div class="meta">Input file: {esc(input_path)} / Total rows: {total_rows} / Generated at: {esc(generated_at)}</div>

  {render_ai_commentary_section(ai_commentary) if ai_commentary else ""}
  {render_top_queries_section(top_queries, order, top_n)}
  {render_daily_category_section(daily, order)}
  {render_column_usage_section(usage, order)}
  {render_long_tail_section(long_tail, order) if long_tail else ""}
</main>
</body>
</html>
"""
