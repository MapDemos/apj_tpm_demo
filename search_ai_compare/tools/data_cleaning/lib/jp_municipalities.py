"""
日本の市区町村名（都道府県を除く行政区画名、約1,900件）の静的データ。

背景（project memory参照）: brand_match経由の候補注入とは無関係に、「加古川」
「喜多方」のような全国的な知名度がやや落ちる市区町村名がクエリ単体で来た場合、
Haikuが「これは有名な地名だ」と確信できず、BOUNDARY_GUIDANCEの「地名の既定値」
ルールが機能せずunique_poiに誤判定される実データ上のバグが見つかった。

都道府県(47件)はbrand_match.ADMINISTRATIVE_PLACE_NAMESで既に機械的に閉じた
集合として扱っているが、市区町村は約1,900件と多く「有名かどうか」をLLMの
知識・確信度に委ねるのは不安定すぎる。そこで、都道府県より一段踏み込んで、
「クエリ全体が市区町村名(サフィックス除去後)と完全一致する」場合は、LLMを
経由せずPython側で決定的にaddress/placeと確定させる設計にした
（brand_matchの「候補をヒントとしてLLMに見せる」方式とは異なり、この判定は
LLM呼び出し自体をスキップする。理由: ①出力スキーマを一切変えずに済み、今回の
BRAND_CANDIDATE_GUIDANCEで実際に踏んだ「候補ありの応答で末尾要素が省略される」
というデコード周りの非決定性リスクを再発させない、②該当クエリはAPIコスト
そのものが不要になる）。

前方一致（例: "仙台城"のような「地名+施設語」）はこの機械判定の対象外
（BOUNDARY_GUIDANCEの「地名の既定値」パラグラフの例外規定で引き続きLLMが
poi判定できるため、新しいシグナルは不要と判断した）。

既知のトレードオフ: 市区町村名と完全に同じ名前の実在ブランド・施設が万一
存在した場合、常にaddress側が勝つ（例: "北海道"という都道府県名と同名の
レストランブランドのケースで既に合意済みの方針と同じ考え方の延長）。

データ出典: ユーザー提供のmunicipalities.csv（都道府県,市区町村,市区町村
（ふりがな）の3列、総務省の全国地方公共団体コード相当）。"特別区部"（東京23区の
集計行、個々の区とは別に存在する合計行）のようにサフィックス(市/区/町/村)で
終わらない行は実在の市区町村名ではないため読み込み時に除外する。

local/ は search_ai_compare/.gitignore の "local/" ルールでこの
data_cleaning/local/も含めて除外されているローカル専用データのため、
brand_data.pyと同様にファイルが無い環境ではFileNotFoundErrorで分かりやすく
失敗させる。PyInstallerでビルドしたGUI(.app)でのパス解決もbrand_data.py
（poi-blocklist.js等と同じcategory_and_brandバンドル名）に合わせている。
"""

import csv
import sys
from pathlib import Path

from lib.kana_match import has_kanji, normalize_variants

# 市区町村名の末尾に必ず付く行政区画種別のサフィックス。クエリ側・データ側
# どちらも比較前にこれを1文字だけ取り除く（双方向のサフィックス除去）。
_SUFFIXES = ("市", "区", "町", "村")

# 「ヶ/ケ/ガ/が」の表記ゆれ統一対象文字（茅ヶ崎/茅ケ崎/茅が崎等）。
# search_ai_compare本体(app.js)の同種ロジックに倣い、漢字に挟まれている場合
# （カタカナ語の一部として出現する「ケ」等を誤って書き換えないため）に限定する。
_GA_VARIANT_CHARS = ("ヶ", "ケ", "ガ", "が")
_GA_CANONICAL = "ヶ"

# 政令指定都市(20件)は、この出典データ(総務省の全国地方公共団体コード相当)では
# 「市」単位の行を持たず、区(青葉区・中央区等)単位でのみ分解されて収録されている
# （実データで確認済み: "仙台"がMUNICIPALITY_FORMSに含まれず、"青葉区"等の区名
# だけが含まれていた）。しかし政令指定都市はいずれも全国的に有名な大都市であり、
# 本来は"地名の既定値"ルール（BOUNDARY_GUIDANCE）だけでもLLMが正しくaddress判定
# できていた実績があるため機械判定への追加は必須ではないが、機械判定の対象を
# 一貫させる（"仙台市"付きクエリも含めて確実にカバーする）ため補完的に追加する。
_DESIGNATED_CITIES = (
    "札幌市", "仙台市", "さいたま市", "千葉市", "横浜市", "川崎市", "相模原市",
    "新潟市", "静岡市", "浜松市", "名古屋市", "京都市", "大阪市", "堺市",
    "神戸市", "岡山市", "広島市", "北九州市", "福岡市", "熊本市",
)


def _data_dir() -> Path:
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", "."))
        return base / "category_and_brand"
    return Path(__file__).resolve().parents[1] / "local" / "category_and_brand"


_CSV_PATH = _data_dir() / "municipalities.csv"


def _unify_ga_variant(s: str) -> str:
    chars = list(s)
    for i, ch in enumerate(chars):
        if ch not in _GA_VARIANT_CHARS:
            continue
        prev_kanji = i > 0 and has_kanji(chars[i - 1])
        next_kanji = i < len(chars) - 1 and has_kanji(chars[i + 1])
        if prev_kanji and next_kanji:
            chars[i] = _GA_CANONICAL
    return "".join(chars)


def _strip_suffix(name: str) -> str:
    if name and name[-1] in _SUFFIXES:
        return name[:-1]
    return name


def _normalize_for_match(name: str) -> str:
    # 全角スペースを半角に揃えてから前後の空白を除去する。
    name = name.replace("　", " ").strip()
    name = _strip_suffix(name)
    name = _unify_ga_variant(name)
    return name


def _load_municipality_forms() -> frozenset[str]:
    if not _CSV_PATH.exists():
        raise FileNotFoundError(
            f"{_CSV_PATH} が見つかりません（search_ai_compare/local/ はgit管理外の"
            "ローカル専用データです。手元にmunicipalities.csvのコピーが必要です）"
        )
    forms: set[str] = set()
    with _CSV_PATH.open(encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            raw = (row.get("市区町村") or "").strip()
            # "特別区部"のような集計行（末尾がサフィックスでない）は実在の
            # 市区町村名ではないため除外する。
            if not raw or raw[-1] not in _SUFFIXES:
                continue
            normalized = _normalize_for_match(raw)
            if not normalized:
                continue
            forms.update(normalize_variants(normalized))
    for raw in _DESIGNATED_CITIES:
        forms.update(normalize_variants(_normalize_for_match(raw)))
    return frozenset(forms)


MUNICIPALITY_FORMS: frozenset[str] = _load_municipality_forms()


def is_bare_municipality_name(query: str) -> bool:
    """クエリ全体が市区町村名(サフィックス除去・表記ゆれ正規化後)と完全一致する
    場合にTrueを返す。前方一致（地名+追加の語）は対象外（モジュールdocstring
    参照）。"""
    if not query or not query.strip():
        return False
    normalized = _normalize_for_match(query)
    if not normalized:
        return False
    return bool(normalize_variants(normalized) & MUNICIPALITY_FORMS)
