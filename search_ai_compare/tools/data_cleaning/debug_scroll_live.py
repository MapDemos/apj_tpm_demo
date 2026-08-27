#!/usr/bin/env python3
"""
トラックパッド縦スクロールが効かない問題の切り分け用の一時デバッグスクリプト。
本番のgui_app.pyは変更せず、CTkScrollableFrameの内部メソッドをモンキーパッチして
実機のトラックパッド操作でMouseWheelイベントが実際にPython側まで届いているかを
ターミナルにprintする。

使い方:
  cd search_ai_compare/tools/data_cleaning
  source .venv/bin/activate
  python3 debug_scroll_live.py

ウィンドウが開いたら、CSVプレビュー表以外の場所（実行設定カードやログカードの
あたり）にカーソルを置いてトラックパッドで縦スワイプしてみてください。
ターミナルに "### _mouse_wheel_all fired" が出るかどうかを見てください。

- 何も出ない  → MouseWheelイベント自体がPythonまで届いていない（OS/Tkレイヤーの話）
- 出るが最後の行が "SKIPPED" → _check_if_valid_scrollがFalseを返している
- 出て "SCROLLED" まで出る    → ロジック上は動いているのに画面が動かない別の問題
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import customtkinter as ctk  # noqa: E402

import gui_app  # noqa: E402

_orig_wheel = ctk.CTkScrollableFrame._mouse_wheel_all


def _traced_wheel(self, event):
    valid = self._check_if_valid_scroll(event.widget)
    print(f"### _mouse_wheel_all fired: widget={event.widget!r} delta={event.delta} valid={valid}")
    result = _orig_wheel(self, event)
    print("### -> SCROLLED" if valid else "### -> SKIPPED (invalid scroll target)")
    return result


ctk.CTkScrollableFrame._mouse_wheel_all = _traced_wheel

if __name__ == "__main__":
    gui_app.main()
