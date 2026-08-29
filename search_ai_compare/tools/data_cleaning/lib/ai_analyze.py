"""
main.py analyze サブコマンド（--with-ai-commentary）が使う、クエリ傾向のAIコメンタリー
生成ロジック。

鉄則: AIへの入力は必ず、analyze相当の集計結果（カテゴリ別頻出クエリ・
日別カテゴリ推移・列指定率クロス集計・ロングテール分布の要約）のみ。入力CSVの
生データ（各行のqueryやdatetimeの全件など）は一切AIに渡さない。集計自体は
lib/analyze_trends.pyの既存関数（compute_top_queries等）をそのまま使う
（この集計はPython側のETLであり、AI呼び出しではない）。

モデルはSonnet固定（classification_common.ANALYZE_MODEL、2026-08-27にCLI/GUIの
モデル選択を廃止）。
2026-08-25、プロキシ経由の呼び出しを廃止し、本物のAnthropic API（要ANTHROPIC_API_KEY
または--token）を直接叩く方式に変更（ai-classify --batch-api等と同じくanthropicパッケージ
を使用。main.pyのensure_batch_api_venv_and_reexec()が--with-ai-commentary指定時にも
venvへの自動インストールを行う）。

出力は2種類:
  - overview: レポート冒頭に載せる2〜3行の全体サマリー
  - insights: A/B/C/D各セクションに埋め込む短いコメンタリー
      top_queries_overall        : Aセクション全体への一言
      top_queries_by_category    : カテゴリごとの一言（{category: str}）
      daily_trend                : Bセクション全体への一言
      column_usage                : Cセクション全体への一言
      long_tail                   : Dセクション全体への一言
"""

import json

from lib.classification_common import ANALYZE_MODEL, parse_response_text

MODEL = ANALYZE_MODEL

SYSTEM_PROMPT = """You are a data analyst reviewing aggregated search query log statistics.
You will receive a JSON summary with four parts:
  - top_queries_by_category: the most frequent queries per classification category
  - daily_category_counts: query counts per category per date
  - column_usage_rate: how often each request parameter (bbox, proximity,
    poi_category, poi_category_exclusions, near, navigation_profile) was specified,
    across all queries (not split by category)
  - long_tail_distribution: for the whole dataset and per category, how total search
    volume breaks down by how often each query repeats (buckets like "1000+", "1")

Write short, concrete observations grounded only in the numbers given. Use plain,
simple, concise English — short sentences, no jargon, no filler words.

Write everything in English, with no exceptions. The input data (query strings,
category names) is in Japanese because the underlying dataset is Japanese search
queries — you may quote a Japanese query string verbatim if needed, but every
sentence you write, and every key/value you generate other than direct quotes of
the data, must be in English.

Respond with a JSON object with exactly these keys:
  "overview": 2-3 short sentences summarizing the overall picture across everything.
  "insights": an object with exactly these keys:
    "top_queries_overall": 1 short sentence about frequent queries overall.
    "top_queries_by_category": an object with one short sentence for EACH category
      listed in "categories" (use the exact category names as keys), about that
      category's frequent queries.
    "daily_trend": 1 short sentence about the daily category trend.
    "column_usage": 1 short sentence about which parameters are used most and
      least often.
    "long_tail": 1 short sentence about the long-tail distribution (what share of
      volume comes from rarely-repeated queries).

Output JSON only, no markdown code fences, no extra text.
"""


def build_summary_payload(
    order: list[str],
    top_queries: dict[str, list[tuple[str, int]]],
    daily: dict[str, dict[str, int]],
    usage: dict,
    long_tail: dict[str, dict],
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

    total = usage.get("total", 0)
    counts = usage.get("counts", {})
    usage_summary = {
        col: {
            "count": counts.get(col, 0),
            "rate_pct": round(counts.get(col, 0) / total * 100, 1) if total else 0.0,
        }
        for col in counts
    }

    long_tail_summary = {}
    for scope, data in long_tail.items():
        long_tail_summary[scope] = {
            label: {"unique_queries": b["unique_queries"], "volume_pct": round(b["volume_pct"], 1)}
            for label, b in data["buckets"].items()
        }

    return {
        "categories": order,
        "date_range": {"from": dates[0], "to": dates[-1]} if dates else {},
        "top_queries_by_category": top_queries_summary,
        "daily_category_counts": daily_summary,
        "column_usage_rate": usage_summary,
        "long_tail_distribution": long_tail_summary,
    }


def generate_commentary(summary_payload: dict, model: str = MODEL, api_key: str | None = None) -> dict:
    """要約データをLLMに送り、{"overview": str, "insights": {...}} を返す。

    本物のAnthropic API（anthropicパッケージ）を直接叩く。api_keyを渡すと
    ANTHROPIC_API_KEY環境変数の代わりにそれを使う（ai_classify_batch.classify_unique
    と同じ流儀）。anthropicパッケージが未インストールの環境ではImportErrorを送出する
    （呼び出し元のmain.py cmd_analyzeが警告表示してコメンタリーなしにフォールバックする）。
    """
    import anthropic

    client = anthropic.Anthropic(api_key=api_key) if api_key else anthropic.Anthropic()

    kwargs: dict = {}
    # temperatureはSonnet 5では非推奨パラメータで、指定すると400 invalid_request_error
    # になる（ai_classify.pyのcall_claudeと同じ理由）。haiku指定時のみ付与する。
    if "haiku" in model:
        kwargs["temperature"] = 0

    try:
        response = client.messages.create(
            model=model,
            max_tokens=2048,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": json.dumps(summary_payload, ensure_ascii=False)}],
            **kwargs,
        )
    except anthropic.APIStatusError as e:
        # Anthropic側が返す実際のエラー内容（モデル拒否・クレジット不足・認証エラー等の
        # 具体的な理由）を握りつぶさずに例外メッセージへ含める
        raise RuntimeError(f"HTTP {e.status_code}: {e.message}") from e

    text = "".join(b.text for b in response.content if b.type == "text")
    text = parse_response_text(text)

    # strict=False: overview/insightsの文中に生の改行等の制御文字が
    # そのまま混じっていても許容してパースする（strict=Trueだと
    # "Unterminated string" エラーになるケースがあった）
    result = json.loads(text, strict=False)
    if not isinstance(result, dict) or "overview" not in result or "insights" not in result:
        raise ValueError(f"LLM応答の形式が不正です: {result!r}")

    return result
