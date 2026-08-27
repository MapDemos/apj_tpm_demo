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
                           category-taxonomy.js（CATEGORY_TAXONOMY）に当てはまるものを
                           1つ以上（一字一句一致）。CSV上は"|"区切りで連結した文字列
                           として1列に格納する。該当するものが本当に1つも無い場合のみ
                           "unknown"（taxonomyには存在しない、判定不能を表す唯一の
                           許可値）。
                           （2026-08-26、brand_poi限定・単一選択だった旧仕様から
                           unique_poi/categoryも対象＆複数選択可に変更。2026-08-27、
                           旧・階層的で285件と細かすぎたtaxonomyを45件のフラットな
                           単一カテゴリに刷新し、通常は1要素で済む設計に戻した
                           ―複数選択の仕組み自体はまだ残っているが例外的な扱い）

brand_data.BRAND_CATEGORY_MAP（Wikipedia等を元にしたブランド→taxonomyカテゴリの
辞書、data_cleaning/local/category_and_brand/poi-blocklist.js）をプロンプトに
埋め込み、brand_poi判定とai_classification_3の精度向上のための参照情報としてLLMに渡す。
ただしBRAND_KNOWLEDGE自体が実際に役立つのはbrand_poi判定時だけなので、
ai_classification_3用のプロンプトはbrand_poi用（埋め込みあり）とunique_poi/category用
（埋め込みなし、軽量）の2種類に分けている（2026-08-27、build_system_prompt_level3
参照。以前はsubtypeを問わず全バッチに無条件で埋め込んでいた）。

2026-08-27、LLM応答の要素数が入力とズレて頻発していた問題への対策として、
入出力の各要素に0始まりのインデックスを付与する方式に変更した（配列の「位置」
だけで入出力を対応付けていたため、LLMが1件飛ばす・多く返すなどしただけで
バッチ全体を個別リトライせざるを得なかった。build_level12_user_content/
build_level3_user_content、decode_indexed_level12_responses/
decode_indexed_leaf_responses参照）。
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

# main.pyの --model 引数の選択肢（2026-08-26、2段階分離方式の導入に伴い追加）。
# 値は (ai_classification/_2に使うモデル, ai_classification_3に使うモデル) のペア。
# "haiku+sonnet"が既定の推奨構成（安いHaikuで済む部分と、taxonomy精度が必要な
# ai_classification_3だけSonnetに分ける。project memory参照）。"haiku"/"sonnet"は
# 両階層を同じモデルで統一したい場合の比較・検証用の選択肢。
MODEL_PRESETS: dict[str, tuple[str, str]] = {
    "haiku": (MODEL_CHOICES["haiku"], MODEL_CHOICES["haiku"]),
    "sonnet": (MODEL_CHOICES["sonnet"], MODEL_CHOICES["sonnet"]),
    "haiku+sonnet": (MODEL_CHOICES["haiku"], MODEL_CHOICES["sonnet"]),
}


def model_preset_label(preset: str) -> str:
    """CLI/GUIの表示用に、プリセット名と実際のモデルIDを両方含む説明文を組み立てる
    （「haikuを選んだつもりが実は内部でSonnetも動いている」という誤解を防ぐため）。"""
    level12_model, level3_model = MODEL_PRESETS[preset]
    if level12_model == level3_model:
        return f"{preset}（{level12_model}）"
    return f"{preset}（ai_classification/_2: {level12_model} + ai_classification_3: {level3_model}）"

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
    3: "ブランド名+支店識別子（それ自体がPOIの正式名称の一部であるもの）を除き、"
    "本体となるPOI名・ブランド名・カテゴリ語だけでは同名・同種の候補が複数あり得て"
    "一意に特定できない場合に、それを絞り込む・特定するのに役立つ付随情報"
    "（地名・業種語など）が付加されているクエリ。例: \"清水寺 京都\"（同名の寺が"
    "全国に複数あるため所在都道府県で絞り込み）、\"コメダ カフェ\"（曖昧な名称を"
    "業種語で絞り込み）。本体自体が単体で完結しており絞り込む余地がない場合や、"
    "支店識別子がブランド名と一体化してPOIの正式名称を構成している場合はここに"
    "含めない（詳細はSEMANTIC_QUERY_GUIDANCE参照）。",
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

# BOUNDARY_GUIDANCEからBRAND_KNOWLEDGE参照部分（下2段落）を除いたもの。
# ai_classification_3を判定しない軽量プロンプト（build_system_prompt_level12、
# 2026-08-26のHaiku/Sonnet 2段階分離で新設）専用。BRAND_KNOWLEDGE(1500件超の辞書)を
# 埋め込まないため、それを参照する指示文だけ残すと意味不明になるので削っている。
BOUNDARY_GUIDANCE_LEVEL12 = BOUNDARY_GUIDANCE.rsplit("\n\nbrand_poi判定には、", 1)[0] + "\n"

# brand_match.find_candidates()による機械的な文字列部分一致（表記体系をまたぐ
# カタカナ/ひらがな/ローマ字変換込み。lib/kana_match.py参照）で検出したブランド名
# 候補を、呼び出し元(classify_unique)が一部のクエリにだけ付随させて渡す場合の
# 取り扱いを指示する（2026-08-27新設）。BRAND_KNOWLEDGE本体（1500件超）は
# レベル1/2の軽量プロンプトには埋め込まないが、機械的に絞り込んだ少数の候補
# だけなら軽量に渡せる。「候補があるのに見ずに自分の知識だけで判断してしまう」
# ことを防ぐため、出力形式側（この下）で候補ありの要素だけ4要素配列を必須にし、
# 構造的に候補への言及を強制する（末尾要素を省略した応答はデコード失敗として
# その1件だけが個別リトライに回る。インデックス方式の詳細はbuild_level12_user_content
# 参照）。
BRAND_CANDIDATE_GUIDANCE = """
一部のクエリには、機械的な文字列部分一致（表記ゆれ・カタカナ/ひらがな/ローマ字の
変換込み）で検出した既知ブランド名の候補が付随している場合がある。その場合、入力
配列のその要素は[インデックス, クエリ文字列]ではなく[インデックス, クエリ文字列,
[候補1, 候補2, ...]]という3要素配列になっている（候補が無い要素は
[インデックス, クエリ文字列]のまま）。

候補は機械的な文字列一致に過ぎず、必ずしも正しいとは限らない（無関係な言葉が
偶然一部一致しただけの場合もある）ので鵜呑みにしないこと。しかし候補が付随して
いる場合は、必ずそのリストを確認してから判断すること（候補の存在を無視して
自分の知識だけで独自に判断することは禁止する）。確認した結果、候補の中に
このクエリの実体と合致するものがあれば、それをbrand_poiとして採用すること。
候補の中のどれにも当てはまらないとしても、それは確認した結果としての判断で
あるべきで、無視した結果ではあってはならない。
"""

# BOUNDARY_GUIDANCEの末尾2段落（BRAND_KNOWLEDGE参照部分）を、taxonomyリーフ選定の
# 文脈向けに言い換えたもの。build_system_prompt_level3専用
# （brand_poiか否かの「判定」は既にlevel12側で確定済みなので、代わりに
# 「どのリーフを選ぶか」の判断材料として使う指示にしている）。
BRAND_KNOWLEDGE_GUIDANCE_LEVEL3 = """
対象がbrand_poi（複数拠点展開するブランド）の場合、以下に埋め込んだBRAND_KNOWLEDGE
（ブランド名→taxonomyリーフの参照データ）を積極的に使い、対応するリーフを選ぶこと。
表記が完全一致する場合に限らず、支店名・「店」等が付加された形も含めてブランド名を
認識して参照する。BRAND_KNOWLEDGEに無いブランドでも、モデル自身の知識で妥当な
リーフを判断してよい。

同じブランドが複数の異なるクエリ文字列（支店名付き・省略形など）で登場する場合、
実行のたびに違う判定にならないよう、判断に迷ったときはBRAND_KNOWLEDGEの値を優先する。
"""

SEMANTIC_QUERY_GUIDANCE = """
3(semantic_query)の判定は以下の2段階で行うこと。

段階1（除外）: ブランド名+支店名/地名+「店」「校」等の接尾辞が一体となって、
その拠点固有の正式名称を構成している場合（例: "ローソン浜松高塚店",
"文理学院甲府南校"）は、支店名が独立した絞り込み情報ではなくPOI名自体の一部
なので、3(semantic_query)にはせず1(poi)のままとする。同様に、地名+施設種別語が
分割不能な一つの固有名詞として定着している場合（例: "唐戸ターミナル"）も、
「本体+絞り込み情報」の構造ではなく単一の名称なので1(poi)のままとする。

段階2（絞り込み情報の有無）: 段階1で除外されなかったクエリについて、本体
（POI名・ブランド名・カテゴリ語）だけでは同名・同種の候補が複数あり得て一意に
特定できない場合に、それを絞り込む・特定するのに役立つ付随情報（地名・業種語
など）が付加されているクエリのみを3(semantic_query)とする。本体自体が単体で
完結しており、それ以上絞り込む余地がない場合（例: "美容室"のような業種語
そのもの、"ゆず庵"のような単体のブランド名、"上名久井"のような単体の地名、
"ハーバーショップ"のような単体の固有名称）は、付随情報が付加されていないので
3(semantic_query)にせず、1(poi)または2(address)として判定すること。
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
以下に列挙するCATEGORY_TAXONOMYの値のいずれか1つと一字一句完全に一致する値で
なければならない（存在しない値・近似した値を作り出さない。ハルシネーション禁止）。
該当するものがどうしても1つも見つからない場合のみ、配列に文字列"unknown"を1つだけ
入れて返す（taxonomyには存在しないが、「判定不能」を表す唯一の許可された値）。

2026-08-27にtaxonomyを45件のフラットな単一カテゴリに刷新した（旧・階層的で
細かすぎる285リーフ構成は、隣接カテゴリ同士の境界判断が難しく分類精度の低下
要因になっていたため）。この刷新により、通常は1クエリにつき当てはまるカテゴリは
1つだけのはずである。配列で返す形式自体は残しているが、複数選択はよほど明確に
複数領域にまたがる場合（例: ショッピングセンターのように単独では複数の専門店を
含む複合施設）に限る例外的な扱いとし、基本は1要素の配列を返すこと。

判断に迷う境界例（優先してこちらを採用する）:
- 「〜クリニック」「〜医院」は原則「診療所」（「病院」は入院設備を持つ大規模な
  医療機関のみ）。
- タワー・超高層ビルなど、待ち合わせ場所の目印として使われる大規模建造物
  （東京タワー、東京スカイツリー、横浜ランドマークタワー等）は「ランドマーク」。
  それ以外の観光目的の名所・史跡（城、神社仏閣、庭園等）は「観光名所」。
- 銭湯・サウナ・日帰り温泉施設など入浴が主目的の施設は「入浴施設」。宿泊が主目的の
  温泉旅館・ホテルは「宿泊施設」。
- 弁護士・税理士・保険・金融・翻訳・人材派遣など、専用カテゴリの無い生活関連の
  専門サービス業は「生活サービス」に含める。
- 映画館・水族館・動物園・美術館・遊園地・競技場等、細かい種別のレジャー施設は
  「その他レジャー」にまとめる（フィットネス・カラオケ・パチンコは別カテゴリ）。

名前の語尾・構成要素から診療科目・施設種別を推測できる場合、実測でHaikuが見落とし
やすかった以下のパターンは特に注意して適用すること（該当する語が名前に含まれて
いれば、それだけで機械的に判定してよい。歯科医院は既存の「歯科」を優先）:
- 「〜眼科」「〜内科」「〜外科」「〜皮膚科」「〜耳鼻咽喉科」「〜整形外科」等、
  「科」で終わる医療機関名は「診療所」（歯科を除く）。
- 「〜接骨院」「〜整骨院」は「美容サービス」。
- 「〜斎場」「〜葬儀場」「〜霊園」は、霊園自体は「宗教施設」、葬儀を執り行う施設は
  「生活サービス」。
- 「〜銀行」で終わる名称は、日本銀行のような中央銀行・特殊な扱いに見える名称でも
  機械的に「銀行・ATM」でよい（実在する支店・拠点である以上、業態としては銀行）。
- 「〜工場」「〜製作所」「〜製鋼」「〜化学」「〜鋼材」等、製造業を示す社名・語尾は
  「工場」。「〜支店」「〜営業所」「〜本社」等、拠点であることを示す社名・語尾で
  かつ製造業を示す語が無い場合は「オフィスビル」。
"""


def build_system_prompt_level12() -> str:
    """ai_classification/_2のみを判定する軽量版プロンプト（2026-08-26新設）。
    taxonomy(285リーフ)・BRAND_KNOWLEDGE(1500件超)を含まないため、
    build_system_prompt_level3()の重量級プロンプト比で1/10程度のサイズに収まる。
    ai_classification_3はbuild_system_prompt_level3()で別途判定する
    （project memory参照: Haikuだとai_classification_3のunknown率が
    unique_poi/categoryで5割超に達する実測結果を受けての2段階分離）。"""
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

    return f"""あなたは検索クエリの分類器です。与えられた検索クエリの配列を、以下の2階層で分類してください。
（3階層目のtaxonomyカテゴリ判定は別ステップで行うので、ここでは考えなくてよい）

このクエリログは、タクシー配車事業者のオペレーターが電話で乗客から聞いた場所の
説明を検索APIにクエリ化したものです。乗客本人の入力ではなく、オペレーターが
聞き取った内容を解釈・言い換えてクエリ化し、検索結果を見ながら会話で場所を
絞り込んでいく運用のため、生の音声認識結果のような崩れ方とは性質が異なります。

## 第1階層（ai_classification、必須・4カテゴリ）
{cat1_lines}

{SEMANTIC_QUERY_GUIDANCE}

## 第2階層（ai_classification_2）
- ai_classificationが1(poi)の場合、以下から1つ:
{poi_lines}
- ai_classificationが2(address)の場合、以下から1つ:
{address_lines}
- ai_classificationが3(semantic_query)または4(unknown)の場合: 該当なし（0を返す）

{BOUNDARY_GUIDANCE_LEVEL12}
{ADDRESS_GUIDANCE}
{BRAND_CANDIDATE_GUIDANCE}

## 出力形式
入力配列の各要素は[インデックス, クエリ文字列]または[インデックス, クエリ文字列,
候補配列]という形式です。出力は、入力に含まれていた各インデックスについて1つずつ、
以下の形式の要素を持つJSON配列で返してください（順序は入力と一致させる必要は
ありません。各インデックスは1回だけ登場させてください）。
- 候補配列を伴わない入力要素に対しては、[インデックス, ai_classification番号,
  ai_classification_2番号(該当なしは0)]という3要素配列
- 候補配列を伴う入力要素に対しては、[インデックス, ai_classification番号,
  ai_classification_2番号(該当なしは0), 一致した候補の番号(1始まり。どの候補にも
  当てはまらない場合は0)]という4要素配列（末尾要素の省略は不可）
説明文やコードフェンスは一切含めず、JSON配列のみを出力してください。入力に含まれる
全てのインデックスに対して必ず1件ずつ出力し、省略・統合・重複が無いようにしてください。
例: [[0,1,2], [1,1,1], [2,2,5], [3,4,0], [4,1,2,1], [5,1,1,0]]
"""


def build_system_prompt_level3(include_brand_knowledge: bool) -> str:
    """ai_classification_3（taxonomyカテゴリ）のみを判定するプロンプト（2026-08-26新設、
    2026-08-27にtaxonomyを285リーフの階層構造から45件のフラットカテゴリに刷新）。
    ai_classification_2がunique_poi/brand_poi/categoryと確定済みの
    (query, サブタイプ)の組だけを入力として受け取る想定（呼び出し元でフィルタ済み）。
    常にSonnetで呼ぶ（build_system_prompt_level12のdocstring参照）。

    include_brand_knowledge: BRAND_KNOWLEDGE（1500件超のブランド→taxonomyカテゴリ
    辞書）を埋め込むかどうか（2026-08-27新設）。これが実際に役立つのはbrand_poi
    （複数拠点展開ブランド）の判定時だけで、unique_poi（定義上ブランドではない）・
    category（一般名詞）にはそもそも無関係。以前はsubtypeを問わず全バッチに
    無条件で埋め込んでいたため、呼び出し元(classify_unique)でbrand_poiのバッチと
    unique_poi/categoryのバッチを分けて送り、後者にはFalseを渡す
    （SYSTEM_PROMPT_LEVEL3_LIGHT参照）。"""
    taxonomy_json = json.dumps(brand_data.CATEGORY_TAXONOMY, ensure_ascii=False)

    brand_section = ""
    if include_brand_knowledge:
        brand_json = json.dumps(brand_data.BRAND_CATEGORY_MAP, ensure_ascii=False, separators=(",", ":"))
        brand_section = f"""
{BRAND_KNOWLEDGE_GUIDANCE_LEVEL3}

## BRAND_KNOWLEDGE（ブランド名→taxonomyカテゴリの参照データ。出典はWikipedia等の一般情報。
空配列は「ブランドとして認識してよいが対応するtaxonomyカテゴリが無い」ことを意味する）
{brand_json}
"""

    return f"""あなたは検索クエリのtaxonomy分類器です。与えられた(query文字列, サブタイプ)の
組の配列について、それぞれに当てはまるCATEGORY_TAXONOMYのカテゴリを判定してください。
サブタイプはunique_poi（一意の固有施設）・brand_poi（複数拠点展開するブランド）・
category（業種を表す一般名詞）のいずれかで既に確定済みなので、変更せずそのまま
カテゴリ選定の参考情報として使うこと。

このクエリログは、タクシー配車事業者のオペレーターが電話で乗客から聞いた場所の
説明を検索APIにクエリ化したものです。

{CATEGORY_3_GUIDANCE}
CATEGORY_TAXONOMY（この配列の文字列以外は使用禁止）:
{taxonomy_json}
{brand_section}
## 出力形式
入力配列の各要素は[インデックス, クエリ文字列, サブタイプ]です。出力は、入力に
含まれていた各インデックスについて1つずつ、[インデックス, カテゴリ文字列の配列]
という形式の要素を持つJSON配列で返してください（順序は入力と一致させる必要は
ありません。各インデックスは1回だけ登場させてください）。カテゴリ文字列の配列は
通常1要素、複数領域にまたがる場合のみ複数可（文字列を直接入れない。該当する
カテゴリが1つも無い場合は["unknown"]）。説明文やコードフェンスは一切含めず、
JSON配列のみを出力してください。入力に含まれる全てのインデックスに対して必ず
1件ずつ出力し、省略・統合・重複が無いようにしてください。
例: [[0,["コンビニ"]], [1,["専門店（アパレル・服飾雑貨）"]], [2,["unknown"]]]
"""


SYSTEM_PROMPT_LEVEL12 = build_system_prompt_level12()
# level3はbrand_poi判定時だけBRAND_KNOWLEDGEが必要（build_system_prompt_level3の
# docstring参照）。呼び出し元(ai_classify.py/ai_classify_batch.pyのclassify_unique)
# がsubtypeでバッチを分けて、それぞれに対応するプロンプトを使う。
SYSTEM_PROMPT_LEVEL3_BRAND = build_system_prompt_level3(include_brand_knowledge=True)
SYSTEM_PROMPT_LEVEL3_LIGHT = build_system_prompt_level3(include_brand_knowledge=False)


# ai_classification_3をCSVの1セルに格納する際の区切り文字。
# category-taxonomy.jsの285リーフに"|"を含む値は存在しないため衝突しない。
LEAF_DELIMITER = "|"

# taxonomyに存在しないが、「該当するリーフが1つも見つからない」ことを表す
# ために唯一許可されたai_classification_3の値。
UNKNOWN_LEAF = "unknown"


POI_SUBTYPE_VALUES = ("unique_poi", "brand_poi", "category")


def encode_leaves(raw_leaves) -> str:
    """LLMが返したリーフ配列（複数可、該当なしは[]、判定不能は["unknown"]）を、
    taxonomyに存在する値のみ残して重複を除いた上で LEAF_DELIMITER 区切りの1文字列に
    連結する（CSVの1セルに収めるため）。形式が不正・値が範囲外の場合は捨て、
    フィルタ後に何も残らなければUNKNOWN_LEAFにフォールバックする。
    decode_indexed_leaf_responses（3階層目だけを判定する形式）から使う共通ロジック。"""
    # 旧形式（単一文字列）が来ても壊れないようにフォールバックしておく。
    if isinstance(raw_leaves, str):
        raw_leaves = [raw_leaves]
    elif not isinstance(raw_leaves, list):
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

    return LEAF_DELIMITER.join(deduped) if deduped else UNKNOWN_LEAF


def decode_pair(item) -> tuple[str, str]:
    """build_system_prompt_level12が返す1件分の[c1, c2]を(ai_classification,
    ai_classification_2)の文字列2つ組に変換する（2026-08-26新設の2段階分離方式で、
    ai_classification_3を含まない軽量版レスポンス用）。"""
    try:
        c1, c2 = item
    except (ValueError, TypeError):
        return "unknown", ""

    classification = CATEGORIES.get(c1)
    if classification is None:
        return "unknown", ""

    if classification == "poi":
        sub = POI_SUBTYPES.get(c2, "")
    elif classification == "address":
        sub = ADDRESS_SUBTYPES.get(c2, "")
    else:
        sub = ""

    return classification, sub


# ai_classification/_2 に加えて、機械的に検出したブランド候補のうちどれが
# 一致したか（BRAND_CANDIDATE_GUIDANCE参照）まで含めた1件分のレコード。
# matched_brandは候補の中からLLMが選んだブランド名（BRAND_CATEGORY_MAPのキー）、
# 該当なし/候補自体が無かった場合はNone。
CandidateRecord = tuple[str, str, str | None]


def build_level12_user_content(queries: list[str], candidates: list[list[str] | None]) -> str:
    """レベル1/2フェーズの入力JSONを組み立てる。candidatesはqueriesと同じ順序・
    同じ長さで、各クエリに機械的に検出したブランド候補のリスト（無ければNone）を
    渡す。各要素の先頭には0始まりのインデックス（queries内の位置）を必ず付与する
    （2026-08-27新設。従来は入力と出力の「配列位置」だけで対応を取っていたが、
    LLMが1件飛ばす・1件多く返すなどして配列長がズレると、それだけでバッチ全体を
    個別リトライに回さざるを得なかった。インデックスを明示することで、
    どのクエリの応答が欠落したかをピンポイントで特定し、その分だけ個別リトライ
    できるようにする。project memory参照）。候補が無いクエリは
    [インデックス, クエリ文字列]、候補があるクエリは
    [インデックス, クエリ文字列, 候補配列]という配列にする
    （BRAND_CANDIDATE_GUIDANCE参照）。"""
    if len(queries) != len(candidates):
        raise ValueError(f"queriesとcandidatesの長さが不一致です（{len(queries)} vs {len(candidates)}）")
    payload = [
        [i, q, c] if c else [i, q]
        for i, (q, c) in enumerate(zip(queries, candidates))
    ]
    return json.dumps(payload, ensure_ascii=False)


def build_level3_user_content(items: list[tuple[str, str]]) -> str:
    """レベル3フェーズ（taxonomyリーフ判定）の入力JSONを組み立てる。itemsは
    [(query, サブタイプ), ...]。build_level12_user_contentと同じ理由で、各要素の
    先頭に0始まりのインデックスを付与する。"""
    payload = [[i, q, sub] for i, (q, sub) in enumerate(items)]
    return json.dumps(payload, ensure_ascii=False)


def _decode_candidate_tail(rest: list, candidates: list[str] | None) -> CandidateRecord | None:
    """decode_indexed_level12_responsesの1件分。restはインデックスを除いた残りの
    要素（候補なしなら[c1, c2]、候補ありなら[c1, c2, idx]）。形式が不正・値が
    範囲外の場合はNoneを返し、呼び出し元でこのインデックスを欠落扱いにする。"""
    if candidates is None:
        if len(rest) != 2:
            return None
        c1, c2 = decode_pair(rest)
        return c1, c2, None

    if len(rest) != 3:
        return None
    c1_num, c2_num, idx = rest
    c1, c2 = decode_pair([c1_num, c2_num])
    if not isinstance(idx, int) or idx < 0 or idx > len(candidates):
        return None
    matched_brand = candidates[idx - 1] if idx > 0 else None
    return c1, c2, matched_brand


def decode_indexed_level12_responses(
    raw_items: list, candidates_list: list[list[str] | None],
) -> tuple[list[CandidateRecord | None], set[int]]:
    """build_system_prompt_level12が返すインデックス付き応答配列
    （各要素は[idx, c1, c2]または[idx, c1, c2, candidate_idx]）を、
    candidates_listと同じ順序・同じ長さのCandidateRecordのリストに変換する
    （2026-08-27新設、要素数ズレ対策のインデックス方式）。範囲外・型不正・
    重複したインデックス、およびデコードに失敗した要素はその位置をNoneのまま
    残す。戻り値の2つ目はNoneのまま残った（＝LLM応答から実質的に欠落した）
    インデックスの集合で、呼び出し元(_run_batches_concurrently)がこの分だけ
    個別リトライする。"""
    n = len(candidates_list)
    records: list[CandidateRecord | None] = [None] * n
    for raw in raw_items:
        if not isinstance(raw, list) or len(raw) < 2:
            continue
        idx, rest = raw[0], raw[1:]
        if not isinstance(idx, int) or idx < 0 or idx >= n or records[idx] is not None:
            continue  # 範囲外・型不正・重複インデックスは無視する
        decoded = _decode_candidate_tail(rest, candidates_list[idx])
        if decoded is not None:
            records[idx] = decoded
    missing = {i for i, r in enumerate(records) if r is None}
    return records, missing


def leaves_for_matched_brand(matched_brand: str | None, ai_classification_2: str) -> str | None:
    """decode_indexed_level12_responsesが返したmatched_brandが、レベル3(taxonomy)の
    LLM呼び出しを省略してBRAND_CATEGORY_MAPから直接引ける対象かどうかを判定する。
    対象ならencode_leaves済みの文字列（辞書にリーフが無いブランドはUNKNOWN_LEAF）
    を返し、対象外（候補が無かった/LLMがどの候補にも当てはまらないと判断した/
    ai_classification_2がbrand_poiと整合しない）ならNoneを返す（呼び出し元は
    Noneの場合レベル3のLLM判定に回すこと）。

    ai_classification_2がbrand_poiと整合しない場合にNoneを返すのは安全側の
    フォールバック: LLMがcandidate番号とai_classification_2の間で矛盾した応答
    （例: 候補に一致したのにunique_poiと判定）を返した場合、辞書を鵜呑みにせず
    LLMのtaxonomy判定に委ねる。"""
    if matched_brand is None or ai_classification_2 != "brand_poi":
        return None
    return encode_leaves(brand_data.BRAND_CATEGORY_MAP.get(matched_brand, []))


def decode_indexed_leaf_responses(raw_items: list, n: int) -> tuple[list[str | None], set[int]]:
    """build_system_prompt_level3が返すインデックス付き応答配列
    （各要素は[idx, リーフ配列]）を、長さnのリストに変換する
    （2026-08-27新設、decode_indexed_level12_responsesと同じインデックス方式）。
    範囲外・型不正・重複したインデックスの要素は無視する。戻り値の2つ目は
    Noneのまま残った（＝LLM応答から実質的に欠落した）インデックスの集合。"""
    records: list[str | None] = [None] * n
    for raw in raw_items:
        if not isinstance(raw, list) or len(raw) != 2:
            continue
        idx, leaves = raw
        if not isinstance(idx, int) or idx < 0 or idx >= n or records[idx] is not None:
            continue
        records[idx] = encode_leaves(leaves)
    missing = {i for i, r in enumerate(records) if r is None}
    return records, missing


def parse_response_text(text: str) -> str:
    """```json ... ``` のようなコードフェンスが付いた場合に備えて除去する。"""
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    return text
