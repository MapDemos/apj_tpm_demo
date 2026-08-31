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
辞書、data_cleaning/local/category_and_brand/poi-blocklist.js）はLEVEL12段階の
機械的候補マッチ（brand_match.py）とその直後の辞書ショートカット
（leaves_for_matched_brand）でのみ使う。以前はLEVEL3のai_classification_3用
プロンプトにもBRAND_KNOWLEDGE全文（1500件超）を埋め込んでbrand_poi用の重量級
プロンプトを別途用意していたが、実データ検証で「候補マッチが外れてLEVEL3まで
来た行」の大半はLLM自身の一般知識だけで正しく分類できており、辞書埋め込みが
実際に判定を変えている証拠が無い一方でトークン消費だけが大きい（他の3プロンプトの
8〜13倍）と判明したため撤去した（2026-08-29、project memory参照）。ai_classification_3用
プロンプトはbrand_poi/unique_poi/categoryの全subtypeで共通の1本
（build_system_prompt_level3）に統合されている。

2026-08-27、LLM応答の要素数が入力とズレて頻発していた問題への対策として、
入出力の各要素に0始まりのインデックスを付与する方式に変更した（配列の「位置」
だけで入出力を対応付けていたため、LLMが1件飛ばす・多く返すなどしただけで
バッチ全体を個別リトライせざるを得なかった。build_level12_user_content/
build_level3_user_content、decode_indexed_level12_responses/
decode_indexed_leaf_responses参照）。

2026-08-28、ai_classification_2="category"・ai_classification_3="unknown"
（taxonomyのどのリーフにも一致しなかった）という組み合わせだけを対象にした
再判定フェーズを追加した（build_system_prompt_category_recheck、
decode_indexed_recheck_responses参照）。"category"は定義上「実在する業種を
表す一般名詞」なので、正しく判定できていればtaxonomyのどれかに当てはまる
のが本来の姿であり、taxonomy unknownはlevel2（ai_classification_2）の判定
自体が誤っていた（知らない固有名詞・愛称をcategoryと誤判定した）可能性を
示すシグナルとして扱える。unique_poi/brand_poiのtaxonomy unknownは
taxonomyのカバレッジ不足として正当なケースがあり得るため対象外
（project memory参照）。呼び出し元(ai_classify.py/ai_classify_batch.pyの
classify_unique)が、この再判定結果に応じてai_classification_2の訂正・
taxonomyの再判定・ai_classificationの"unknown"化を行う。
"""

import json

from lib import brand_data


class OperationCancelled(Exception):
    """GUIの「キャンセル」ボタンでユーザーが処理の中断を要求した際に送出する。
    ai_classify.py/ai_classify_batch.pyのclassify_unique()がcancel_event
    （threading.Event、GUIからのみ渡される。CLI実行時は常にNone）を各フェーズの
    境目・ポーリングループ内で確認し、セットされていればこの例外を送出して
    以降の処理（残りのフェーズ・ジョブ完了待ち）を中断する。既に投げてしまった
    API呼び出し自体を打ち切ることはできない（実行中の1呼び出し分の完了は待つ）
    ため、あくまで「これ以上新しい呼び出しを増やさない」段階的な中断になる
    （project memory参照）。"""


def raise_if_cancelled(cancel_event) -> None:
    """cancel_eventがセットされていればOperationCancelledを送出する。
    cancel_eventがNone（CLI実行時、またはGUIでもキャンセル非対応の呼び出し元）
    なら何もしない。"""
    if cancel_event is not None and cancel_event.is_set():
        raise OperationCancelled("ユーザーによりキャンセルされました")

# main.pyの --model 引数(haiku/sonnet)からモデルIDへの変換テーブル。
# ai-analyze（AIコメンタリー）がsonnetを引くのに使う（lib/ai_analyze.py参照）。
MODEL_CHOICES: dict[str, str] = {
    "haiku": "claude-haiku-4-5-20251001",
    "sonnet": "claude-sonnet-5",
}

# ai-classify（ai_classification/_2/_3の3階層すべて）で使うモデル。
# 2026-08-26に導入した「level1/2をHaiku・taxonomy判定のlevel3だけSonnet」という
# 2段階分離方式（旧MODEL_PRESETS）は、taxonomyの285リーフ→45件フラット化と
# brand_match.pyによる機械的ブランド候補注入の後、Haiku単体でも実用十分な精度に
# 改善したことを確認できたため2026-08-27に廃止し、常にHaikuで統一した
# （CLI/GUIのモデル選択自体も廃止）。2026-08-30、resolve_model()による自動追従の
# フォールバック値（Models API呼び出し失敗時に使う既知の安全な値）としての
# 役割に変わった。ファミリー（Haiku/Sonnet）自体は変わらず固定。
CLASSIFY_MODEL: str = MODEL_CHOICES["haiku"]

# ai-analyze（AIコメンタリー）で使うモデル。taxonomy判定と違い分類精度は関係なく、
# 集計済みサマリーからの文章生成のみなので、常にSonnet固定（CLI/GUIのモデル選択は
# 廃止、2026-08-27）。2026-08-30、CLASSIFY_MODELと同じくresolve_model()の
# フォールバック値としての役割に変わった。
ANALYZE_MODEL: str = MODEL_CHOICES["sonnet"]


def resolve_model(family: str, api_key: str | None = None) -> str:
    """モデルファミリー（"haiku" or "sonnet"）は固定した上で、その最新版を
    Models API（client.models.list()）から自動的に選ぶ（2026-08-30新設。project
    memory参照: 今後Haiku/Sonnetのバージョンが上がっても、コード変更無しで
    追従できるようにする狙い）。

    familyを含むモデルIDのうち、created_atが最も新しいものを採用する
    （Models APIのモデル一覧はcreated_at付きで返る。日付サフィックス無しの
    エイリアスID（例: "claude-haiku-4-5"）も一覧に含まれる場合は、そちらが
    優先的に最新を指す想定）。

    ネットワークエラー・APIキー不正・該当ファミリーのモデルが1件も見つからない
    等、何らかの理由で解決できなかった場合は、MODEL_CHOICES[family]
    （CLASSIFY_MODEL/ANALYZE_MODELの元になっている既知の安全な固定値）に
    フォールバックする（呼び出し元を落とさないため。この関数自体は例外を
    送出しない）。

    anthropicパッケージはこの関数の中でのみ遅延importする（classification_common.py
    はAI呼び出しを伴わない処理からも import されるため、モジュール本体には
    anthropicへの依存を持ち込まない設計を維持する）。"""
    fallback = MODEL_CHOICES.get(family)
    if fallback is None:
        raise ValueError(f"未知のモデルファミリーです: {family!r}")
    try:
        import anthropic

        client = anthropic.Anthropic(api_key=api_key) if api_key else anthropic.Anthropic()
        candidates = [m for m in client.models.list() if family in m.id.lower()]
        if not candidates:
            return fallback
        candidates.sort(key=lambda m: m.created_at, reverse=True)
        return candidates[0].id
    except Exception:  # noqa: BLE001 モデル解決の失敗で全体を落とさない
        return fallback

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

# ai_classification_2="category"と判定されたが、ai_classification_3（taxonomy）が
# どのリーフにも一致せず"unknown"になったクエリだけを対象に、level2の判定自体を
# 再確認するための選択肢（2026-08-28新設、build_system_prompt_category_recheck
# 参照）。POI_SUBTYPESとは別の番号体系（このプロンプト内でのみ意味を持つ）。
CATEGORY_RECHECK_CHOICES: dict[int, str] = {
    1: "category",
    2: "unique_poi",
    3: "brand_poi",
    4: "broken",
}

# CATEGORY_RECHECK_CHOICESの各値の説明文。POI_SUBTYPE_DESCRIPTIONS/
# CATEGORY_DESCRIPTIONSは"2(brand_poi)"のような別の番号体系への参照を含むため
# そのまま流用せず、この再判定プロンプト単体で意味が完結するよう独立して書く。
_CATEGORY_RECHECK_CHOICE_DESCRIPTIONS: dict[str, str] = {
    "category": "見直した結果、やはり業種を表す一般名詞（固有名詞ではない）として"
    "成立する。例: \"コンビニ\", \"駐車場\"",
    "unique_poi": "一般名詞ではなく、現実世界に一意にしか存在しない単一の地点・"
    "施設を指す固有名詞・愛称。知らない店舗名・地域固有の屋号であっても、一意の"
    "場所を指す固有名詞として成立していればここに含める。",
    "brand_poi": "一般名詞ではなく、同一名称の拠点が複数箇所に展開されている"
    "企業・ブランド名（直営店・フランチャイズは問わない）。",
    "broken": "表記が崩れている、断片的すぎる、または意味を成す単語として"
    "読み取れず、何を指しているか特定できないもの。",
}

# CATEGORY_RECHECK_CHOICES専用の境界判断指針。BOUNDARY_GUIDANCEの「1(poi)の
# サブカテゴリ判定基準」「境界事例」段落と趣旨は同じだが、そちらは"1(poi)"
# "2(brand_poi)"等このプロンプトとは異なる番号体系への言及を含むため、
# 数字参照を含まない形に言い換えて独立させている
# （BRAND_KNOWLEDGE_GUIDANCE_LEVEL3と同じ「文脈に合わせて言い換える」方針）。
CATEGORY_RECHECK_GUIDANCE = """
再判定の観点（unique_poiとbrand_poiの境界）: 一般名詞として成立しないと判断した
場合、次に「実在する一意の施設・愛称を指す固有名詞（unique_poi）」か「複数拠点
展開する企業・ブランド名（brand_poi）」かを見分けること。同一名称の拠点が複数
箇所に存在すると判断できる場合（直営店・フランチャイズは問わない）はbrand_poi、
その名前を持つ場所が現実には1箇所しか存在しないと考えられる場合はunique_poiと
する。

判断材料が乏しい・知らない単語であるというだけの理由でbrokenへ倒さないこと。
brokenは表記が崩れている・断片的すぎる・意味を成す単語として読み取れない場合に
限る（知らない固有名詞・愛称として読める単語はunique_poiへ）。
"""


def build_system_prompt_category_recheck() -> str:
    """ai_classification_2="category"と判定されたが、taxonomy
    （ai_classification_3）のどのリーフにも一致せず"unknown"になったクエリだけを
    対象に、その判定自体が誤っていなかったかを再確認する専用の軽量プロンプト
    （2026-08-28新設）。

    経緯: "category"は定義上「実在する業種を表す一般名詞」なので、正しく判定
    できていればtaxonomyのどれかに（多少大味でも）当てはまるのが本来の姿である。
    つまり"category"×taxonomy unknownという組み合わせは、taxonomyのカバレッジ
    不足というより、level2（build_system_prompt_level12）が「知らない単語＝
    実在する業種の一般名詞かもしれない」と誤って安全側に倒した誤判定である
    可能性が高い（実測でタクシー配車ログ中の地域固有の店の愛称・固有名詞が
    "category"に誤分類され、taxonomy側でunknownになるケースが見つかった。
    project memory参照）。

    なお同じ現象がunique_poi/brand_poi側のtaxonomy unknownでは起きにくい
    （そちらは「実在する特定の施設・ブランドだがtaxonomyがカバーしていない
    業種」という正当なケースがあり得るため、level2判定を疑う根拠にならない）。
    よってこの再判定は呼び出し元(classify_unique)で"category"×taxonomy unknown
    の組み合わせだけに絞り込んで適用する。

    再判定の結果、category（据え置き）以外を選んだ場合はai_classification_2が
    書き換わる。unique_poi/brand_poiに変わった場合、呼び出し元はtaxonomy
    （ai_classification_3）も訂正後のsubtypeで再度判定し直す。brokenを選んだ
    場合、呼び出し元はai_classification自体を"unknown"に書き換える
    （いずれも呼び出し元の責務。CATEGORY_RECHECK_CHOICES参照）。"""
    choice_lines = "\n".join(
        f"{n}. {name}: {_CATEGORY_RECHECK_CHOICE_DESCRIPTIONS[name]}"
        for n, name in sorted(CATEGORY_RECHECK_CHOICES.items())
    )
    return f"""あなたは検索クエリの再分類器です。以下のクエリは、既に"category"
（{POI_SUBTYPE_DESCRIPTIONS[3]}）と判定されましたが、taxonomyのどのカテゴリにも
一致せず判定不能（"unknown"）になりました。

"category"は本来「実在する業種を表す一般名詞」なので、正しく判定できていれば
taxonomyのどれかに（多少大味でも）当てはまるはずです。taxonomyがどれにも
一致しなかったという事実は、"category"という判定自体が誤りだった可能性を
示しています。各クエリについて、以下の選択肢のどれが最も適切かを判定し直して
ください。

{choice_lines}

このクエリログは、タクシー配車事業者のオペレーターが電話で乗客から聞いた場所の
説明を検索APIにクエリ化したものです。

{CATEGORY_RECHECK_GUIDANCE}
{BRAND_CANDIDATE_GUIDANCE}
## 出力形式
入力配列の各要素は[インデックス, クエリ文字列]または[インデックス, クエリ文字列,
候補配列]という形式です（候補配列の意味は上記の説明を参照）。出力は、入力に
含まれていた各インデックスについて1つずつ、以下の形式の要素を持つJSON配列で
返してください（順序は入力と一致させる必要はありません。各インデックスは
1回だけ登場させてください）。
- 候補配列を伴わない入力要素に対しては、[インデックス, 選択肢番号(1〜4)]という
  2要素配列
- 候補配列を伴う入力要素に対しては、[インデックス, 選択肢番号(1〜4), 一致した
  候補の番号(1始まり。どの候補にも当てはまらない場合は0)]という3要素配列
  （末尾要素の省略は不可）
説明文やコードフェンスは一切含めず、JSON配列のみを出力してください。入力に
含まれる全てのインデックスに対して必ず1件ずつ出力し、省略・統合・重複が
無いようにしてください。
例: [[0,1], [1,2], [2,3,1], [3,4]]
"""


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

入力途中の断片の既定値: 上記の優先順位にはもう一つ例外がある（2026-08-31追加。
project memory参照）。このクエリログはリアルタイム検索候補(suggest)APIの記録
であり、確定した検索語だけでなく、1文字打つごとの入力途中の状態も記録され
得る。クエリ全体が1〜2文字程度の短い文字列で、表記（ひらがな・カタカナ・漢字・
ローマ字いずれでも）にかかわらず、それ単体では日本語として完結した単語・
固有名詞の体をなしていないと判断できる場合は、無理に1(poi)・brand_poi・
category等に当てはめようとせず、4(unknown)を選んでよい。これは「知らない
名前だから」という理由でunknownに逃げることとは判断軸が異なる点に注意
（基準は「モデルがその名前を知っているかどうか」ではなく、「そもそもこの
文字列が完結した名前・単語としての体裁を成しているかどうか」）。完結した
固有名詞・地名・普通名詞であれば、短くても未知でもこの例外の対象外（例:
"仙台"は2文字だが完結した地名なのでaddress。"は"や"ひろ"のような、それ単体
では意味を成さない断片はunknown）。

地名の既定値: 上記の優先順位には例外がある。クエリ全体が都道府県・市区町村・
大字・有名地域名などの地理的な地名（行政区画・地域の名称）**だけ**で完結して
おり、施設・建造物・拠点であることを示す語（駅・タワー・城・神社・公園・
ホテル・店等）を伴っていない場合は、1(poi)より先に2(address)を検討すること。
都市・観光地としての知名度の高さは1(poi)と判断する根拠にはならない（例:
"仙台", "鹿児島", "軽井沢", "苫小牧"のような、それ単体では地名以外の意味を
持たない文字列はaddressが既定）。1(poi)と判断してよいのは、地名の一部を
含んでいても、それが特定の施設・建造物そのものを指す名称だと判断できる場合
（例: "仙台城", "軽井沢プリンスホテル"）に限る。

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

特に注意すべき無関係な一致パターン: 候補のブランド名が「クエリ全体＋追加の語」
という構造になっている場合（例: クエリ"仙台"に対し候補"仙台銀行"、クエリ"箱根"
に対し候補"箱根そば"）、クエリ自体が地名（都道府県・市区町村・有名地域名など）
として完結しているだけの可能性を優先的に疑うこと。この場合、追加の語が業種語
（銀行・電力等）か固有名詞の一部かは問わず、クエリ全体が地名として自然に読める
かどうかだけを判断基準にする。
"""

# build_system_prompt_level3専用のbrand_poi向け短い補足（2026-08-29、BRAND_KNOWLEDGE
# 全文埋め込みを撤去した際に、辞書参照の指示だけ削ってこの一文を残した。「モデル
# 自身の知識で判断してよい」という許可自体は判定品質のヒントとして有効なため）。
BRAND_KNOWLEDGE_GUIDANCE_LEVEL3 = """
対象がbrand_poi（複数拠点展開するブランド）の場合、モデル自身の知識でそのブランド・
チェーン店が何であるかを特定し、妥当なリーフを判断すること。
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
- 分譲・賃貸のマンション、アパート、団地など居住目的の集合住宅は「マンション・
  アパート」（一戸建ては対象外）。マンスリーマンション・ウィークリーマンション等、
  宿泊が主目的の施設は「宿泊施設」を優先する。
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
- 「〜小学校」「〜中学校」「〜高等学校」「〜高校」「〜大学」「〜専門学校」等、
  学校種別を示す語で終わる名称は「学校・教育施設」（2026-08-31追加。実測で
  Haikuが名前に学校種別が明記されているにもかかわらずunknownにするケースが
  見つかったため）。
- 「〜バイパス」「〜道路」「〜IC」「〜インター」「〜インターチェンジ」「〜SA」
  「〜サービスエリア」「〜PA」「〜パーキングエリア」等、高速道路・自動車専用道路
  関連の語で終わる名称は「高速道路・IC」（2026-08-31追加）。
- 「〜空港」で終わる名称は「空港」、「〜港」「〜フェリーターミナル」で終わる名称は
  「港湾」（2026-08-31追加）。
- 「道の駅〜」で始まる名称、または単体の「道の駅」は「道の駅」（2026-08-31追加）。
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


def build_system_prompt_level3() -> str:
    """ai_classification_3（taxonomyカテゴリ）のみを判定するプロンプト（2026-08-26新設、
    2026-08-27にtaxonomyを285リーフの階層構造から45件のフラットカテゴリに刷新）。
    ai_classification_2がunique_poi/brand_poi/categoryと確定済みの
    (query, サブタイプ)の組だけを入力として受け取る想定（呼び出し元でフィルタ済み）。
    2026-08-27以降はCLASSIFY_MODEL（Haiku）で呼ぶ（build_system_prompt_level12の
    docstring参照。旧版はSonnetで呼んでいたが、taxonomyのフラット化とブランド候補
    注入によりHaikuでも精度十分と確認できたため統一した）。

    2026-08-27〜08-29、brand_poi用（BRAND_KNOWLEDGE全文埋め込みあり）と
    unique_poi/category用（埋め込みなし）の2種類のプロンプトに分けていたが、
    実データ検証で辞書埋め込みの効果が確認できず、トークン消費（他プロンプトの
    8〜13倍）だけが大きいと判明したため撤去し、全subtypeで共通のこの1本に統合した
    （project memory参照）。

    2026-08-29、出力形式をカテゴリ文字列の配列から番号の数値配列に変更した
    （decode_indexed_leaf_responsesが番号→カテゴリ文字列の変換を行う）。
    実測（project memory参照）でoutputトークンは約57%減ったが、当初taxonomyを
    従来と同じJSON配列のまま渡し「配列内の位置(1始まり)がそのまま番号」という
    指示だけで済ませる版を試したところ、Haikuが位置を0始まりで数えてしまう
    系統的なオフバイワンが発生し、精度が79.3%→26.0%まで崩壊した（inputトークンの
    節約を優先した結果、精度が犠牲になった）。taxonomyを「番号: カテゴリ名」の
    行形式で明示的に列挙する形に変えたところ、この崩壊は解消し精度は旧方式と
    同水準（78.0%、通常のrun間ブレの範囲内）に戻った。inputトークンの増加は
    わずか（実測で+3%未満）で、outputの削減効果を相殺しないため、この明示列挙
    形式を採用している。"""
    taxonomy_numbered = "\n".join(
        f"{i}: {name}" for i, name in enumerate(brand_data.CATEGORY_TAXONOMY, start=1)
    )

    return f"""あなたは検索クエリのtaxonomy分類器です。与えられた(query文字列, サブタイプ)の
組の配列について、それぞれに当てはまるCATEGORY_TAXONOMYのカテゴリを判定してください。
サブタイプはunique_poi（一意の固有施設）・brand_poi（複数拠点展開するブランド）・
category（業種を表す一般名詞）のいずれかで既に確定済みなので、変更せずそのまま
カテゴリ選定の参考情報として使うこと。

このクエリログは、タクシー配車事業者のオペレーターが電話で乗客から聞いた場所の
説明を検索APIにクエリ化したものです。

{CATEGORY_3_GUIDANCE}
{BRAND_KNOWLEDGE_GUIDANCE_LEVEL3}
CATEGORY_TAXONOMY（番号→カテゴリ名の対応。出力では番号のみを使い、カテゴリ名の
文字列自体は出力に含めないこと）:
{taxonomy_numbered}

## 出力形式
入力配列の各要素は[インデックス, クエリ文字列, サブタイプ]です。出力は、入力に
含まれていた各インデックスについて1つずつ、[インデックス, 番号の配列]という形式の
要素を持つJSON配列で返してください（順序は入力と一致させる必要はありません。各
インデックスは1回だけ登場させてください）。番号は上記CATEGORY_TAXONOMYの番号を指す
（1始まり。位置を自分で数え直すのではなく、上記に明記されている番号をそのまま使う
こと）。番号の配列は通常1要素、複数領域にまたがる場合のみ複数可（該当するカテゴリが
1つも無い場合は[0]。0はCATEGORY_TAXONOMYには存在しないが「判定不能」を表す唯一の
許可された番号）。カテゴリ名の文字列は一切出力に含めず、必ず番号のみを使うこと。
説明文やコードフェンスは一切含めず、JSON配列のみを出力してください。入力に含まれる
全てのインデックスに対して必ず1件ずつ出力し、省略・統合・重複が無いようにしてください。
例: [[0,[3]], [1,[27]], [2,[0]]]
"""


SYSTEM_PROMPT_LEVEL12 = build_system_prompt_level12()
# 2026-08-29、brand_poi用/unique_poi・category用の2本に分けていたプロンプトを
# 統合（build_system_prompt_level3のdocstring参照）。subtypeを問わず全level3
# バッチでこの1本を使う。
SYSTEM_PROMPT_LEVEL3 = build_system_prompt_level3()
# "category"×taxonomy unknownの再判定専用（2026-08-28新設。build_system_prompt_
# category_recheckのdocstring参照）。
SYSTEM_PROMPT_CATEGORY_RECHECK = build_system_prompt_category_recheck()


# main.py ai-collapse-sessionsサブコマンド専用（2026-08-31新設。project memory
# 参照）。lib/session_collapse.pyの文字列前方一致ベースの間引きだけでは、
# IME変換途中（例: "いわきそう"→"いわき荘"）・住所の桁の打ち直し（例:
# "領家3-10-1"→"領家3-10-13"）・全角半角等の表記ゆれ（例: "民宿　やまと"と
# "民宿やまと"）で前方一致が崩れ、実質的に同じ検索意図の重複が大量に残ることが
# 実データで判明した。これらは文字列の機械的な一致だけでは判定できないため、
# LLMに判断させる。brand_matchの候補ヒント方式とは異なり、こちらは出力を
# インデックスの配列だけに絞ることで、classify_unique系のインデックス方式
# デコードと同じ設計（出力スキーマを増やさずcandidate系のデコード非決定性
# バグを再発させない）を踏襲している。
SYSTEM_PROMPT_SESSION_COLLAPSE = """あなたは検索クエリのセッションクリーニングツールです。

このデータは、タクシー配車事業者のオペレーターがリアルタイム検索候補(suggest)APIを
使って場所を検索した際のログです。1文字打つごとに記録される場合があるため、
同一セッション内に「入力途中の断片」が大量に含まれています。

入力は、セッションごとに時系列順（古い順）に並んだクエリ文字列の配列です。各セッションに
ついて、以下のパターンに該当する「実質的に同じ検索意図の重複」を1つにまとめてください:
- IME変換の途中経過（例: "いわきそう"→"いわき荘"のように、変換前のひらがな表記と
  変換後の漢字表記が両方含まれている）
- 住所や電話番号の桁を打ち直している途中経過（例: "領家3-10-1"→"領家3-10-13"）
- 表記ゆれによる重複（全角/半角スペース、ひらがな/カタカナの違いなど。例:
  "民宿　やまと"と"民宿やまと"）
- 単なる入力途中の短い断片（例: "は"、"ひろ"のような、それ単体では意味を成さない
  文字列）

重複と判断したグループの中では、基本的に時系列で一番最後に出てきた、最も完成された
形の文字列を残してください（変換途中のひらがな表記より変換後の漢字表記、短い断片より
長く完成された表記を優先する）。

重要: **同一セッション内に、全く別の検索意図（別の地名・別の施設）が複数含まれている
ことは想定内であり、正常な状態です**（例: "民宿やまと"を検索した後にそれを諦めて
"河口湖町"を検索し直すセッションでは、"民宿やまと"と"河口湖町"はどちらも別々の検索
意図なので両方残す）。まとめてよいのは、明らかに同じ対象を指している表記ゆれ・入力
途中の断片だけであり、少しでも異なる地名・施設を指している可能性がある場合はまとめず
両方残すこと。

判断に迷う場合は、消さずに残す方を選ぶこと（データを誤って失うことを避けるため）。

## 出力形式
入力配列の各要素は[セッションインデックス, [クエリ文字列の配列]]です。出力は、入力に
含まれていた各セッションインデックスについて1つずつ、[セッションインデックス, [残す
べきクエリの位置番号の配列]]という形式の要素を持つJSON配列で返してください（順序は
入力と一致させる必要はありません。各セッションインデックスは1回だけ登場させてください）。
位置番号はそのセッション内のクエリ配列における0始まりの位置を指し、クエリ文字列
そのものは一切出力に含めないこと。位置番号の配列は、そのセッションに含まれる要素数
以下で、必ず1つ以上の要素を含むこと（全て削除してよいセッションは無い）。
説明文やコードフェンスは一切含めず、JSON配列のみを出力してください。入力に含まれる
全てのセッションインデックスに対して必ず1件ずつ出力し、省略・統合・重複が無いように
してください。
例: [[0,[1]], [1,[0,1]], [2,[1,2]]]
"""


def build_session_collapse_user_content(sessions: list[list[str]]) -> str:
    """ai-collapse-sessionsフェーズの入力JSONを組み立てる。sessionsは各要素が
    そのセッションの時系列順クエリ文字列配列。build_level12_user_contentと
    同じ理由で、各要素の先頭に0始まりのインデックスを付与する。"""
    payload = [[i, queries] for i, queries in enumerate(sessions)]
    return json.dumps(payload, ensure_ascii=False)


def decode_indexed_session_collapse_responses(
    raw_items: list, sessions: list[list[str]],
) -> tuple[list[list[int] | None], set[int]]:
    """SYSTEM_PROMPT_SESSION_COLLAPSEが返すインデックス付き応答配列
    （各要素は[session_idx, [keep_position, ...]]）を、sessionsと同じ順序・
    同じ長さのリストに変換する。各要素は「そのセッション内で残すべき0始まりの
    位置番号」のリスト（昇順・重複無しに正規化済み）。形式が不正・値が範囲外・
    空配列（全削除は許可しない。モジュールdocstring参照）の場合はNoneのまま
    残し、呼び出し元がそのセッションを個別リトライ→最終的に失敗すれば「全件
    残す」にフォールバックする。"""
    n = len(sessions)
    records: list[list[int] | None] = [None] * n
    for raw in raw_items:
        if not isinstance(raw, list) or len(raw) != 2:
            continue
        idx, keep_positions = raw
        if not isinstance(idx, int) or idx < 0 or idx >= n or records[idx] is not None:
            continue
        if not isinstance(keep_positions, list) or not keep_positions:
            continue
        session_len = len(sessions[idx])
        try:
            normalized = sorted({int(p) for p in keep_positions})
        except (TypeError, ValueError):
            continue
        if any(p < 0 or p >= session_len for p in normalized):
            continue
        records[idx] = normalized
    return records, {i for i, r in enumerate(records) if r is None}


# APIレスポンスのusageを集計する共通ヘルパー（2026-08-28新設）。従来は
# input_tokens/output_tokensしか合計しておらず、system promptに付けている
# cache_control（プロンプトキャッシュ）の書き込み(cache_creation_input_tokens、
# 通常のinput tokensの約1.25倍課金)・読み込み(cache_read_input_tokens、約0.1倍課金)
# 分のコストが実行結果のトークン集計に一切反映されていなかった（project memory
# 参照。1日分の実行だけで数百円かかり高すぎるという相談を受けての可視化対応）。
# ai_classify.py/ai_classify_batch.py双方の複数フェーズ（level12/level3/カテゴリ
# 再判定）にまたがる集計をタプルの要素数を増やさずに扱えるよう、辞書1つを
# 使い回す方式にしている。


def new_usage_totals() -> dict[str, int]:
    """usageトークン集計の初期値（全て0）。"""
    return {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
    }


def add_usage(totals: dict[str, int], usage: dict) -> None:
    """new_usage_totals()で作った集計辞書に、1回分のAPI呼び出しのusageを加算する。
    usage側に他のキー（stop_reason等）が含まれていても、totalsに存在するキーだけを
    加算するので無視される。usageが空辞書（個別リトライが完全に失敗した場合の
    フォールバック）でも安全に0加算になる。"""
    for key in totals:
        totals[key] += usage.get(key, 0) or 0


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
    範囲外の場合はNoneを返し、呼び出し元でこのインデックスを欠落扱いにする。

    2026-08-30、候補あり(candidates is not None)でもlen(rest)==2を許容するように
    変更した（project memory参照）。実API検証で、モデルが「候補はどれも不一致」と
    判断した際に末尾の候補一致番号(0)を書き忘れるケースが頻発すると判明し、
    従来はlen(rest)!=3を機械的に欠落扱いにしていたため、正しい判断（brand_poi
    ではないという結論）まで個別リトライ→再失敗→unknownとして握りつぶされていた。
    候補ありでもc1/c2の2要素だけ返ってきた場合は「候補不一致」の省略とみなし、
    matched_brand=Noneとして復元する。"""
    if candidates is None or len(rest) == 2:
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


# CATEGORY_RECHECK_CHOICES選定結果と、機械マッチしたブランド候補のうちどれが
# 一致したかの組（build_system_prompt_category_recheck参照）。choiceは
# "category"/"unique_poi"/"brand_poi"/"broken"のいずれか。matched_brandは候補の
# 中からLLMが選んだブランド名、該当なし/候補自体が無かった場合はNone
# （CandidateRecordのmatched_brandと同じ意味）。
RecheckRecord = tuple[str, str | None]


def _decode_recheck_tail(rest: list, candidates: list[str] | None) -> RecheckRecord | None:
    """decode_indexed_recheck_responsesの1件分。restはインデックスを除いた残りの
    要素（候補なしなら[choice_num]、候補ありなら[choice_num, idx]）。_decode_
    candidate_tailと同じ考え方だが、level12のc1/c2ペアではなくCATEGORY_RECHECK_
    CHOICESの単一選択肢を復元する。形式が不正・値が範囲外の場合はNoneを返し、
    呼び出し元でこのインデックスを欠落扱いにする。"""
    if candidates is None:
        if len(rest) != 1:
            return None
        choice = CATEGORY_RECHECK_CHOICES.get(rest[0])
        if choice is None:
            return None
        return choice, None

    if len(rest) != 2:
        return None
    choice_num, idx = rest
    choice = CATEGORY_RECHECK_CHOICES.get(choice_num)
    if choice is None:
        return None
    if not isinstance(idx, int) or idx < 0 or idx > len(candidates):
        return None
    matched_brand = candidates[idx - 1] if idx > 0 else None
    return choice, matched_brand


def decode_indexed_recheck_responses(
    raw_items: list, candidates_list: list[list[str] | None],
) -> tuple[list[RecheckRecord | None], set[int]]:
    """build_system_prompt_category_recheckが返すインデックス付き応答配列
    （各要素は[idx, choice_num]または[idx, choice_num, candidate_idx]）を、
    candidates_listと同じ順序・同じ長さのRecheckRecordのリストに変換する
    （decode_indexed_level12_responsesと同じインデックス方式、2026-08-28新設）。
    範囲外・型不正・重複したインデックス、およびデコードに失敗した要素は
    その位置をNoneのまま残す。戻り値の2つ目はNoneのまま残った（＝LLM応答から
    実質的に欠落した）インデックスの集合。"""
    n = len(candidates_list)
    records: list[RecheckRecord | None] = [None] * n
    for raw in raw_items:
        if not isinstance(raw, list) or len(raw) < 2:
            continue
        idx, rest = raw[0], raw[1:]
        if not isinstance(idx, int) or idx < 0 or idx >= n or records[idx] is not None:
            continue  # 範囲外・型不正・重複インデックスは無視する
        decoded = _decode_recheck_tail(rest, candidates_list[idx])
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


def _leaf_string_for_number(n) -> str | None:
    """build_system_prompt_level3が返す番号（プロンプト内で明示した「番号: カテゴリ名」
    列挙の番号、1始まり。0は"判定不能"）を、対応するtaxonomyのカテゴリ文字列
    （またはUNKNOWN_LEAF）に変換する。型不正・範囲外の番号はNoneを返し、呼び出し元
    （encode_leaves）がハルシネーション扱いで捨てる（2026-08-29新設、出力形式の
    文字列→番号化の一部。project memory参照）。"""
    if not isinstance(n, int):
        return None
    if n == 0:
        return UNKNOWN_LEAF
    taxonomy = brand_data.CATEGORY_TAXONOMY
    if 1 <= n <= len(taxonomy):
        return taxonomy[n - 1]
    return None


def decode_indexed_leaf_responses(raw_items: list, n: int) -> tuple[list[str | None], set[int]]:
    """build_system_prompt_level3が返すインデックス付き応答配列
    （各要素は[idx, 番号配列]。2026-08-29以前はカテゴリ文字列の配列だったが、
    outputトークン削減のためプロンプト内で明示した「番号: カテゴリ名」列挙の番号
    （1始まり、0は判定不能）の数値配列に変更した。project memory参照）を、長さnの
    リストに変換する
    （2026-08-27新設、decode_indexed_level12_responsesと同じインデックス方式）。
    範囲外・型不正・重複したインデックスの要素は無視する。戻り値の2つ目は
    Noneのまま残った（＝LLM応答から実質的に欠落した）インデックスの集合。"""
    records: list[str | None] = [None] * n
    for raw in raw_items:
        if not isinstance(raw, list) or len(raw) != 2:
            continue
        idx, numbers = raw
        if not isinstance(idx, int) or idx < 0 or idx >= n or records[idx] is not None:
            continue
        if not isinstance(numbers, list):
            numbers = []
        leaves = [s for s in (_leaf_string_for_number(x) for x in numbers) if s is not None]
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
