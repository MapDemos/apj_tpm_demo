#!/usr/bin/env bash
# gui_app.py を単体の .app にビルドするスクリプト。
# 同僚に配布する場合、このスクリプトを実行したマシンで生成された
# dist/Athena CSV Tool.app をそのままコピーして渡せばよい
# （colleague側にPython・pipのインストールは不要）。
#
# 未署名ビルドのため、colleague側の初回起動時にGatekeeperの警告が出る。
# 「右クリック→開く」で起動できることを一言伝えておくこと。
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
pip install --quiet pyinstaller anthropic

rm -rf build dist

pyinstaller --noconfirm --windowed \
    --name "Athena CSV Tool" \
    --osx-bundle-identifier "com.mapbox.athena-csv-tool" \
    --copy-metadata anthropic \
    gui_app.py

echo
echo "ビルド完了: dist/Athena CSV Tool.app"
echo "colleagueに配布する際は dist/Athena CSV Tool.app を zip などでそのまま渡してください。"
