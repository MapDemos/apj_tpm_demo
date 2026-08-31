"""
analyze サブコマンドのHTMLレポートに添えるローマ字/英語の読み・表記を作るヘルパー
（2026-08-31新設）。

- D. Top Queries by Category: クエリ文字列にpykakasiで推定したローマ字読みを
  括弧書きで併記する（to_romaji）。
- I. POI Taxonomy Breakdown: category-taxonomy.js（brand_data.CATEGORY_TAXONOMY）
  の53件は固定・リポジトリ管理下のため、英訳を静的辞書TAXONOMY_ENとして
  ここに埋め込む（taxonomy_display_suffix）。辞書に無い値（taxonomyが将来
  改訂されて追加された場合）はto_romajiにフォールバックする。
- K. Brand Breakdown: ブランド名は brand-synonyms.js（BRAND_SYNONYMS、1472件の
  brand-synonyms.jsは手動翻訳が非現実的な件数かつgit管理外でいつ増減しても
  おかしくない）が既に多くのブランドに公式英語表記/ローマ字表記の別名を
  含んでいるため、まずそこからASCII表記を探し、無ければto_romajiに
  フォールバックする（brand_display_suffix）。どちらも見つからなければ
  併記なし（None）。

いずれもレポート生成時にレコード単位で呼ぶだけの静的ロジックで、実行時に
AI/外部APIは一切呼ばない（project memory参照: レポートのAI診断機能とは無関係）。
"""

import re

import pykakasi

from lib import brand_data

_kks = pykakasi.kakasi()

# 英数字・一部記号のみで構成された文字列かどうか（ローマ字化してもクエリ文字列と
# 見た目が変わらない＝括弧書きが無意味なケースを弾くための判定）。
_ASCII_ONLY_RE = re.compile(r"^[\x00-\x7f]*$")
_ASCII_CANDIDATE_RE = re.compile(r"^[A-Za-z0-9 \-\.\'&]+$")


def to_romaji(text: str) -> str | None:
    """pykakasi（辞書ベースの推定変換、AI不使用）でtextのローマ字読みを推定して
    返す。ASCIIのみの文字列（変換しても見た目が変わらない）や変換結果が空・
    元の文字列と同じ場合はNone（括弧書き不要のシグナル）。誤読みが起こり得る
    推定値である点に注意（project memory参照）。"""
    if not text or _ASCII_ONLY_RE.match(text):
        return None
    try:
        segments = _kks.convert(text)
    except Exception:
        return None
    romaji = " ".join(seg["hepburn"] for seg in segments if seg.get("hepburn"))
    romaji = romaji.strip()
    if not romaji or romaji == text:
        return None
    return " ".join(word.capitalize() for word in romaji.split(" "))


# category-taxonomy.js（brand_data.CATEGORY_TAXONOMY）53件の英訳。取得元は
# local/category_and_brand/category-taxonomy.js（2026-08-31時点の版）。
# taxonomyが改訂されてここに無い値が来た場合はtaxonomy_display_suffixが
# to_romajiにフォールバックする。
TAXONOMY_EN: dict[str, str] = {
    "スーパー": "Supermarket",
    "コンビニ": "Convenience store",
    "100円ショップ": "100 yen shop",
    "雑貨・文房具店": "Variety/stationery store",
    "ショッピングセンター": "Shopping center",
    "専門店（食品・飲料・酒・たばこ）": "Specialty store (food/beverage/alcohol/tobacco)",
    "専門店（家具・家電・インテリア）": "Specialty store (furniture/appliances/interior)",
    "専門店（アパレル・服飾雑貨）": "Specialty store (apparel/accessories)",
    "ホームセンター": "Home center",
    "自動車販売・カー用品": "Car dealer/auto parts",
    "ベビー・子ども用品店": "Baby/kids goods store",
    "ペットショップ": "Pet shop",
    "ホビー・スポーツ用品店": "Hobby/sporting goods store",
    "化粧品店": "Cosmetics store",
    "リユース店": "Reuse/secondhand store",
    "書店": "Bookstore",
    "花屋": "Flower shop",
    "携帯電話ショップ": "Mobile phone shop",
    "生活サービス": "Life services",
    "ガソリンスタンド": "Gas station",
    "レンタカー・カーシェア": "Rental car/car share",
    "駐車場": "Parking lot",
    "公共交通機関（バス停）": "Public transit (bus stop)",
    "公共交通機関（バス停以外）": "Public transit (other than bus stop)",
    "高速道路・IC": "Expressway/interchange",
    "空港": "Airport",
    "港湾": "Port/harbor",
    "道の駅": "Roadside station (michi-no-eki)",
    "観光名所": "Tourist attraction",
    "ランドマーク": "Landmark",
    "パチンコ": "Pachinko parlor",
    "カラオケ": "Karaoke",
    "その他レジャー": "Other leisure",
    "フィットネス": "Fitness",
    "入浴施設": "Bathhouse/onsen facility",
    "行政・公共施設": "Government/public facility",
    "学校・教育施設": "School/educational facility",
    "銀行・ATM": "Bank/ATM",
    "郵便局": "Post office",
    "宿泊施設": "Lodging",
    "マンション・アパート": "Apartment/condominium",
    "レストラン": "Restaurant",
    "ファーストフード": "Fast food",
    "カフェ": "Cafe",
    "病院": "Hospital",
    "診療所": "Clinic",
    "歯科": "Dentist",
    "動物病院": "Veterinary clinic",
    "薬局・ドラッグストア": "Pharmacy/drugstore",
    "美容サービス": "Beauty services",
    "宗教施設": "Religious facility",
    "オフィスビル": "Office building",
    "工場": "Factory",
}


def taxonomy_display_suffix(leaf: str) -> str | None:
    """I. POI Taxonomy Breakdownのラベル（ai_classification_3のリーフ、または
    compute_poi_taxonomy_breakdownが未分類時に使う"(unclassified)"）に添える
    英訳を返す。"""
    if leaf in TAXONOMY_EN:
        return TAXONOMY_EN[leaf]
    return to_romaji(leaf)


def brand_display_suffix(brand: str) -> str | None:
    """K. Brand Breakdownのラベル（ai_classification_2_brand、
    BRAND_CATEGORY_MAPのキー）に添える英語/ローマ字表記を返す。まず
    brand_data.BRAND_SYNONYMSの別名からASCII表記（例: "7-Eleven"）を探し、
    大文字を含む＝正式表記らしいものを優先する。見つからなければ
    to_romajiにフォールバックする。"""
    candidates = [s for s in brand_data.BRAND_SYNONYMS.get(brand, []) if _ASCII_CANDIDATE_RE.match(s)]
    if candidates:
        proper_case = [s for s in candidates if any(c.isupper() for c in s)]
        return (proper_case or candidates)[0]
    return to_romaji(brand)
