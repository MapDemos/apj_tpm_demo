"""
data_cleaning/local/category_and_brand/ 配下のJS定義ファイル
(category-taxonomy.js / poi-blocklist.js) を読み込むローダー。

両ファイルはブラウザ側JSでも使われる `const NAME = <JSON互換オブジェクト>;` という
形式で書かれている。Pythonからは正規表現で `const NAME = ` prefixと末尾の `;` を
取り除いてから json.loads() するだけで読める（本文はダブルクォート・末尾カンマなしの
JSON互換記法で統一されている）。

2026-08-27、元々あった search_ai_compare/local/category_and_brand/ から
data_cleaning直下へ移動・コピーした（project memory参照）。
- poi-blocklist.js: search_ai_compare本体(app.js)は一切参照しておらず、Python側専用
  だったため移動（二重管理を避ける）。
- category-taxonomy.js: search_ai_compare本体(app.js)のAsk AI機能でも別途使われて
  いるが、app.js側はプロジェクトを跨いだimportができないため元々手動コピーしたもの
  （同期不要・独立管理が前提）。data_cleaning側でtaxonomyを簡略化していく計画のため、
  こちらはコピーにして元のファイルはsearch_ai_compare/local/にそのまま残した。

local/ は search_ai_compare/.gitignore の "local/" ルール（先頭に"/"が無いため
ツリー中のどの深さのlocal/にもマッチする）でこのdata_cleaning/local/も含めて
除外されているローカル専用データのため、このファイルが無い環境（新規clone直後など）
ではImportErrorではなくFileNotFoundErrorに分かりやすいメッセージを添えて失敗させる。

PyInstallerでビルドしたGUI(.app)ではsource treeがそのまま存在しないため、
build_gui.shの--add-dataで"category_and_brand"という名前でバンドル直下に
コピーしている前提でパスを解決する（gui_app.py の _resource_path() と同じ
sys._MEIPASS方式。ただしbrand_data.pyはlib/配下でgui_app.pyから離れているため
専用のロジックとして持つ）。
"""

import json
import re
import sys
from pathlib import Path


def _data_dir() -> Path:
    if getattr(sys, "frozen", False):
        # PyInstallerのonefile/onedirいずれでもsys._MEIPASSが展開先を指す。
        # build_gui.shの --add-data "...:category_and_brand" でこの名前に
        # コピーしている前提。
        base = Path(getattr(sys, "_MEIPASS", "."))
        return base / "category_and_brand"
    # 開発時: lib/ -> data_cleaning -> local/category_and_brand
    return Path(__file__).resolve().parents[1] / "local" / "category_and_brand"


_DATA_DIR = _data_dir()
_TAXONOMY_PATH = _DATA_DIR / "category-taxonomy.js"
_BLOCKLIST_PATH = _DATA_DIR / "poi-blocklist.js"
_SYNONYMS_PATH = _DATA_DIR / "brand-synonyms.js"


def _load_js_const(path: Path, const_name: str):
    if not path.exists():
        raise FileNotFoundError(
            f"{path} が見つかりません（search_ai_compare/local/ はgit管理外のローカル専用"
            "データです。手元にコピーが必要です）"
        )
    text = path.read_text(encoding="utf-8")
    m = re.search(rf"const {const_name} = (\{{.*?\n\}}|\[.*?\n\]);\n", text, re.S)
    if not m:
        raise ValueError(f"{path} から {const_name} を抽出できませんでした")
    return json.loads(m.group(1))


def load_category_taxonomy() -> list[str]:
    """category-taxonomy.js の CATEGORY_TAXONOMY（285件のリーフ文字列）を返す。"""
    return _load_js_const(_TAXONOMY_PATH, "CATEGORY_TAXONOMY")


def load_brand_category_map() -> dict[str, list[str]]:
    """poi-blocklist.js の BRAND_CATEGORY_MAP（ブランド名→taxonomyリーフ配列）を返す。"""
    return _load_js_const(_BLOCKLIST_PATH, "BRAND_CATEGORY_MAP")


def load_brand_synonyms() -> dict[str, list[str]]:
    """brand-synonyms.js の BRAND_SYNONYMS（ブランド名→別名/略称/表記ゆれ配列）を返す。
    BRAND_CATEGORY_MAPのキーと1:1対応ではなく部分集合（確信度の高い別名が
    見つかったブランドのみ）。ファイルが無い環境（生成前）でも失敗させず、
    空辞書にフォールバックする（このデータはBRAND_CATEGORY_MAPと違い必須ではなく、
    候補生成の補助的な拡張データのため）。"""
    if not _SYNONYMS_PATH.exists():
        return {}
    return _load_js_const(_SYNONYMS_PATH, "BRAND_SYNONYMS")


CATEGORY_TAXONOMY: list[str] = load_category_taxonomy()
CATEGORY_TAXONOMY_SET: set[str] = set(CATEGORY_TAXONOMY)
BRAND_CATEGORY_MAP: dict[str, list[str]] = load_brand_category_map()
BRAND_SYNONYMS: dict[str, list[str]] = load_brand_synonyms()
