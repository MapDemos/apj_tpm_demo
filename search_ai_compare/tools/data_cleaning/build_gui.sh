#!/usr/bin/env bash
# gui_app.py を単体の .app にビルドするスクリプト。
# 同僚に配布する場合、このスクリプトを実行したマシンで生成された
# dist/Octopus.app をそのままコピーして渡せばよい
# （colleague側にPython・pipのインストールは不要）。
#
# 未署名ビルドのため、colleague側の初回起動時にGatekeeperの警告が出る。
# 「右クリック→開く」で起動できることを一言伝えておくこと。
#
# 2026-08-25、GUIをCustomTkinter(tkinter)からPySide6(Qt)へ全面移行した
# （project_athena_csv_gui参照。Tk9のトラックパッドスクロール不具合・
# readonly Entryの表示不具合など、実機でしか再現しない低レベルの環境依存
# バグが積み重なったため）。これに伴い、ビルド用に別Pythonを探す処理
# （Tcl/Tk 8.6リンク版）は不要になったため削除した。Qtは素のsystem python3で
# 問題なくビルドできる。
set -euo pipefail
cd "$(dirname "$0")"

BUILD_VENV=".build_venv"

if [ ! -d "$BUILD_VENV" ]; then
    echo "ビルド用venvを作成します: $BUILD_VENV"
    python3 -m venv "$BUILD_VENV"
fi

# shellcheck disable=SC1091
source "$BUILD_VENV/bin/activate"
pip install --quiet --upgrade pip
# anthropicはmain.pyのANTHROPIC_PINと同じ範囲でpinする（1.0.0でMessages.create()の
# temperature引数が削除される等の破壊的変更があり、無指定だとビルドのたびに
# 違うバージョンが混入して同じバグを踏み直すため。2026-08-27発覚）。
# pykakasiはanalyzeのHTMLレポート（ローマ字読みの推定、lib/report_i18n.py）用。
# jaconv非依存で辞書データを自パッケージ内(pykakasi/data)に持つため、PyInstaller側で
# --collect-data pykakasiを付けないとデータファイルが同梱されない点に注意。
pip install --quiet pyinstaller "anthropic>=0.122,<1" PySide6 pykakasi

rm -rf build dist

# lib/brand_data.py（ai-classifyのBRAND_KNOWLEDGE参照データ）が使う
# category-taxonomy.js / poi-blocklist.js は data_cleaning/local/（gitignore対象、
# 2026-08-27にsearch_ai_compare/local/から移動・コピー。project memory参照）
# 配下にあり、source treeのままではバンドルに含まれない。build_gui.sh実行マシンの
# 手元コピーから "category_and_brand" という名前でバンドル直下にコピーする
# （brand_data.pyのfrozen時のパス解決と対応）。
CATEGORY_AND_BRAND_DIR="local/category_and_brand"
if [ ! -d "$CATEGORY_AND_BRAND_DIR" ]; then
    echo "エラー: ${CATEGORY_AND_BRAND_DIR} が見つかりません（ビルドするマシンに手元コピーが必要です）"
    exit 1
fi

pyinstaller --noconfirm --windowed \
    --name "Octopus" \
    --osx-bundle-identifier "com.mapbox.octopus" \
    --copy-metadata anthropic \
    --collect-data pykakasi \
    --add-data "${CATEGORY_AND_BRAND_DIR}:category_and_brand" \
    gui_app.py

echo
echo "ビルド完了: dist/Octopus.app"
echo "colleagueに配布する際は dist/Octopus.app を zip などでそのまま渡してください。"
