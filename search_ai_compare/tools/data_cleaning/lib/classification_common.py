"""
query分類タスクで共有するカテゴリ定義・プロンプト生成ロジック。

classify_queries.py（プロキシ経由・並行処理版）と
classify_queries_batch.py（Anthropic Message Batches API版）の
両方から import される。番号↔カテゴリの対応をここ1箇所だけに集約することで、
プロンプト文言とPython側マッピングがズレる事故を防ぐ。
"""

MODEL = "claude-haiku-4-5-20251001"

# 番号→カテゴリ名。出力トークン削減のため、LLMにはカテゴリ名の文字列ではなく
# この番号（1〜7の整数）だけを返させる。
CATEGORIES: dict[int, str] = {
    1: "poi",
    2: "poi_brand",
    3: "poi_category",
    4: "address",
    5: "unsupported_query_location_intent",
    6: "broken_query",
    7: "others",
}

CATEGORY_DESCRIPTIONS: dict[int, str] = {
    1: '具体的な地点・施設の固有名詞。知らない店舗名・施設名であっても、'
    '文法的に固有の場所を指す名詞として成立していればここに含める。例: "東京駅"',
    2: 'チェーン店・ブランド名。例: "セブンイレブン"',
    3: '地点の種別・カテゴリ名。例: "コンビニ", "バス停", "駐車場"',
    4: '住所表記。市区町村・字・丁目・番地など、数字を伴う地番パターンを含むもの。例: "常盤32-10"',
    5: '複数の位置意図が混在した複合クエリ。例: "セブンイレブン 東京駅"',
    6: '表記が崩れており検索クエリとして成立していないもの。例: "常盤32-09セブンイレブン"',
    7: "上記いずれにも当てはまらない、または判定不能なもの",
}


def build_system_prompt() -> str:
    lines = [
        f"- {n}: {CATEGORIES[n]} — {CATEGORY_DESCRIPTIONS[n]}"
        for n in sorted(CATEGORIES)
    ]
    category_list = "\n".join(lines)
    example_numbers = ", ".join(str(n) for n in list(CATEGORIES)[:3])
    return f"""あなたは検索クエリの分類器です。与えられた検索クエリの配列を、以下の7カテゴリのいずれか1つに分類してください。

{category_list}

判定の優先順位: 7(others)は「本当にどれにも当てはまらない場合」の最終手段であり、
自信が持てないことを理由に安易に選ばない。固有名詞らしき文字列はまず1(poi)に
当てはまらないか、数字を伴う地番パターンを含む文字列はまず4(address)に
当てはまらないかを優先的に検討すること。知らない・聞いたことがない名前だからと
いって7(others)に倒さない。

出力は必ず、入力配列と同じ順序・同じ要素数のJSON配列のみを返してください。
各要素は上記カテゴリ番号（1〜7の整数）のいずれか1つです。カテゴリ名の文字列ではなく、必ず数字で返してください。
説明文やコードフェンスは一切含めず、JSON配列のみを出力してください。
例: [{example_numbers}]
"""


SYSTEM_PROMPT = build_system_prompt()


def numbers_to_labels(numbers: list) -> list[str]:
    """LLMが返した番号配列をカテゴリ名配列に変換する。
    マッピングにない値（想定外の数字・文字列混入等）は others 扱い。"""
    return [CATEGORIES.get(n, "others") for n in numbers]


def parse_response_text(text: str) -> str:
    """```json ... ``` のようなコードフェンスが付いた場合に備えて除去する。"""
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    return text
