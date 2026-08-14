"""
main.py analyze-ai サブコマンドが使う、クエリ傾向のAIコメンタリー生成ロジック。

鉄則: AIへの入力は必ず、analyze相当の集計結果（カテゴリ別頻出クエリ・
日別カテゴリ推移・列指定率クロス集計の要約）のみ。入力CSVの生データ
（各行のqueryやdatetimeの全件など）は一切AIに渡さない。
集計自体はlib/analyze_trends.pyの既存関数（compute_top_queries等）を
そのまま使う（この集計はPython側のETLであり、AI呼び出しではない）。

モデルはClaude Sonnet 5（プロキシ経由）。
"""

import json
import urllib.error
import urllib.request

from lib.classification_common import parse_response_text

MODEL = "claude-sonnet-5"
PROXY_URL = "https://okqfpyxf4oe6htegrlcgrwdssa0yoxcr.lambda-url.us-east-1.on.aws/"

SYSTEM_PROMPT = """You are a data analyst reviewing aggregated search query log statistics.
You will receive a JSON summary with three parts:
  - top_queries_by_category: the most frequent queries per classification category
  - daily_category_counts: query counts per category per date
  - column_usage_rate: how often bbox/proximity/near were specified, per category

Write a short analysis of query trends based only on this summary. Respond with a
JSON object with exactly two keys:
  "overview": a 1-2 sentence summary of the overall picture
  "highlights": a list of 3-6 short bullet-point strings, each one concrete
    observation (a trend, spike, imbalance, or notable correlation) grounded in
    the numbers given

Respond in English. Output JSON only, no markdown code fences, no extra text.
"""


def build_summary_payload(
    order: list[str],
    top_queries: dict[str, list[tuple[str, int]]],
    daily: dict[str, dict[str, int]],
    usage: dict[str, dict[str, int]],
    top_n_for_ai: int = 10,
) -> dict:
    """AIに渡す要約データを組み立てる。渡すのはこの関数が返す集計結果だけで、
    元CSVの生データ（行そのもの）は含めない。"""
    dates = sorted(daily.keys())

    top_queries_summary = {
        category: [{"query": q, "count": c} for q, c in top_queries.get(category, [])[:top_n_for_ai]]
        for category in order
    }

    daily_summary = {date: {category: daily[date].get(category, 0) for category in order} for date in dates}

    usage_summary = {}
    for category in order:
        stats = usage.get(category, {"total": 0, "bbox": 0, "proximity": 0, "near": 0})
        total = stats.get("total", 0)
        usage_summary[category] = {
            "total": total,
            "bbox_rate_pct": round(stats.get("bbox", 0) / total * 100, 1) if total else 0.0,
            "proximity_rate_pct": round(stats.get("proximity", 0) / total * 100, 1) if total else 0.0,
            "near_rate_pct": round(stats.get("near", 0) / total * 100, 1) if total else 0.0,
        }

    return {
        "categories": order,
        "date_range": {"from": dates[0], "to": dates[-1]} if dates else {},
        "top_queries_by_category": top_queries_summary,
        "daily_category_counts": daily_summary,
        "column_usage_rate": usage_summary,
    }


def generate_commentary(summary_payload: dict) -> dict:
    """要約データをLLMに送り、{"overview": str, "highlights": [str, ...]} を返す。"""
    body = {
        "model": MODEL,
        "max_tokens": 2048,
        # temperatureはこのモデル(Sonnet 5)では非推奨のパラメータで、指定すると
        # 400 invalid_request_errorになる（Haiku用のai_classify.pyでは許容されるが
        # 揃えて渡さない。詳細はモデルごとの対応状況次第）
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": json.dumps(summary_payload, ensure_ascii=False)}],
    }

    req = urllib.request.Request(
        PROXY_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            data = json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # プロキシ/Anthropic側が返す実際のエラー本文（モデル拒否・クレジット不足等の
        # 具体的な理由）を握りつぶさずに例外メッセージへ含める
        error_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} {e.reason}: {error_body}") from e

    content_blocks = data.get("content") or []
    text = "".join(b.get("text", "") for b in content_blocks if b.get("type") == "text")
    text = parse_response_text(text)

    # strict=False: "overview"/"highlights"の文中に生の改行等の制御文字が
    # そのまま混じっていても許容してパースする（strict=Trueだと
    # "Unterminated string" エラーになるケースがあった）
    result = json.loads(text, strict=False)
    if not isinstance(result, dict) or "overview" not in result or "highlights" not in result:
        raise ValueError(f"LLM応答の形式が不正です: {result!r}")

    return result
