"""
query分類タスクで共有するカテゴリ定義・プロンプト生成ロジック。

classify_queries.py（プロキシ経由・並行処理版）と
classify_queries_batch.py（Anthropic Message Batches API版）の
両方から import される。番号↔カテゴリの対応をここ1箇所だけに集約することで、
プロンプト文言とPython側マッピングがズレる事故を防ぐ。

分類は3階層(2026-08-25、旧poi/poi_brand/poi_category/address/
unsupported_query_location_intent/broken_query/othersの7分類から全面刷新):
  - ai_classification   : poi / address / semantic_query / unknown
  - ai_classification_2 : ai_classificationがpoiならunique_poi/brand_poi/category、
                           addressならregion/place/locality/neighborhood/address
  - ai_classification_3 : ai_classification_2がunique_poi/brand_poi/categoryの時のみ、
                           category-taxonomy.js（CATEGORY_TAXONOMY）の285リーフの
                           うち当てはまるものを1つ以上（複数可、一字一句一致）。
                           CSV上は"|"区切りで連結した文字列として1列に格納する。
                           該当するリーフが本当に1つも無い場合のみ"unknown"
                           （285リーフには存在しない、判定不能を表す唯一の許可値）。
                           （2026-08-26、brand_poi限定・単一選択だった旧仕様から
                           unique_poi/categoryも対象＆複数選択可に変更）

brand_data.BRAND_CATEGORY_MAP（Wikipedia等を元にしたブランド→taxonomyリーフの
辞書、search_ai_compare/local/category_and_brand/poi-blocklist.js）をプロンプトに
埋め込み、brand_poi判定とai_classification_3の精度向上のための参照情報としてLLMに渡す。
"""

import json

from lib import brand_data

# デフォルトモデル。ai-classify系サブコマンドは --model haiku|sonnet で切り替え可能
# （MODEL_CHOICESを参照）。ここは後方互換のためhaikuのまま残す。
MODEL = "claude-haiku-4-5-20251001"

# main.pyの --model 引数(haiku/sonnet)からモデルIDへの変換テーブル
MODEL_CHOICES: dict[str, str] = {
    "haiku": "claude-haiku-4-5-20251001",
    "sonnet": "claude-sonnet-5",
}

# ai_classification（トップレベル）の番号→カテゴリ名。ai-retryの--categoryの
# 選択肢としても使う（main.py参照）。
CATEGORIES: dict[int, str] = {
    1: "poi",
    2: "address",
    3: "semantic_query",
    4: "unknown",
}

CATEGORY_DESCRIPTIONS: dict[int, str] = {
    1: "現実世界の具体的な地点・施設を指すクエリ（固有名詞・チェーン店名・業種を表す"
    "一般名詞のいずれでもよい）。例: \"東京タワー\", \"ローソン\", \"コンビニ\"",
    2: "住所表記。都道府県・市区町村・字・丁目・番地など、行政区分や地番を表す文字列。"
    "例: \"常盤32-10\", \"港区六本木\"",
    3: "本体となる場所・ブランド名・カテゴリ語に、それを特定・絞り込むための補助的な"
    "文脈（地名・業種語など）が付加されており、全体として単一の場所を特定できる"
    "クエリ。例: \"清水寺 京都\"（一意の施設名+所在都道府県で確認補強）、"
    "\"コメダ カフェ\"（ブランド名+業種語で確認補強）。単一の意図に絞れる限り、"
    "文字列の見た目が複合的でもここに含める。",
    4: "表記が崩れている、異なる複数の候補が並記されていてどちらを探しているか"
    "特定できない、または上記いずれにも当てはまらず判定不能なもの。"
    "例: \"コメダ喫茶、スタバ\"（複数ブランドが並記され、どちらを探したいか不明）。",
}

# ai_classification_2（poiの場合）の番号→サブカテゴリ名
POI_SUBTYPES: dict[int, str] = {
    1: "unique_poi",
    2: "brand_poi",
    3: "category",
}

POI_SUBTYPE_DESCRIPTIONS: dict[int, str] = {
    1: "現実世界に一意にしか存在しない、単一の地点・施設を指す固有名詞。同一名称の拠点が"
    "他の場所にも複数展開されている場合はここに含めず2(brand_poi)にする"
    "（直営店かフランチャイズかという経営形態は無関係で、「同名拠点が複数存在するか」"
    "だけが基準）。知らない店舗名・施設名であっても、一意の場所を指す固有名詞として"
    "成立していればここに含める。例: \"東京タワー\", \"六本木ヒルズ\"",
    2: "同一名称の拠点が複数箇所に存在する企業・ブランド名。単独の店名として書かれていても、"
    "それが複数拠点展開されている名称であれば必ずこちら。直営店か"
    "フランチャイズかという経営形態は判定基準にしない（例: スターバックスは"
    "全店直営だが複数拠点展開のためbrand_poi）。"
    "例: \"ローソン\", \"セブンイレブン\", \"スターバックス\"",
    3: "地点の種別・カテゴリを表す一般名詞（固有名詞ではない）。例: \"コンビニ\", \"バス停\", \"駐車場\"",
}

# ai_classification_2（addressの場合）の番号→サブカテゴリ名
ADDRESS_SUBTYPES: dict[int, str] = {
    1: "region",
    2: "place",
    3: "locality",
    4: "neighborhood",
    5: "address",
}

ADDRESS_SUBTYPE_DESCRIPTIONS: dict[int, str] = {
    1: "都道府県レベル。例: \"東京都\", \"大阪府\"",
    2: "市区町村レベル。例: \"渋谷区\", \"横浜市\"",
    3: "字・大字・町名レベル（市区町村より細かいが、丁目より粗い）。例: \"六本木\"",
    4: "丁目レベル。例: \"六本木6丁目\"",
    5: "番地・号を含む最も細かいレベル。例: \"六本木6丁目10番1号\", \"常盤32-10\"",
}

# 境界事例の判定指針（1と2、poiとaddressの間で迷うケース）
BOUNDARY_GUIDANCE = """
判定の優先順位: 4(unknown)は「本当にどれにも当てはまらない場合」の最終手段であり、
自信が持てないことを理由に安易に選ばない。固有名詞らしき文字列はまず1(poi)に
当てはまらないか、数字を伴う地番パターンを含む文字列はまず2(address)に
当てはまらないかを優先的に検討すること。知らない・聞いたことがない名前だからと
いって4(unknown)に倒さない。

表記正規化: 判定・BRAND_KNOWLEDGE照合を行う前に、クエリがカタカナ・ひらがな・
ローマ字（例: "seven eleven"）等の表記ゆれを含んでいないか確認し、該当ブランド・
施設の標準的な書き表し方（例: "セブンイレブン"）に正規化した上で判定すること。

1(poi)のサブカテゴリ判定基準: 同一名称の拠点が複数箇所に展開されている
（直営店・フランチャイズいずれでもよく、経営形態は無関係。「同名拠点が複数存在する
かどうか」だけが基準）と判断できる場合は、単独の店名としてクエリに書かれていても
必ずbrand_poiにする。unique_poiは「その名前を持つ場所が現実には1箇所しか存在
しない」固有名詞のみに限定すること。

境界事例（unique_poiとbrand_poiの判定に迷う場合の指針）: ブランド名の後ろに支店名・
地名・「店」が付加されているクエリ（例: "ローソン浜松高塚店", "セブンイレブンこまち店",
"すき家 段原店"）は、ブランド名部分だけで独立した企業として認識できるなら、
支店名が付いていても必ずbrand_poi。逆に、業種を表す接尾辞（歯科・内科・医院・
ホテル・美容室等）が付いていても、それ単体では複数拠点展開の企業として認識できない
地域固有の屋号（例: "土居田町ほりうち歯科", "唐津ホテル"）はunique_poiのまま。
判断軸は接尾辞の種類ではなく、ブランド部分が複数拠点展開している独立した企業か
どうかの有無。

brand_poi判定には、以下に埋め込んだBRAND_KNOWLEDGE（ブランド名→taxonomyカテゴリの
参照データ）を積極的に使うこと。ここに載っているブランド名（表記が完全一致する場合に
限らず、支店名・「店」等が付加された形も含む）はbrand_poiと判定する。
BRAND_KNOWLEDGEに無いブランドでも、モデル自身の知識で複数拠点展開している
ブランドだと判断できる場合はbrand_poiにしてよい。

同じブランドが複数の異なるクエリ文字列（支店名付き・省略形など）で登場する場合、
実行のたびに違う判定にならないよう、判断に迷ったときはBRAND_KNOWLEDGEの値を優先する。
"""

ADDRESS_GUIDANCE = """
address（poi以外の住所表記）のサブカテゴリは、番地・号まで含む最も細かい表記なら
address、丁目までならneighborhood、字・町名レベルならlocality、市区町村レベルなら
place、都道府県レベルならregionを選ぶこと。複数レベルが1クエリに混在する場合は、
クエリに含まれる最も細かいレベルを採用する（例: "港区六本木6丁目"はneighborhood）。
"""

CATEGORY_3_GUIDANCE = """
ai_classification_3は、ai_classification_2がunique_poi・brand_poi・categoryの
いずれかの場合に必ず設定する（address・semantic_query・unknownでは常に空配列[]）。
「わからない」を理由に空配列で済ませてはならない。値は文字列の配列で返し、各要素は
以下に列挙するCATEGORY_TAXONOMYのリーフ文字列のいずれか1つと一字一句完全に一致
する値でなければならない（存在しない値・近似した値を作り出さない。ハルシネーション
禁止）。該当するリーフがどうしても1つも見つからない場合のみ、配列に文字列
"unknown"を1つだけ入れて返す（taxonomyには存在しないが、「判定不能」を表す
唯一の許可された値）。

複数選択可: 対象のPOI・ブランド・カテゴリ語が複数の商品・サービス領域にまたがる
場合、当てはまるリーフを複数選んでよい（例: ユニクロはメンズ・レディース・子供服の
いずれも扱っているので、taxonomyに対応する3つのリーフ全部を選ぶ）。

ただし複数選択を安易な拡大解釈の免罪符にしないこと。1つのリーフを採用するには
以下の両方向の連想が成立する必要がある（片方向だけでは不十分）:
  (a) 順方向: そのPOI・ブランドを知っている人が自然に思い浮かべる商品・サービスに、
      そのリーフが含まれる。
  (b) 逆方向: そのリーフで検索する人が、このPOI・ブランドが結果に出てきたら妥当だと
      感じる（無関係・的外れではない）。
両方が成立する具体的なリーフが1つ以上存在するなら、そちらを優先して選び、"ショップ"
のような抽象度の高い最上位カテゴリだけで済ませない（最上位カテゴリは、具体的なリーフ
が本当に1つも当てはまらない場合の最終手段としてのみ使う）。
"""


def build_system_prompt() -> str:
    cat1_lines = "\n".join(
        f"- {n}: {CATEGORIES[n]} — {CATEGORY_DESCRIPTIONS[n]}" for n in sorted(CATEGORIES)
    )
    poi_lines = "\n".join(
        f"  - {n}: {POI_SUBTYPES[n]} — {POI_SUBTYPE_DESCRIPTIONS[n]}" for n in sorted(POI_SUBTYPES)
    )
    address_lines = "\n".join(
        f"  - {n}: {ADDRESS_SUBTYPES[n]} — {ADDRESS_SUBTYPE_DESCRIPTIONS[n]}"
        for n in sorted(ADDRESS_SUBTYPES)
    )
    taxonomy_json = json.dumps(brand_data.CATEGORY_TAXONOMY, ensure_ascii=False)
    brand_json = json.dumps(brand_data.BRAND_CATEGORY_MAP, ensure_ascii=False, separators=(",", ":"))

    return f"""あなたは検索クエリの分類器です。与えられた検索クエリの配列を、以下の3階層で分類してください。

このクエリログは、タクシー配車事業者のオペレーターが電話で乗客から聞いた場所の
説明を検索APIにクエリ化したものです。乗客本人の入力ではなく、オペレーターが
聞き取った内容を解釈・言い換えてクエリ化し、検索結果を見ながら会話で場所を
絞り込んでいく運用のため、生の音声認識結果のような崩れ方とは性質が異なります。

## 第1階層（ai_classification、必須・4カテゴリ）
{cat1_lines}

## 第2階層（ai_classification_2）
- ai_classificationが1(poi)の場合、以下から1つ:
{poi_lines}
- ai_classificationが2(address)の場合、以下から1つ:
{address_lines}
- ai_classificationが3(semantic_query)または4(unknown)の場合: 該当なし（0を返す）

## 第3階層（ai_classification_3）
{CATEGORY_3_GUIDANCE}
CATEGORY_TAXONOMY（この配列の文字列以外は使用禁止）:
{taxonomy_json}

{BOUNDARY_GUIDANCE}
{ADDRESS_GUIDANCE}

## BRAND_KNOWLEDGE（ブランド名→taxonomyリーフの参照データ。出典はWikipedia等の一般情報。
空配列は「ブランドとして認識してよいが対応するtaxonomyカテゴリが無い」ことを意味する）
{brand_json}

## 出力形式
入力配列と同じ順序・同じ要素数のJSON配列のみを返してください。各要素は
[ai_classification番号, ai_classification_2番号(該当なしは0), ai_classification_3の配列
(該当なしは空配列[]、該当するリーフが1つも無い場合は["unknown"])]
という3要素の配列です。ai_classification_3は必ず配列で返すこと（1件でも複数でも
配列。文字列を直接入れない）。説明文やコードフェンスは一切含めず、JSON配列のみを
出力してください。
例: [[1,2,["ショップ>コンビニ"]], [1,2,["ショップ>ファッション(女性)","ショップ>ファッション(男性)","ショップ>子ども服"]], [2,5,[]], [4,0,[]]]
"""


SYSTEM_PROMPT = build_system_prompt()


# ai_classification_3をCSVの1セルに複数値で格納する際の区切り文字。
# category-taxonomy.jsの285リーフに"|"を含む値は存在しないため衝突しない。
LEAF_DELIMITER = "|"

# taxonomyに存在しないが、「該当するリーフが1つも見つからない」ことを表す
# ために唯一許可されたai_classification_3の値。
UNKNOWN_LEAF = "unknown"


def decode_triplet(item) -> tuple[str, str, str]:
    """LLMが返した1件分の [c1, c2, c3] を (ai_classification, ai_classification_2,
    ai_classification_3) の文字列3つ組に変換する。c3はリーフ文字列の配列
    （複数可、該当なしは[]、判定不能は["unknown"]）で受け取り、taxonomyに存在する
    値のみを残して重複を除いた上で LEAF_DELIMITER 区切りの1文字列に連結する
    （CSVの1セルに収めるため）。形式が不正・値が範囲外の場合はunknown側に
    フォールバックし、フィルタ後に何も残らなければUNKNOWN_LEAFにフォールバックする。"""
    try:
        c1, c2, c3 = item
    except (ValueError, TypeError):
        return "unknown", "", ""

    classification = CATEGORIES.get(c1)
    if classification is None:
        return "unknown", "", ""

    if classification == "poi":
        sub = POI_SUBTYPES.get(c2, "")
    elif classification == "address":
        sub = ADDRESS_SUBTYPES.get(c2, "")
    else:
        sub = ""

    if sub in ("unique_poi", "brand_poi", "category"):
        # 旧形式（単一文字列）が来ても壊れないようにフォールバックしておく。
        if isinstance(c3, str):
            raw_leaves = [c3]
        elif isinstance(c3, list):
            raw_leaves = c3
        else:
            raw_leaves = []

        deduped: list[str] = []
        seen: set[str] = set()
        for leaf in raw_leaves:
            if not isinstance(leaf, str):
                continue
            if leaf != UNKNOWN_LEAF and leaf not in brand_data.CATEGORY_TAXONOMY_SET:
                continue  # ハルシネーション（taxonomyに存在しない値）は捨てる
            if leaf not in seen:
                seen.add(leaf)
                deduped.append(leaf)

        leaf_str = LEAF_DELIMITER.join(deduped) if deduped else UNKNOWN_LEAF
    else:
        leaf_str = ""

    return classification, sub, leaf_str


def decode_triplets(items: list) -> list[tuple[str, str, str]]:
    return [decode_triplet(item) for item in items]


def parse_response_text(text: str) -> str:
    """```json ... ``` のようなコードフェンスが付いた場合に備えて除去する。"""
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    return text
