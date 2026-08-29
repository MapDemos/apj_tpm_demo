"""
main.py analyze サブコマンドが使うクエリ傾向分析ロジック（旧 analyze_query_trends.py）。

分析する7観点:
  A. 日別クエリ量（全カテゴリ合計、折れ線グラフ）
  B. 時間帯別クエリ量（全日付を集計し、0〜23時（JST。元データはUTCなので変換）の
     時間帯別に棒グラフで表示）
  C. 都道府県別proximity分布（proximity座標を最寄りの都道府県代表地点に
     スナップして集計。代表地点名にはローマ字表記を併記。代表地点は
     lib/jp_prefectures.py のハードコード値、北海道→沖縄の標準順で表示）
  D. カテゴリ別頻出クエリ（各カテゴリ上位N件）
  E. 日別のカテゴリ比率推移（datetime列の日付部分でグループ化）
  F. パラメータ利用率（bbox/proximity/poi_category/poi_category_exclusions/
     near/navigation_profileがそれぞれ指定されている行の割合。カテゴリ別には
     分けず、全体を通した単純な利用率）
  G. ロングテール分布（queryごとの総出現回数をバケット分けし、各バケットが
     総検索ボリュームの何%を占めるかを円グラフで示す。全体＋カテゴリ別）
  H. Classification Breakdown（ai_classificationの内訳、件数とパーセント）
  I. POI Taxonomy Breakdown（ai_classification_2がunique_poi/brand_poi/categoryの
     各サブタイプごとに、ai_classification_3内訳を件数とパーセントで表示。
     2026-08-26よりai_classification_3は1行に複数リーフを持てるため延べ数ベースの
     集計＝合計が100%を超えうる。旧仕様ではbrand_poiのみが対象だったが、
     unique_poi/categoryも同様に集計対象に拡大）
  J. Address Structure Breakdown（addressのai_classification_2内訳、件数とパーセント）
  K. Brand Breakdown（ai_classification_2がbrand_poiの行を対象に、
     ai_classification_2_brand（main.py cmd_ai_classifyが出力するブランド名列）別の
     内訳を件数とパーセントで表示。2026-08-29新設）
     H/I/JはCSVにai_classification_2/_3列がある場合のみ、Kはai_classification_2_brand
     列がある場合のみ表示する（無い入力でもanalyzeサブコマンド自体は動く。
     3階層分類スキーマ導入前のファイル用の後方互換）

CSV出力・HTMLレポート生成の関数を提供する。ファイルパスの決定（output_utils）や
CLI引数の処理は main.py 側が担当し、このモジュールは集計・整形ロジックに専念する。
"""

import csv
import html
import math
import sys
from collections import Counter, defaultdict

from lib.classification_common import CATEGORIES
from lib.jp_prefectures import PREFECTURES as JP_PREFECTURES
from lib.output_utils import make_output_path, current_timestamp

REQUIRED_COLUMNS = [
    "query", "ai_classification", "datetime",
    "bbox", "proximity", "poi_category", "poi_category_exclusions", "near", "navigation_profile",
]

# C(パラメータ利用率)の対象列
USAGE_COLUMNS = ["bbox", "proximity", "poi_category", "poi_category_exclusions", "near", "navigation_profile"]

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


def extract_hour_jst(datetime_str: str) -> int | None:
    """"2026-08-11 23:59:53 UTC" のような文字列から時を取り出し、JST(UTC+9)に
    変換した0〜23の時を返す。入力データのdatetime列は常にUTC表記という前提
    （この集計ログの運用上、末尾に"UTC"が付く形式で統一されている）。
    パースできない場合はNone。"""
    s = (datetime_str or "").strip()
    if len(s) < 13:
        return None
    try:
        hour_utc = int(s[11:13])
    except ValueError:
        return None
    if not (0 <= hour_utc <= 23):
        return None
    return (hour_utc + 9) % 24


# --- A. 日別クエリ量 ---------------------------------------------------------

def compute_daily_volume(rows: list[dict]) -> dict[str, int]:
    """カテゴリに関係なく、日付ごとの総クエリ件数を集計する。"""
    counts: dict[str, int] = defaultdict(int)
    for row in rows:
        counts[extract_date(row.get("datetime", ""))] += 1
    return dict(counts)


# --- B. 時間帯別クエリ量 -----------------------------------------------------

def compute_hourly_volume(rows: list[dict]) -> dict:
    """全日付をまとめて、0〜23時（JST）の時間帯別に総クエリ件数を集計する。"""
    counts = {h: 0 for h in range(24)}
    unknown = 0
    for row in rows:
        hour = extract_hour_jst(row.get("datetime", ""))
        if hour is None:
            unknown += 1
            continue
        counts[hour] += 1
    return {"counts": counts, "unknown": unknown, "total": len(rows)}


# --- C. 都道府県別proximity分布 ----------------------------------------------

def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """2点間の直線距離（球面近似、km）。都道府県代表地点への最近傍判定にのみ使う。"""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def parse_proximity(raw: str) -> tuple[float, float] | None:
    """proximity列（"lng,lat"形式、Mapboxの座標順規約）をパースする。失敗時はNone。"""
    parts = (raw or "").strip().split(",")
    if len(parts) != 2:
        return None
    try:
        lng, lat = float(parts[0]), float(parts[1])
    except ValueError:
        return None
    return lng, lat


def compute_proximity_by_prefecture(rows: list[dict]) -> dict:
    """各行のproximity座標を、最も近い都道府県代表地点(lib/jp_prefectures.py)に
    スナップして件数を集計する。proximity未指定・パース失敗の行は
    no_proximityとして別枠にする（分母には含む）。"""
    counts = {name: 0 for name, _, _, _ in JP_PREFECTURES}
    no_proximity = 0
    for row in rows:
        parsed = parse_proximity(row.get("proximity", ""))
        if parsed is None:
            no_proximity += 1
            continue
        lng, lat = parsed
        nearest_name = min(JP_PREFECTURES, key=lambda p: _haversine_km(lat, lng, p[1], p[2]))[0]
        counts[nearest_name] += 1
    return {"total": len(rows), "no_proximity": no_proximity, "counts": counts}


# --- D. カテゴリ別頻出クエリ ---------------------------------------------

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


# --- E. 日別カテゴリ比率推移 -----------------------------------------------

def compute_daily_category(rows: list[dict]) -> dict[str, dict[str, int]]:
    daily: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for row in rows:
        date = extract_date(row.get("datetime", ""))
        category = row.get("ai_classification", "")
        daily[date][category] += 1
    return dict(daily)


# --- F. パラメータ利用率 ----------------------------------------------------

def compute_column_usage(rows: list[dict]) -> dict:
    """カテゴリ別には分けず、全行を通した単純なパラメータ利用率を集計する。"""
    counts = {col: 0 for col in USAGE_COLUMNS}
    for row in rows:
        for col in USAGE_COLUMNS:
            if (row.get(col) or "").strip():
                counts[col] += 1
    return {"total": len(rows), "counts": counts}


# --- H. ai_classification / _2 / _3 の内訳（2026-08-25追加） ---------------
# 3階層分類スキーマ(ai_classification/_2/_3)の内訳を実数・パーセントで見せる。
# ai_classification_2/_3列が無い入力（3階層スキーマ導入前のファイル）でも
# analyzeサブコマンド自体は動かせるよう、これらの集計はNoneを返して
# render_html_report側でセクション自体を出さないようにする（他の集計と同じ方式）。

def compute_classification_breakdown(rows: list[dict], order: list[str]) -> dict:
    """ai_classification（poi/address/semantic_query/unknown）の件数・全体に対する
    割合を、order（category_order()の並び）順で返す。"""
    counts = Counter(row.get("ai_classification", "") for row in rows)
    total = len(rows)
    items = [
        {"label": c, "count": counts.get(c, 0), "pct": (counts.get(c, 0) / total * 100) if total else 0.0}
        for c in order
    ]
    return {"total": total, "items": items}


def compute_poi_taxonomy_breakdown(rows: list[dict]) -> dict[str, dict] | None:
    """ai_classification_2がunique_poi/brand_poi/categoryのそれぞれについて、
    ai_classification_3（category-taxonomy.jsのリーフ、"|"区切りで複数格納
    されうる）別の件数・そのサブタイプ総数に対する割合を返す。1行が複数リーフを
    持つ場合はそれぞれのリーフに1件ずつ加算する延べ数ベースの集計のため、件数・
    割合の合計はサブタイプ総数（100%）を超えることがある。
    戻り値は {subtype: {"total": int, "items": [...]}, ...} で、subtypeの
    キー順はPOI_SUBTYPESの定義順（unique_poi/brand_poi/category）。
    ai_classification_2列が入力に無い場合はNone（セクション非表示の合図）。"""
    if not rows or "ai_classification_2" not in rows[0]:
        return None
    from lib.classification_common import POI_SUBTYPES

    result: dict[str, dict] = {}
    for subtype in POI_SUBTYPES.values():
        sub_rows = [r for r in rows if r.get("ai_classification_2") == subtype]
        total = len(sub_rows)
        counts: Counter = Counter()
        for r in sub_rows:
            raw = r.get("ai_classification_3", "") or ""
            leaves = [leaf for leaf in raw.split("|") if leaf] or ["(unclassified)"]
            counts.update(leaves)
        items = sorted(
            (
                {"label": leaf, "count": count, "pct": (count / total * 100) if total else 0.0}
                for leaf, count in counts.items()
            ),
            key=lambda item: -item["count"],
        )
        result[subtype] = {"total": total, "items": items}
    return result


def compute_brand_breakdown(rows: list[dict]) -> dict | None:
    """ai_classification_2がbrand_poiの行を対象に、ai_classification_2_brand
    （main.py cmd_ai_classifyが出力するブランド名列。BRAND_CATEGORY_MAPのキー）
    別の件数・brand_poi総数に対する割合を、件数の多い順で返す。空文字
    （個別リトライでも分類に失敗しフォールバックした行等）は集計から除外する。
    ai_classification_2_brand列が入力に無い場合はNone（セクション非表示の合図。
    2026-08-25以前に生成されたclassified CSVにはこの列自体が無い）。2026-08-29新設。"""
    if not rows or "ai_classification_2_brand" not in rows[0]:
        return None

    brand_poi_rows = [r for r in rows if r.get("ai_classification_2") == "brand_poi"]
    total = len(brand_poi_rows)
    counts = Counter(r.get("ai_classification_2_brand", "") for r in brand_poi_rows if r.get("ai_classification_2_brand"))
    items = sorted(
        (
            {"label": brand, "count": count, "pct": (count / total * 100) if total else 0.0}
            for brand, count in counts.items()
        ),
        key=lambda item: -item["count"],
    )
    return {"total": total, "items": items}


def compute_address_structure_breakdown(rows: list[dict]) -> dict | None:
    """ai_classification == "address" の行を対象に、ai_classification_2
    （region/place/locality/neighborhood/address）別の件数・address総数に対する
    割合を、その定義順で返す。ai_classification_2列が入力に無い場合はNone。"""
    if not rows or "ai_classification_2" not in rows[0]:
        return None
    from lib.classification_common import ADDRESS_SUBTYPES

    address_rows = [r for r in rows if r.get("ai_classification") == "address"]
    total = len(address_rows)
    counts = Counter(r.get("ai_classification_2", "") for r in address_rows)
    order = list(ADDRESS_SUBTYPES.values())
    items = [
        {"label": s, "count": counts.get(s, 0), "pct": (counts.get(s, 0) / total * 100) if total else 0.0}
        for s in order
    ]
    return {"total": total, "items": items}


def category_order(seen_categories: set) -> list[str]:
    """classification_common.py のカテゴリ順（1〜7）を優先し、
    想定外のラベルが含まれる場合は末尾にアルファベット順で追加する。"""
    known_order = list(CATEGORIES.values())
    ordered = [c for c in known_order if c in seen_categories]
    unknown = sorted(c for c in seen_categories if c not in known_order)
    return ordered + unknown


# --- G. ロングテール分布 ---------------------------------------------------

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

def write_daily_volume_csv(path: str, daily_volume: dict[str, int]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["date", "count"])
        for date in sorted(daily_volume.keys()):
            writer.writerow([date, daily_volume[date]])


def write_hourly_volume_csv(path: str, hourly_volume: dict) -> None:
    counts = hourly_volume["counts"]
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["hour_jst", "count"])
        for h in range(24):
            writer.writerow([f"{h:02d}", counts[h]])
        if hourly_volume["unknown"]:
            writer.writerow(["unknown", hourly_volume["unknown"]])


def write_proximity_prefecture_csv(path: str, proximity_data: dict) -> None:
    total = proximity_data["total"]
    counts = proximity_data["counts"]
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["prefecture", "prefecture_romaji", "count", "rate_pct"])
        for name, _, _, romaji in JP_PREFECTURES:
            count = counts[name]
            rate = f"{count / total * 100:.1f}%" if total else "0.0%"
            writer.writerow([name, romaji, count, rate])
        no_prox = proximity_data["no_proximity"]
        rate = f"{no_prox / total * 100:.1f}%" if total else "0.0%"
        writer.writerow(["(no proximity)", "", no_prox, rate])


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


def write_column_usage_csv(path: str, usage: dict) -> None:
    total = usage["total"]
    counts = usage["counts"]
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["parameter", "count", "total", "rate_pct"])
        for col in USAGE_COLUMNS:
            count = counts[col]
            rate = f"{count / total * 100:.1f}%" if total else "0.0%"
            writer.writerow([col, count, total, rate])


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


def render_ai_insight(text: str | None) -> str:
    """各セクションに埋め込む短いAIコメンタリー1本分のHTML。
    textが無ければ何も出さない（analyzeの場合や生成失敗時はAI Insightごと非表示）。"""
    if not text:
        return ""
    return f'<p class="ai-insight"><span class="ai-badge">AI</span> {esc(text)}</p>'


def render_daily_volume_section(daily_volume: dict[str, int]) -> str:
    dates = sorted(daily_volume.keys())
    svg_w, svg_h = 860, 220
    pad_l, pad_r, pad_t, pad_b = 48, 16, 16, 28
    plot_w = svg_w - pad_l - pad_r
    plot_h = svg_h - pad_t - pad_b
    n = len(dates)
    max_count = max(daily_volume.values(), default=0) or 1

    def x_at(i: int) -> float:
        return pad_l + (i / (n - 1) * plot_w if n > 1 else plot_w / 2)

    def y_at(count: int) -> float:
        return pad_t + plot_h - (count / max_count * plot_h)

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

    label_stride = max(1, n // 10)
    x_labels = [
        f'<text x="{x_at(i):.1f}" y="{svg_h - 6}" text-anchor="middle" class="axis-label">{esc(date[5:])}</text>'
        for i, date in enumerate(dates)
        if i % label_stride == 0 or i == n - 1
    ]

    points = [(x_at(i), y_at(daily_volume[date])) for i, date in enumerate(dates)]
    path_d = "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in points)
    line = f'<path d="{path_d}" fill="none" stroke="var(--series-1, #2a78d6)" stroke-width="2"/>'
    circles = "".join(
        f'<circle cx="{x:.1f}" cy="{y:.1f}" r="4" fill="var(--series-1, #2a78d6)">'
        f'<title>{esc(date)}: {daily_volume[date]}</title></circle>'
        for (x, y), date in zip(points, dates)
    )

    svg = f"""
      <svg class="line-chart" viewBox="0 0 {svg_w} {svg_h}" role="img" aria-label="Daily query volume trend">
        {"".join(gridlines)}
        {"".join(x_labels)}
        {line}
        {circles}
      </svg>"""

    table_rows = "".join(f"<tr><td>{esc(date)}</td><td class='num'>{daily_volume[date]}</td></tr>" for date in dates)

    return f"""
    <section>
      <h2>A. Daily Query Volume</h2>
      <div class="chart-frame">{svg}</div>
      <details class="card">
        <summary>Show data table</summary>
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr><th>date</th><th class="num">count</th></tr></thead>
            <tbody>{table_rows}</tbody>
          </table>
        </div>
      </details>
    </section>"""


def render_hourly_volume_section(hourly_volume: dict) -> str:
    counts = hourly_volume["counts"]
    max_count = max(counts.values(), default=0) or 1
    svg_w, svg_h = 860, 220
    pad_l, pad_r, pad_t, pad_b = 48, 16, 16, 28
    plot_w = svg_w - pad_l - pad_r
    plot_h = svg_h - pad_t - pad_b
    n = 24
    bar_gap = 4
    bar_w = (plot_w - bar_gap * (n - 1)) / n

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

    bars = []
    for h in range(24):
        count = counts.get(h, 0)
        bar_h = (count / max_count * plot_h) if max_count else 0
        x = pad_l + h * (bar_w + bar_gap)
        y = pad_t + plot_h - bar_h
        bars.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_w:.1f}" height="{bar_h:.1f}" '
            f'fill="var(--series-1, #2a78d6)" rx="2"><title>{h:02d}:00 &ndash; {count}</title></rect>'
        )
        if h % 3 == 0:
            bars.append(
                f'<text x="{x + bar_w / 2:.1f}" y="{svg_h - 6}" text-anchor="middle" '
                f'class="axis-label">{h:02d}</text>'
            )

    svg = f"""
      <svg class="line-chart" viewBox="0 0 {svg_w} {svg_h}" role="img" aria-label="Query volume by hour of day (JST)">
        {"".join(gridlines)}
        {"".join(bars)}
      </svg>"""

    table_rows = "".join(
        f"<tr><td>{h:02d}:00</td><td class='num'>{counts.get(h, 0)}</td></tr>" for h in range(24)
    )
    if hourly_volume["unknown"]:
        table_rows += f"<tr><td>unknown</td><td class='num'>{hourly_volume['unknown']}</td></tr>"

    return f"""
    <section>
      <h2>B. Query Volume by Hour of Day (JST)</h2>
      <p class="muted">All dates combined, grouped by hour. Source data is recorded in
        UTC and converted to JST (UTC+9) here.</p>
      <div class="chart-frame">{svg}</div>
      <details class="card">
        <summary>Show data table</summary>
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr><th>hour (JST)</th><th class="num">count</th></tr></thead>
            <tbody>{table_rows}</tbody>
          </table>
        </div>
      </details>
    </section>"""


def render_proximity_prefecture_section(proximity_data: dict) -> str:
    total = proximity_data["total"]
    counts = proximity_data["counts"]

    # 件数順ではなく、JP_PREFECTURESの並び順（北海道→沖縄の標準的な都道府県順）で表示する
    rated = [
        (name, romaji, counts[name], (counts[name] / total * 100) if total else 0.0)
        for name, _, _, romaji in JP_PREFECTURES
    ]

    rows_html = "".join(
        f"""<div class="hbar-row">
              <div class="hbar-label">{esc(name)} ({esc(romaji)})</div>
              <div class="hbar-track"><div class="hbar-fill" style="width:{rate:.1f}%"></div></div>
              <div class="hbar-value">{rate:.1f}%</div>
            </div>"""
        for name, romaji, count, rate in rated
        if count > 0
    )

    no_prox = proximity_data["no_proximity"]
    no_prox_rate = (no_prox / total * 100) if total else 0.0

    table_rows = "".join(
        f"<tr><td>{esc(name)} ({esc(romaji)})</td><td class='num'>{count}</td><td class='num'>{rate:.1f}%</td></tr>"
        for name, romaji, count, rate in rated
    )
    table_rows += f"<tr><td>(no proximity)</td><td class='num'>{no_prox}</td><td class='num'>{no_prox_rate:.1f}%</td></tr>"

    return f"""
    <section>
      <h2>C. Proximity Distribution by Prefecture</h2>
      <p class="muted">Each query's proximity coordinate snapped to the nearest of
        Japan's 47 prefectural representative points (straight-line distance;
        approximate, not an exact boundary lookup). {no_prox} of {total} queries
        had no usable proximity ({no_prox_rate:.1f}%).</p>
      <div class="hbar-chart hbar-chart-scroll">
        {rows_html}
      </div>
      <details class="card">
        <summary>Show data table</summary>
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr><th>prefecture</th><th class="num">count</th><th class="num">rate_pct</th></tr></thead>
            <tbody>{table_rows}</tbody>
          </table>
        </div>
      </details>
    </section>"""


def render_top_queries_section(
    top_queries: dict[str, list[tuple[str, int]]],
    order: list[str],
    top_n: int,
    insights: dict | None = None,
) -> str:
    overall_insight = insights.get("top_queries_overall") if insights else None
    by_category_insights = (insights.get("top_queries_by_category") or {}) if insights else {}

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
          {render_ai_insight(by_category_insights.get(category))}
          <table class="data-table">
            <thead><tr><th>#</th><th>query</th><th class="num">count</th></tr></thead>
            <tbody>{rows_html if rows_html else '<tr><td colspan="3" class="muted">No data</td></tr>'}</tbody>
          </table>
        </details>""")
    return f"""
    <section>
      <h2>D. Top Queries by Category (top {top_n})</h2>
      {render_ai_insight(overall_insight)}
      {"".join(blocks)}
    </section>"""


def render_daily_category_section(daily: dict[str, dict[str, int]], order: list[str], insight: str | None = None) -> str:
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
      <h2>E. Daily Category Trend</h2>
      {render_ai_insight(insight)}
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


MAX_BREAKDOWN_COLUMNS = 4


def _split_into_columns(items: list, max_cols: int = MAX_BREAKDOWN_COLUMNS) -> list[list]:
    """itemsを最大max_cols個の、できるだけ均等な（差が最大1件の）連続した塊に
    分割する。件数の多い方から詰めるitems順を前提に、先頭の列から順に多く
    割り当てる（例: 5件を4列なら[2,1,1,1]）。items自体は呼び出し元で既に
    件数降順ソート済みの想定なので、列ごとに上位グループがまとまる
    （2026-08-29新設。レポートの縦長リストが見づらいとの指摘への対応。
    project memory参照）。空リストなら[[]]を返す（呼び出し元の"データ無し"
    表示をそのまま使えるように）。"""
    if not items:
        return [[]]
    cols = min(max_cols, len(items))
    base, extra = divmod(len(items), cols)
    chunks = []
    idx = 0
    for c in range(cols):
        size = base + (1 if c < extra else 0)
        chunks.append(items[idx:idx + size])
        idx += size
    return chunks


def _render_breakdown_block(heading_html: str, subtitle: str, breakdown: dict) -> str:
    """compute_classification_breakdown/compute_poi_taxonomy_breakdown/
    compute_address_structure_breakdown/compute_brand_breakdownの共通レンダラー。
    件数とパーセントを横棒グラフ＋データテーブルで見せる
    （render_column_usage_sectionと同じ見た目）。見出し（h2 or h3タグ込みの
    HTML片）と<section>タグの有無は呼び出し側の責務とし、ここではブロック本体
    だけを組み立てる。単独で1セクション分（H/Jのように<section>で包んで使う）
    にも、複数ブロックを1つの<section>にまとめる（Iのようにサブタイプごとに
    h3見出しで並べる）にも流用できる。

    2026-08-29、項目数が多いと縦に長くなり見づらいとの指摘のため、棒グラフ・
    データテーブルの両方を最大MAX_BREAKDOWN_COLUMNS列の段組みにした
    （_split_into_columns参照。項目数が列数未満ならその数の列になる）。"""
    total = breakdown["total"]
    items = breakdown["items"]
    columns = _split_into_columns(items)
    num_cols = len(columns) if items else 1

    def render_rows(chunk: list) -> str:
        return "".join(
            f"""<div class="hbar-row">
                  <div class="hbar-label">{esc(item["label"])}</div>
                  <div class="hbar-track"><div class="hbar-fill" style="width:{item["pct"]:.1f}%"></div></div>
                  <div class="hbar-value">{item["count"]} ({item["pct"]:.1f}%)</div>
                </div>"""
            for item in chunk
        )

    def render_table_rows(chunk: list) -> str:
        return "".join(
            f"<tr><td>{esc(item['label'])}</td><td class='num'>{item['count']}</td>"
            f"<td class='num'>{total}</td><td class='num'>{item['pct']:.1f}%</td></tr>"
            for item in chunk
        )

    chart_columns_html = "".join(f'<div class="hbar-col">{render_rows(chunk)}</div>' for chunk in columns)
    table_columns_html = "".join(
        f"""<table class="data-table">
              <thead><tr><th>label</th><th class="num">count</th><th class="num">total</th><th class="num">pct</th></tr></thead>
              <tbody>{render_table_rows(chunk)}</tbody>
            </table>"""
        for chunk in columns
    )

    return f"""
      {heading_html}
      <p class="muted">{esc(subtitle)}</p>
      <div class="hbar-chart hbar-chart-grid" style="--breakdown-cols:{num_cols}">
        {chart_columns_html if items else '<p class="muted">No data available.</p>'}
      </div>
      <details class="card">
        <summary>Show data table</summary>
        <div class="data-table-grid" style="--breakdown-cols:{num_cols}">
          {table_columns_html if items else ''}
        </div>
      </details>"""


def _render_breakdown_section(section_id: str, title: str, subtitle: str, breakdown: dict) -> str:
    """_render_breakdown_blockを<section>+h2見出しで包む、H/J向けの単一ブロック版。"""
    return f"""
    <section id="{section_id}">
      {_render_breakdown_block(f"<h2>{esc(title)}</h2>", subtitle, breakdown)}
    </section>"""


def render_poi_taxonomy_section(poi_taxonomy_breakdown: dict[str, dict]) -> str:
    """Iセクション。unique_poi/brand_poi/categoryの各サブタイプごとに、
    ai_classification_3内訳をh3見出しのブロックとして1つの<section>にまとめる。"""
    from lib.classification_common import POI_SUBTYPES

    subtitle_by_subtype = {
        "unique_poi": "Rows classified as unique_poi (a name unique to a single real-world "
        "location) only, broken down by ai_classification_3 (category-taxonomy leaf) as a "
        "count and share of the unique_poi total.",
        "brand_poi": "Rows classified as brand_poi (a chain or brand name) only, broken down "
        "by ai_classification_3 (category-taxonomy leaf) as a count and share of the "
        "brand_poi total.",
        "category": "Rows classified as category (a generic noun for a type of place) only, "
        "broken down by ai_classification_3 (category-taxonomy leaf) as a count and share "
        "of the category total.",
    }

    blocks = "".join(
        _render_breakdown_block(
            f"<h3>{esc(subtype)}</h3>", subtitle_by_subtype[subtype], poi_taxonomy_breakdown[subtype]
        )
        for subtype in POI_SUBTYPES.values()
        if subtype in poi_taxonomy_breakdown
    )

    return f"""
    <section id="poi-taxonomy-breakdown">
      <h2>I. POI Taxonomy Breakdown</h2>
      <p class="muted">When a row is tagged with multiple categories, each one gets a
        count, so totals and percentages can exceed 100% of each subtype's total.</p>
      {blocks}
    </section>"""


def render_column_usage_section(usage: dict, insight: str | None = None) -> str:
    total = usage["total"]
    counts = usage["counts"]

    rated = [(col, counts[col], (counts[col] / total * 100) if total else 0.0) for col in USAGE_COLUMNS]
    rated.sort(key=lambda t: -t[2])

    rows_html = "".join(
        f"""<div class="hbar-row">
              <div class="hbar-label">{esc(col)}</div>
              <div class="hbar-track"><div class="hbar-fill" style="width:{rate:.1f}%"></div></div>
              <div class="hbar-value">{rate:.1f}%</div>
            </div>"""
        for col, count, rate in rated
    )

    table_rows = "".join(
        f"<tr><td>{esc(col)}</td><td class='num'>{count}</td><td class='num'>{total}</td><td class='num'>{rate:.1f}%</td></tr>"
        for col, count, rate in rated
    )

    return f"""
    <section>
      <h2>F. Parameter Usage Rate</h2>
      {render_ai_insight(insight)}
      <div class="hbar-chart">
        {rows_html}
      </div>
      <details class="card">
        <summary>Show data table</summary>
        <table class="data-table">
          <thead><tr><th>parameter</th><th class="num">count</th><th class="num">total</th><th class="num">rate_pct</th></tr></thead>
          <tbody>{table_rows}</tbody>
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


def render_long_tail_section(long_tail: dict[str, dict], order: list[str], insight: str | None = None) -> str:
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
      <h2>G. Long-tail Distribution</h2>
      {render_ai_insight(insight)}
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
    """レポート冒頭の全体サマリー。2〜3行程度の短いoverviewだけを表示する
    （個別の観察はA〜D各セクションのAI Insightに分散させているため、ここでは
    箇条書きは持たない）。"""
    overview = esc(commentary.get("overview", ""))
    return f"""
    <section class="ai-summary">
      <h2><span class="ai-badge">AI</span> Analysis Summary</h2>
      <p>{overview}</p>
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
    daily_volume: dict[str, int] | None = None,
    hourly_volume: dict | None = None,
    proximity_data: dict | None = None,
    long_tail: dict[str, dict] | None = None,
    ai_commentary: dict | None = None,
    classification_breakdown: dict | None = None,
    poi_taxonomy_breakdown: dict[str, dict] | None = None,
    address_structure_breakdown: dict | None = None,
    brand_breakdown: dict | None = None,
) -> str:
    insights = ai_commentary.get("insights") if ai_commentary else None

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

  .ai-insight {{
    display: flex; align-items: baseline; gap: 8px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-left: 3px solid var(--series-1, #2a78d6); border-radius: 6px;
    padding: 8px 12px; margin: 0 0 12px; font-size: 0.875rem; color: var(--text-primary);
  }}
  .ai-insight .ai-badge {{ flex-shrink: 0; }}

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
  .hbar-chart-scroll {{ max-height: 480px; overflow-y: auto; }}

  /* 2026-08-29、H/I/J/K内訳セクションの棒グラフ・データテーブルを最大4列の
     段組みにする（project memory参照。項目数が多いと縦に長くて見づらいとの
     指摘への対応。列数は_split_into_columnsが決めた実際の列数をインライン
     styleの--breakdown-colsで渡す）。 */
  .hbar-chart-grid {{ display: grid; grid-template-columns: repeat(var(--breakdown-cols, 4), 1fr); gap: 4px 20px; align-items: start; }}
  .hbar-col {{ display: flex; flex-direction: column; min-width: 0; }}
  .data-table-grid {{ display: grid; grid-template-columns: repeat(var(--breakdown-cols, 4), 1fr); gap: 0 16px; margin-top: 12px; }}
  .data-table-grid .data-table {{ margin-top: 0; }}

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
  {render_daily_volume_section(daily_volume) if daily_volume else ""}
  {render_hourly_volume_section(hourly_volume) if hourly_volume else ""}
  {render_proximity_prefecture_section(proximity_data) if proximity_data else ""}
  {render_top_queries_section(top_queries, order, top_n, insights=insights)}
  {render_daily_category_section(daily, order, insight=insights.get("daily_trend") if insights else None)}
  {render_column_usage_section(usage, insight=insights.get("column_usage") if insights else None)}
  {render_long_tail_section(long_tail, order, insight=insights.get("long_tail") if insights else None) if long_tail else ""}
  {_render_breakdown_section(
      "classification-breakdown", "H. Classification Breakdown",
      "Count and share of total for each ai_classification value (poi/address/semantic_query/unknown).",
      classification_breakdown,
  ) if classification_breakdown else ""}
  {render_poi_taxonomy_section(poi_taxonomy_breakdown) if poi_taxonomy_breakdown else ""}
  {_render_breakdown_section(
      "address-structure-breakdown", "J. Address Structure Breakdown",
      "Rows classified as address only, broken down by granularity "
      "(region/place/locality/neighborhood/address) as a count and share of the address total.",
      address_structure_breakdown,
  ) if address_structure_breakdown else ""}
  {_render_breakdown_section(
      "brand-breakdown", "K. Brand Breakdown",
      "Rows classified as brand_poi only, broken down by the matched brand name "
      "(ai_classification_2_brand) as a count and share of the brand_poi total.",
      brand_breakdown,
  ) if brand_breakdown else ""}
</main>
</body>
</html>
"""
