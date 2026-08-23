#!/usr/bin/env bash
# gui_app.py を単体の .app にビルドするスクリプト。
# 同僚に配布する場合、このスクリプトを実行したマシンで生成された
# dist/Octopus.app をそのままコピーして渡せばよい
# （colleague側にPython・pipのインストールは不要）。
#
# 未署名ビルドのため、colleague側の初回起動時にGatekeeperの警告が出る。
# 「右クリック→開く」で起動できることを一言伝えておくこと。
set -euo pipefail
cd "$(dirname "$0")"

BUILD_VENV=".build_venv"

# Homebrewのpython3(python-tk@3.14)はTcl/Tk 9.0にリンクされているが、
# Tk9はmacOS上でトラックパッドのMouseWheelイベントを一般的なウィジェット
# （CustomTkinterの描画に使うtkinter.Frame等）に配送しない既知の問題があり、
# ページ全体の縦スクロールがトラックパッドで効かなくなる。
# pyenvでTcl/Tk 8.6にリンクしてビルドしたPythonがあればそちらを優先して使う
# （なければ通常のpython3にフォールバック。動くには動くがトラックパッド
# スクロールの制限が残る）。
BUILD_PYTHON="$HOME/.pyenv/versions/3.12.14/bin/python3.12"
if [ ! -x "$BUILD_PYTHON" ]; then
    echo "警告: Tcl/Tk 8.6版Python(${BUILD_PYTHON})が見つからないため、通常のpython3でビルドします。"
    echo "      Tk9のトラックパッド縦スクロール制限が.appに残ります。"
    BUILD_PYTHON="python3"
fi

if [ ! -d "$BUILD_VENV" ]; then
    echo "ビルド用venvを作成します: $BUILD_VENV (${BUILD_PYTHON})"
    "$BUILD_PYTHON" -m venv "$BUILD_VENV"
fi

# shellcheck disable=SC1091
source "$BUILD_VENV/bin/activate"
pip install --quiet --upgrade pip
pip install --quiet pyinstaller anthropic customtkinter

rm -rf build dist

pyinstaller --noconfirm --windowed \
    --name "Octopus" \
    --osx-bundle-identifier "com.mapbox.octopus" \
    --copy-metadata anthropic \
    --collect-data customtkinter \
    --add-data "gui_theme.json:." \
    gui_app.py

echo
echo "ビルド完了: dist/Octopus.app"
echo "colleagueに配布する際は dist/Octopus.app を zip などでそのまま渡してください。"
