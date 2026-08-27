#!/usr/bin/env python3
"""
main.py（CSVクレンジング・AI分類・傾向分析CLI）のPySide6 GUIラッパー（Octopus）。

同僚に配布する.appにパッケージングするためのエントリポイント
（build_gui.sh参照）。ロジックは一切持たず、main.pyのcmd_*関数を
argparse.Namespace相当のオブジェクトで直接呼び出すだけ。
出力先は lib/output_utils.py が frozen(.app化)時に自動で
~/Documents/AthenaCSVTool/local_output/ に切り替える。

見た目まわり:
  常時ダーク固定・独自配色（このファイル内のQSSスタイルシート、Mapboxっぽい
  寒色系アクセント）で統一している。全ウィジェットが素のQt標準ウィジェット
  （QLineEdit/QComboBox/QSpinBox/QTableWidget等）なので、CustomTkinter版で
  必要だった「表だけttkで別スタイル」「ステッパー欄の描画不整合ワークアラウンド」
  「readonly Entryの表示不具合」「循環参照GCのメインスレッド固定」は一切不要
  （2026-08-25、CustomTkinter版からPySide6へ全面移行。経緯はproject_athena_csv_gui
  参照）。
  CSVプレビュー表（QTableWidget）以外は横スクロールを出さない方針。長い説明文は
  QLabelのword-wrapで折り返す（2026-08-25、ウィンドウ幅を狭くした際に追加）。

画面構成（2026-08-25、タブ2枚構成から単一画面に統合。理由は下記）:
  ファイルを開く → プレビュー（列+先頭5行） → 実行設定（出力先 → ツール選択
  [AIによるクエリの分類/クエリの分析] → オプション欄 → 実行/見積） → ログ →
  出力結果のプレビュー
  旧「クエリの分析」タブの内容（analyzeツール）は実行設定のツール選択に統合。
  重複クエリの除去（dedup）は2026-08-27より専用ボタンを廃止し、AIによるクエリの
  分類の実行時に自動で前段実行する方式に変更した（_run_in_thread参照）。
  APIキー・使用モデルの選択もヘッダーの⚙設定（SettingsDialog）に集約した。
  2026-08-27、プロキシ（Lambda URL）経由の呼び出しを廃止し、本物のAnthropic
  APIキーを直接使う方式に統一（同期・並行呼び出しがデフォルト、実行設定欄の
  「Batches API使用」チェックでオンにすると非同期のBatches API・50%割引に切替）。
  add-query-count（同一クエリの出現回数列の追加）とcount-column（出現回数の集計）は
  GUIからは廃止（CLIでは引き続き利用可）。
"""

import csv
import itertools
import math
import os
import sys
import threading
import time

from PySide6.QtCore import Qt, QObject, Signal
from PySide6.QtGui import QFont, QTextCursor
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDialog,
    QFileDialog,
    QFrame,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QProgressBar,
    QPushButton,
    QScrollArea,
    QSpinBox,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import main as cli_main  # noqa: E402
from lib import classification_common as classification_common_lib  # noqa: E402
from lib import output_utils as output_utils_lib  # noqa: E402
from lib import row_filter as row_filter_lib  # noqa: E402
from lib.output_utils import OUTPUT_DIR  # noqa: E402

# lib/output_utils.pyのmake_output_path()は、呼び出し時点で自分のモジュール内の
# グローバル変数OUTPUT_DIRを参照する（importで固定した値ではない）ため、
# output_utils_lib.OUTPUT_DIRを選択フォルダで上書きしてからmain.pyのcmd_*関数を
# 呼べば、CLI側のロジックを一切変更せずに出力先を切り替えられる。
# OUTPUT_DIR（定数側のimport）は「アプリ起動時点の既定値」を保持するためだけに使う。

APP_TITLE = "Octopus"

# ---------- 配色（QSSスタイルシートと対応） ----------
COLOR_BG = "#1A1D24"
COLOR_PANEL = "#242833"
COLOR_BORDER = "#333947"
COLOR_TEXT = "#E7E9EE"
COLOR_MUTED = "#8B93A6"
COLOR_ACCENT = "#4264FB"
COLOR_ACCENT_HOVER = "#2F4FE0"
COLOR_ENTRY_BG = "#20242C"

STYLESHEET = f"""
QWidget {{
    background-color: {COLOR_BG};
    color: {COLOR_TEXT};
    font-size: 13px;
}}
QLabel[muted="true"] {{
    color: {COLOR_MUTED};
}}
QFrame#card {{
    background-color: {COLOR_PANEL};
    border: 1px solid {COLOR_BORDER};
    border-radius: 12px;
}}
QFrame#divider {{
    background-color: {COLOR_BORDER};
    max-height: 1px;
    min-height: 1px;
}}
QScrollArea {{
    border: none;
}}
QPushButton {{
    background-color: {COLOR_PANEL};
    color: {COLOR_TEXT};
    border: 1px solid {COLOR_BORDER};
    border-radius: 6px;
    padding: 6px 14px;
}}
QPushButton:hover {{
    background-color: {COLOR_BORDER};
}}
QPushButton:disabled {{
    color: {COLOR_MUTED};
}}
QPushButton#runButton {{
    background-color: {COLOR_ACCENT};
    color: #F5F7FA;
    font-weight: bold;
    border: none;
}}
QPushButton#runButton:hover {{
    background-color: {COLOR_ACCENT_HOVER};
}}
QPushButton#runButton:disabled {{
    background-color: {COLOR_BORDER};
    color: {COLOR_MUTED};
}}
QLineEdit, QComboBox, QSpinBox {{
    background-color: {COLOR_ENTRY_BG};
    color: {COLOR_TEXT};
    border: 1px solid {COLOR_BORDER};
    border-radius: 6px;
    padding: 4px 8px;
}}
QLineEdit:read-only {{
    color: {COLOR_MUTED};
}}
QComboBox::drop-down {{
    border: none;
}}
QTableWidget {{
    background-color: {COLOR_ENTRY_BG};
    color: {COLOR_TEXT};
    gridline-color: {COLOR_BORDER};
    border: 1px solid {COLOR_BORDER};
}}
QHeaderView::section {{
    background-color: {COLOR_PANEL};
    color: {COLOR_TEXT};
    padding: 4px;
    border: none;
    border-bottom: 1px solid {COLOR_BORDER};
    font-weight: bold;
}}
QProgressBar {{
    background-color: {COLOR_ENTRY_BG};
    border: 1px solid {COLOR_BORDER};
    border-radius: 3px;
    text-align: center;
}}
QProgressBar::chunk {{
    background-color: {COLOR_ACCENT};
    border-radius: 3px;
}}
QPlainTextEdit {{
    background-color: {COLOR_ENTRY_BG};
    color: {COLOR_TEXT};
    border: 1px solid {COLOR_BORDER};
}}
QCheckBox::indicator {{
    width: 16px;
    height: 16px;
    border: 1px solid {COLOR_BORDER};
    border-radius: 3px;
    background-color: {COLOR_ENTRY_BG};
}}
QCheckBox::indicator:checked {{
    background-color: {COLOR_ACCENT};
    border-color: {COLOR_ACCENT};
}}
"""


# ---------- AI設定の一元管理 ----------
# 各ツールのAPIキー入力欄・モデル選択をヘッダーの⚙設定ダイアログに集約し、
# 全てのAI処理がここから読む（2026-08-27、モデル選択も各ツールの実行設定欄から
# ここに移動）。バッチサイズ・並行数・Batches API使用の有無は引き続き各ツールの
# 実行設定欄で個別に持つ。非persistent（ディスクに保存しない）。
class AISettings:
    def __init__(self) -> None:
        self.api_key: str = ""
        self.ai_classify_model: str = "haiku+sonnet"
        self.analyze_model: str = "sonnet"


AI_SETTINGS = AISettings()


# ---------- AI呼び出しコストの見積り ----------
# USD/1Mトークンのリスト価格。Sonnet 5には2026-08-31までの導入価格($2/$10)があるが、
# 導入期間が終わっても見積りロジックを直さなくて済むよう、恒久的なリスト価格を採用する。
PRICING_PER_MTOK: dict[str, tuple[float, float]] = {
    "claude-haiku-4-5-20251001": (1.00, 5.00),
    "claude-sonnet-5": (3.00, 15.00),
}
BATCH_API_DISCOUNT = 0.5  # Message Batches API使用時は通常価格の50%

DEFAULT_BATCH_SIZE = 30
DEFAULT_WORKERS = 8


def _load_unique_queries_for_estimate(
    input_csv: str, filter_column: str | None, filter_op: str | None, filter_value: str | None
) -> list[str]:
    """見積り用に、query列のユニーク値だけを抽出する。filter_column指定時は
    ai-classify本体の絞り込みと同じロジック（row_filter_lib）で対象行を絞り込んだ
    上で抽出する。"""
    with open(input_csv, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        if not fieldnames or "query" not in fieldnames:
            raise ValueError('入力CSVに "query" 列が見つかりません')
        if filter_column and filter_column not in fieldnames:
            raise ValueError(f'絞り込み対象の列 "{filter_column}" が入力CSVに見つかりません')
        rows = list(reader)

    target_indices = row_filter_lib.filter_row_indices(rows, filter_column, filter_op, filter_value)
    queries = [rows[i].get("query", "") for i in target_indices]
    return list(dict.fromkeys(queries))


# ---------- クエリ列の確認ダイアログ ----------
# 本ツールはクエリの分析・クレンジングツールであり、各サブコマンドは列名「query」を
# 前提にハードコードされている。表記ゆれのあるCSV（「検索キーワード」等）を誤って
# そのまま処理すると分かりにくい失敗になるため、ファイル読み込み時に列名を検査し、
# クエリ列らしき候補を情報表示するだけの確認ダイアログを出す（自動リネーム等の
# 処理変更は行わない）。
QUERY_COLUMN_CANDIDATES = [
    "query", "q", "クエリ", "検索キーワード", "キーワード", "search keyword", "key word",
    "keyword", "keywords", "search term", "search_term", "search query", "search_query",
    "クエリ文字列", "検索語", "検索クエリ", "検索文言", "user_query", "query_text", "query_string",
]


def _detect_query_column_candidates(header: list[str]) -> list[str]:
    normalized = {c.lower() for c in QUERY_COLUMN_CANDIDATES}
    return [col for col in header if col.strip().lower() in normalized]


def _resource_path(*parts: str) -> str:
    """開発時(python3 gui_app.py)とPyInstallerでfrozen化された.app実行時の
    両方で、同梱リソース（category_and_brand/）を正しいパスで見つけるための
    ヘルパー。frozen時はsys._MEIPASSが展開先の一時ディレクトリを指す
    （lib/brand_data.pyも同じ方式でパス解決している）。"""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, *parts)


class _Args:
    """main.pyのcmd_xxx関数がargs.xxxでアクセスする属性を持つだけの簡易Namespace。"""


class ThreadSignals(QObject):
    """バックグラウンドスレッド（threading.Thread）からGUIスレッドへログ行・完了を
    伝えるためのシグナル。Qtのシグナルはスレッドをまたいでemitしても、受信側の
    QObjectがGUIスレッドに属していれば自動的にそのイベントループにキューイングされる
    （Qt::AutoConnectionのデフォルト動作）ため、tkinter版で必要だった
    Queue+after()ポーリングは不要。"""

    log = Signal(str)
    done = Signal(object)  # Exception | None


class QueueWriter:
    """print()の出力をThreadSignals.log経由でログ欄に流すためのsys.stdout/stderr差し替え先。"""

    def __init__(self, signals: ThreadSignals):
        self.signals = signals

    def write(self, text: str) -> None:
        if text:
            self.signals.log.emit(text)

    def flush(self) -> None:
        pass


def _muted_label(text: str, parent: QWidget | None = None, wrap: bool = False) -> QLabel:
    label = QLabel(text, parent)
    label.setProperty("muted", "true")
    if wrap:
        label.setWordWrap(True)
    return label


def _section_card(parent_layout: QVBoxLayout, title: str) -> QVBoxLayout:
    """タイトル付きの角丸カードを1枚作り、中身を積むためのlayoutを返す。
    プレビュー/実行設定/ログ/出力結果のプレビューをそれぞれ独立したカードとして見せる。"""
    card = QFrame()
    card.setObjectName("card")
    card_layout = QVBoxLayout(card)
    card_layout.setContentsMargins(16, 14, 16, 16)

    title_label = QLabel(title)
    title_label.setFont(QFont(title_label.font().family(), 13, QFont.Bold))
    card_layout.addWidget(title_label)

    body = QVBoxLayout()
    card_layout.addLayout(body)
    parent_layout.addWidget(card)
    return body


def _divider(parent_layout: QVBoxLayout) -> None:
    line = QFrame()
    line.setObjectName("divider")
    parent_layout.addWidget(line)


def _clear_layout(layout) -> None:
    while layout.count():
        item = layout.takeAt(0)
        widget = item.widget()
        if widget is not None:
            widget.deleteLater()
        elif item.layout() is not None:
            _clear_layout(item.layout())


# ---------- コマンド別オプションのビルダー ----------
# それぞれlayout(親レイアウト)にウィジェットを積み、{パラメータ名: 値を返すgetter} を
# 返す。main.pyのargs.xxxと同じ名前をキーにしているので、_build_argsで機械的に
# 詰め替えられる。ゼロ引数callableを使うことで、Qtの各ウィジェット
# （QLineEdit.text/QComboBox.currentText/QCheckBox.isChecked/QSpinBox.value）の
# 読み取り方法の違いをここに閉じ込める。


def _option_row(layout: QVBoxLayout, label: str) -> QHBoxLayout:
    row = QHBoxLayout()
    # ラベルにsetFixedWidth()で固定幅を与えると、実機のフォント（日本語CJK）で
    # その幅より広い文字列だとテキストが黙って欠ける（オフスクリーンでのテスト計測は
    # 実機のフォントメトリクスと一致しない場合があり、これに気付けなかった）。
    # 固定幅を廃止し、ラベルの自然なサイズ（常にテキスト全体を表示できる幅）に任せる。
    row_label = _muted_label(label)
    row.addWidget(row_label)
    layout.addLayout(row)
    return row


def _bound_combo_width(combo: QComboBox, min_chars: int = 12) -> None:
    """QComboBoxは既定でリスト中最長の項目テキストを黙って全部表示できる幅を
    要求する（ラベルのようにword-wrapできない）。項目テキストの長さに応じて
    ウィンドウ全体が横スクロール必須になってしまうのを防ぐため、
    「表示上の最小文字数」だけを保証し、それより広い項目は選択時に "..." で
    省略表示させる（ドロップダウンを開いたときの一覧は省略されず全文表示される）。"""
    combo.setSizeAdjustPolicy(QComboBox.SizeAdjustPolicy.AdjustToMinimumContentsLengthWithIcon)
    combo.setMinimumContentsLength(min_chars)


def _model_preset_display_label(preset: str) -> str:
    """ai-classifyのモデル選択コンボボックス用の表示テキスト（preset名＋実際の
    モデルID）。classification_common.model_preset_labelはCLIの実行後ログ向けで
    "ai_classification/_2: ..."のような長い前置きが付くため、ドロップダウンには
    このgui_app.py専用の短い版を使う。"""
    level12_model, level3_model = classification_common_lib.MODEL_PRESETS[preset]
    if level12_model == level3_model:
        return f"{preset} ({level12_model})"
    return f"{preset} ({level12_model} + {level3_model})"


def build_ai_options(page: "MainPage", layout: QVBoxLayout) -> dict:
    """AIによるクエリの分類の設定欄。旧「ai-retry」ツールはここに統合済み
    （2026-08-25）: 「絞り込み(任意)」で列×演算子×値を指定すると、その行だけが
    AIに送られる。未指定（列が"(指定なし)"のまま）なら全行が対象で、従来の
    ai-classifyと同じ動作になる。列の選択肢は読み込んだCSVのヘッダーから動的に
    取り出す（_choose_csvがpage.filter_column_comboを見て読み込み時に更新する）。"""
    option_getters: dict[str, object] = {}

    layout.addWidget(_muted_label("絞り込み(任意。指定なしなら全行が対象)", wrap=True))

    filter_row = QHBoxLayout()
    layout.addLayout(filter_row)
    column_combo = QComboBox()
    column_combo.addItem(row_filter_lib.NO_FILTER_LABEL)
    if page.input_csv:
        column_combo.addItems(page.csv_header)
    _bound_combo_width(column_combo, min_chars=10)
    filter_row.addWidget(column_combo, stretch=2)
    op_combo = QComboBox()
    op_combo.addItems(row_filter_lib.OPERATORS)
    _bound_combo_width(op_combo, min_chars=6)
    filter_row.addWidget(op_combo, stretch=1)
    value_edit = QLineEdit()
    value_edit.setPlaceholderText("値")
    filter_row.addWidget(value_edit, stretch=2)

    page.filter_column_combo = column_combo

    def _get_filter_column() -> str | None:
        text = column_combo.currentText()
        return text if text != row_filter_lib.NO_FILTER_LABEL else None

    option_getters["filter_column"] = _get_filter_column
    option_getters["filter_op"] = op_combo.currentText
    option_getters["filter_value"] = value_edit.text

    # 2026-08-27、モデル選択はヘッダーの⚙設定（SettingsDialog）に移動した
    # （AI_SETTINGS.ai_classify_model）。「最大バッチ数」は「少量実行して見積」
    # ボタンで十分カバーできるためGUIからは廃止（CLIでは引き続き利用可）。
    # 並行数・Batches API使用は、2026-08-25にプロキシ（Lambda URL）経由を
    # 廃止して本物のAnthropic APIキーを直接使う方式に変わった後も、
    # 「同期・並行 vs 非同期バッチ(50%割引)」という選択自体は引き続き意味を持つ
    # ため残す（勘違いで一度削除しかけたが、並行数はプロキシ固有の概念ではなく
    # 直接APIキーで並行呼び出しする場合にも普通に有効な設定だった）。
    batch_size_spin = QSpinBox()
    batch_size_spin.setRange(1, 100)
    batch_size_spin.setValue(DEFAULT_BATCH_SIZE)
    row = _option_row(layout, "バッチサイズ")
    row.addWidget(batch_size_spin)
    row.addStretch(1)
    option_getters["batch_size"] = batch_size_spin.value

    workers_spin = QSpinBox()
    workers_spin.setRange(1, 32)
    workers_spin.setValue(DEFAULT_WORKERS)
    row = _option_row(layout, "並行数")
    row.addWidget(workers_spin)
    row.addStretch(1)
    option_getters["workers"] = workers_spin.value

    batch_api_row = QVBoxLayout()
    layout.addLayout(batch_api_row)
    batch_api_top = QHBoxLayout()
    batch_api_row.addLayout(batch_api_top)
    batch_api_label = _muted_label("Batches API使用")
    batch_api_top.addWidget(batch_api_label)
    batch_api_checkbox = QCheckBox()
    # デフォルトは同期・即時レスポンスの通常呼び出し（不使用）。Batches APIは
    # 非同期でジョブ完了まで数分〜最大24時間待つことがあるため、通常運用では
    # オフが自然（大量データを安く処理したい場合にオンにする）。
    batch_api_checkbox.setChecked(False)
    batch_api_top.addWidget(batch_api_checkbox)
    batch_api_top.addStretch(1)
    batch_api_row.addWidget(
        _muted_label("（オンで50%割引の代わりに非同期・ジョブ完了待ちになる）", wrap=True)
    )
    option_getters["batch_api"] = batch_api_checkbox.isChecked

    layout.addWidget(_muted_label("（APIキー・使用モデルはヘッダーの⚙設定を使用）", wrap=True))

    return option_getters


def build_analyze_options(page: "MainPage", layout: QVBoxLayout) -> dict:
    # 2026-08-27、「上位クエリ件数」の選択UIを廃止し50件に固定（選択肢としての
    # 意味が分かりづらいとの指摘のため。_build_argsでargs.top_n=50を直接設定）。
    # モデル選択もヘッダーの⚙設定（AI_SETTINGS.analyze_model）に移動。
    ai_commentary_row = QVBoxLayout()
    layout.addLayout(ai_commentary_row)
    ai_top = QHBoxLayout()
    ai_commentary_row.addLayout(ai_top)
    ai_label = _muted_label("AIコメンタリー")
    ai_top.addWidget(ai_label)
    ai_checkbox = QCheckBox()
    ai_top.addWidget(ai_checkbox)
    ai_top.addStretch(1)
    ai_commentary_row.addWidget(
        _muted_label(
            "（本物のAnthropic APIでレポートに要約を追加。APIキー・使用モデルはヘッダーの⚙設定を使用）",
            wrap=True,
        )
    )

    return {
        "with_ai_commentary": ai_checkbox.isChecked,
    }


# (コマンドキー, 表示名, main.pyの関数, オプションビルダー((page, layout)を受け取る))
# 重複除去(dedup)は2026-08-27にAIによるクエリの分類の前段に自動実行する方式へ変更、
# プレビュー欄の専用ボタンは廃止した（_on_run参照）。
# add-query-count/count-columnはGUIから廃止（CLIでは利用可）。
TOOLS = [
    ("ai-classify", "🤖  AIによるクエリの分類", cli_main.cmd_ai_classify, build_ai_options),
    ("analyze", "📑  クエリの分析（傾向分析＋HTMLレポート）", cli_main.cmd_analyze, build_analyze_options),
]


class MainPage(QWidget):
    """アプリの画面全体（ファイルを開く〜出力結果のプレビュー）。
    2026-08-25、タブ2枚構成から単一画面に統合（モジュールdocstring参照）。"""

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.input_csv: str | None = None
        self.csv_header: list[str] = []
        self.option_getters: dict[str, object] = {}
        # ai-classifyの絞り込み列ドロップダウン（analyze選択時はNone）。
        # _load_previewが、CSV読み込み時にこれが立っていれば選択肢をヘッダーで更新する。
        self.filter_column_combo: QComboBox | None = None
        self.running = False
        self._before_run_files: set[str] = set()
        # 出力フォルダは実行直前にoutput_utils_lib.OUTPUT_DIRへ反映する
        # （_on_run/_on_estimate参照）。
        self.output_dir = OUTPUT_DIR

        self.preview_table: QTableWidget | None = None
        self.output_preview_table: QTableWidget | None = None

        self.signals = ThreadSignals()
        self.signals.log.connect(self._append_log)
        self.signals.done.connect(self._on_run_finished)

        self._build()

    def _build(self) -> None:
        outer_layout = QVBoxLayout(self)
        outer_layout.setContentsMargins(0, 0, 0, 0)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        # CSVプレビュー表を除き横スクロールは出さない方針。長い説明文はword-wrapで
        # 折り返す（各ビルダー関数のwrap=True参照）ので、ページ全体としては
        # 横スクロールバー自体を明示的に禁止しておく。
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        outer_layout.addWidget(scroll)

        content = QWidget()
        scroll.setWidget(content)
        layout = QVBoxLayout(content)
        layout.setContentsMargins(14, 14, 14, 14)

        # ファイルを開く
        file_row = QHBoxLayout()
        layout.addLayout(file_row)
        choose_csv_button = QPushButton("📂  ファイルを開く...")
        choose_csv_button.clicked.connect(self._choose_csv)
        file_row.addWidget(choose_csv_button)
        self.file_display = _muted_label("（未選択）", wrap=True)
        file_row.addWidget(self.file_display, stretch=1)

        _divider(layout)

        # プレビュー（入力CSV）。クエリのクレンジング（重複排除）は2026-08-27より
        # 専用ボタンを廃止し、「AIによるクエリの分類」実行時に自動で前段実行する
        # 方式に変更した（_on_run参照。ログにcmd_dedupの重複除去件数がそのまま出る）。
        preview_body = _section_card(layout, "プレビュー（列 + 先頭5行）")
        self.preview_placeholder = _muted_label("CSVを選択するとここに表示されます")
        preview_body.addWidget(self.preview_placeholder)
        self.preview_body = preview_body

        # 実行設定（出力先 → ツール選択 → オプション → 実行 → 進捗）
        run_body = _section_card(layout, "実行設定")

        output_row = QHBoxLayout()
        run_body.addLayout(output_row)
        output_row.addWidget(_muted_label("出力先:"))
        # フルパスは絶対パスで長くなりがちなため、読み取り専用のQLineEditにし
        # 行の残り幅いっぱいまで広げる。はみ出す場合もクリックしてカーソル移動・
        # 全選択コピーで全文を確認できる（QLineEditの標準機能）。
        self.output_dir_edit = QLineEdit(self.output_dir)
        self.output_dir_edit.setReadOnly(True)
        output_row.addWidget(self.output_dir_edit, stretch=1)
        choose_output_button = QPushButton("📂")
        choose_output_button.setFixedWidth(32)
        choose_output_button.clicked.connect(self._choose_output_dir)
        output_row.addWidget(choose_output_button)

        select_row = QHBoxLayout()
        run_body.addLayout(select_row)
        tool_label = QLabel("ツール:")
        tool_label.setFont(QFont(tool_label.font().family(), 13, QFont.Bold))
        select_row.addWidget(tool_label)
        self.tool_combo = QComboBox()
        self.tool_combo.addItems([label for _, label, _, _ in TOOLS])
        _bound_combo_width(self.tool_combo, min_chars=14)
        self.tool_combo.currentIndexChanged.connect(self._on_select)
        select_row.addWidget(self.tool_combo, stretch=1)

        self.options_layout = QVBoxLayout()
        run_body.addLayout(self.options_layout)

        # 実行ボタンと見積ボタンを横並びにすると、実機の（オフスクリーンでの計測より
        # 広くなりがちな）日本語フォント幅次第で2つ合わせた幅がウィンドウ幅を
        # 超えうる。フォント幅の実測に頼らず構造的に横スクロールを避けるため、
        # 常に縦積みにする（本数が2つだけなので縦積みでも見た目は崩れない）。
        run_col = QVBoxLayout()
        run_body.addLayout(run_col)

        run_row1 = QHBoxLayout()
        run_col.addLayout(run_row1)
        self.run_button = QPushButton("▶  実行")
        self.run_button.setObjectName("runButton")
        self.run_button.setFixedHeight(38)
        self.run_button.clicked.connect(self._on_run)
        run_row1.addWidget(self.run_button)
        run_row1.addStretch(1)

        run_row2 = QHBoxLayout()
        run_col.addLayout(run_row2)
        # ai-classifyの時だけ表示（_on_selectで出し分ける）。1バッチだけ実際に
        # 実行し、その結果を全体件数分単純に増加させた場合のコストを見積もってログに出す。
        self.estimate_button = QPushButton("📊  少量実行して見積")
        self.estimate_button.setFixedHeight(38)
        self.estimate_button.clicked.connect(self._on_estimate)
        run_row2.addWidget(self.estimate_button)
        run_row2.addStretch(1)

        self.progress = QProgressBar()
        self.progress.setFixedHeight(6)
        self.progress.setTextVisible(False)
        self._set_progress_running(False)
        run_body.addWidget(self.progress)

        # ログ
        log_body = _section_card(layout, "ログ")
        self.log_text = QPlainTextEdit()
        self.log_text.setReadOnly(True)
        self.log_text.setMinimumHeight(160)
        log_body.addWidget(self.log_text)

        # 出力結果のプレビュー（直前の実行で新規に作られたCSVが1件だけならそれを表示）
        output_preview_body = _section_card(layout, "出力結果のプレビュー")
        self.output_preview_placeholder = _muted_label("まだ何も実行していません")
        output_preview_body.addWidget(self.output_preview_placeholder)
        self.output_preview_body = output_preview_body

        layout.addStretch(1)

        self._on_select(0)

    # ---------- ファイル選択・プレビュー ----------

    def _choose_csv(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "入力CSVを選択", "", "CSV files (*.csv);;All files (*.*)"
        )
        if not path:
            return
        self.input_csv = path
        self.file_display.setText(path)
        self._load_preview(path)

    def _build_preview_table(self, path: str) -> tuple[QTableWidget | None, list[str] | None, str | None]:
        """CSVを読み込んでQTableWidgetを作る共通ロジック（入力プレビュー・出力結果
        プレビューの両方から使う）。(table, header, エラーメッセージ) を返す
        （成功時はエラーメッセージがNone）。"""
        try:
            with open(path, newline="", encoding="utf-8-sig") as f:
                reader = csv.reader(f)
                header = next(reader, None)
                sample_rows = list(itertools.islice(reader, 5))
        except Exception as e:  # noqa: BLE001 プレビューはあくまで補助表示なので落とさない
            return None, None, f"プレビュー読み込み失敗: {e}"

        if not header:
            return None, None, "CSVが空です"

        table = QTableWidget(len(sample_rows), len(header))
        table.setHorizontalHeaderLabels(header)
        table.verticalHeader().setVisible(False)
        table.horizontalHeader().setSectionResizeMode(QHeaderView.Interactive)
        for row_i, row in enumerate(sample_rows):
            for col_i, value in enumerate(row):
                table.setItem(row_i, col_i, QTableWidgetItem(value))
        table.setFixedHeight(180)
        return table, header, None

    def _show_preview_table(
        self, container_layout: QVBoxLayout, current_table_attr: str, placeholder: QLabel, path: str
    ) -> list[str] | None:
        """container_layoutの先頭にCSVプレビューテーブルを表示する。既存のテーブル
        （self.<current_table_attr>）があれば入れ替える。成功時はヘッダーを返す
        （失敗時はNoneを返し、placeholderにエラー文言を出す）。"""
        old_table = getattr(self, current_table_attr)
        if old_table is not None:
            container_layout.removeWidget(old_table)
            old_table.deleteLater()
            setattr(self, current_table_attr, None)

        table, header, err = self._build_preview_table(path)
        if err:
            placeholder.setText(err)
            placeholder.show()
            return None

        placeholder.hide()
        container_layout.insertWidget(0, table)
        setattr(self, current_table_attr, table)
        return header

    def _load_preview(self, path: str) -> None:
        header = self._show_preview_table(self.preview_body, "preview_table", self.preview_placeholder, path)
        if header is None:
            return

        self.csv_header = header
        # ai-classifyの絞り込み列ドロップダウンが表示中なら、新しく読み込んだCSVの
        # ヘッダーで選択肢を更新する（"(指定なし)"は常に先頭に残す）。
        if self.filter_column_combo is not None:
            self.filter_column_combo.clear()
            self.filter_column_combo.addItem(row_filter_lib.NO_FILTER_LABEL)
            self.filter_column_combo.addItems(header)

        self._confirm_query_column(header)

    def _load_output_preview(self, path: str) -> None:
        self._show_preview_table(self.output_preview_body, "output_preview_table", self.output_preview_placeholder, path)

    def _confirm_query_column(self, header: list[str]) -> None:
        """本ツールは列名「query」を前提に処理するため、読み込んだ列名の中から
        クエリ列らしきものを検出して情報表示するだけの確認ダイアログを出す
        （自動リネーム等の処理変更は行わない・パターンA）。"""
        matches = _detect_query_column_candidates(header)
        if matches:
            lines = "\n".join(f"・{c}" for c in matches)
            msg = (
                f"クエリ列の候補として以下の列名を検出しました:\n\n{lines}\n\n"
                "本ツールは列名「query」を前提に処理します。上記が実際のクエリ列と\n"
                "異なる場合や、そもそも「query」列が無い場合は、列名を確認してください。"
            )
        else:
            msg = (
                "クエリ列らしき列名が見つかりませんでした。\n"
                "本ツールは列名「query」の列を前提に処理するため、このままでは\n"
                "処理が失敗する可能性があります。列名をご確認ください。\n\n"
                "読み込んだ列: " + ", ".join(header)
            )
        QMessageBox.information(self, f"{APP_TITLE} - クエリ列の確認", msg)

    # ---------- ツール選択 ----------

    def _on_select(self, index: int) -> None:
        _clear_layout(self.options_layout)
        self.filter_column_combo = None  # builder内でai-classifyなら再セットされる
        key, label, func, builder = TOOLS[index]
        self.current_key = key
        self.current_func = func
        self.option_getters = builder(self, self.options_layout) or {}

        # 「少量実行して見積」はai-classifyだけ意味があるため出し分ける
        self.estimate_button.setVisible(key == "ai-classify")

    # ---------- 実行 ----------

    def _on_run(self) -> None:
        if self.running:
            return
        if not self.input_csv:
            QMessageBox.warning(self, APP_TITLE, "入力CSVを選択してください。")
            return

        key = self.current_key
        if key == "ai-classify":
            # Batches APIの有無によらず、本物のAnthropic APIキーが常に必須
            # （2026-08-27、プロキシ経由の呼び出しを廃止したため）。
            token = AI_SETTINGS.api_key.strip()
            if not token and not os.environ.get("ANTHROPIC_API_KEY"):
                QMessageBox.warning(
                    self, APP_TITLE, "ヘッダーの⚙設定でANTHROPIC_API_KEYを入力してください。"
                )
                return
        elif key == "analyze":
            with_ai_commentary = self.option_getters["with_ai_commentary"]()
            token = AI_SETTINGS.api_key.strip()
            if with_ai_commentary and not token and not os.environ.get("ANTHROPIC_API_KEY"):
                QMessageBox.warning(
                    self, APP_TITLE, "AIコメンタリー使用時はヘッダーの⚙設定でANTHROPIC_API_KEYを入力してください。"
                )
                return

        args = self._build_args(key, self.option_getters)

        # main.pyのcmd_*関数はlib/output_utils.make_output_path()経由で出力先を決めており、
        # make_output_path()は呼び出し時点でoutput_utils_lib.OUTPUT_DIRを参照する。
        # ここで選択フォルダに一度だけ差し替えてから実行することで、main.py側のロジックを
        # 一切変更せずに出力先を切り替えられる。
        output_utils_lib.OUTPUT_DIR = self.output_dir

        self._before_run_files = self._snapshot_output_dir()
        self._set_running(True)

        thread = threading.Thread(target=self._run_in_thread, args=(key, self.current_func, args), daemon=True)
        thread.start()

    def _build_args(self, key: str, option_getters: dict) -> _Args:
        args = _Args()
        args.input_csv = self.input_csv

        if key == "ai-classify":
            args.model = AI_SETTINGS.ai_classify_model
            args.filter_column = option_getters["filter_column"]()
            args.filter_op = option_getters["filter_op"]()
            args.filter_value = option_getters["filter_value"]()
            args.batch_size = option_getters["batch_size"]()
            args.workers = option_getters["workers"]()
            args.batch_api = option_getters["batch_api"]()
            # 「最大バッチ数」は「少量実行して見積」ボタンで代替できるため
            # GUIからは常にNone（全件対象）。
            args.max_batches = None
            # GUIに再開用のUIは無いため常にNone（--resume-batch-jobはCLI専用の機能。
            # cmd_ai_classifyがargs.resume_batch_jobに無条件でアクセスするので、
            # 属性自体は必ずセットしておく必要がある）。
            args.resume_batch_job = None
            token = AI_SETTINGS.api_key.strip()
            args.token = token or None

        elif key == "analyze":
            # 2026-08-27、「上位クエリ件数」の選択UIを廃止し50件に固定。
            args.top_n = 50
            args.with_ai_commentary = option_getters["with_ai_commentary"]()
            args.model = AI_SETTINGS.analyze_model
            token = AI_SETTINGS.api_key.strip()
            args.token = token or None

        return args

    # ---------- 少量実行して見積 ----------

    def _on_estimate(self) -> None:
        if self.running:
            return
        if not self.input_csv:
            QMessageBox.warning(self, APP_TITLE, "入力CSVを選択してください。")
            return
        key = self.current_key
        if key != "ai-classify":
            return

        option_getters = self.option_getters
        model_key = AI_SETTINGS.ai_classify_model
        batch_size = option_getters["batch_size"]()
        workers = option_getters["workers"]()
        batch_api = option_getters["batch_api"]()
        filter_column = option_getters["filter_column"]()
        filter_op = option_getters["filter_op"]()
        filter_value = option_getters["filter_value"]()
        token = AI_SETTINGS.api_key.strip()

        if not token and not os.environ.get("ANTHROPIC_API_KEY"):
            QMessageBox.warning(
                self, APP_TITLE, "ヘッダーの⚙設定でANTHROPIC_API_KEYを入力してください。"
            )
            return

        self._set_running(True)
        thread = threading.Thread(
            target=self._run_estimate_in_thread,
            args=(
                self.input_csv, model_key, batch_size, workers, batch_api,
                filter_column, filter_op, filter_value, token,
            ),
            daemon=True,
        )
        thread.start()

    def _run_estimate_in_thread(
        self, input_csv: str, model_key: str, batch_size: int, workers: int, batch_api: bool,
        filter_column: str | None, filter_op: str | None, filter_value: str | None, token: str | None,
    ) -> None:
        """実際に1バッチだけ分類APIを呼び、そのin/outトークン数を全体のバッチ数分
        単純に増加させてコストを見積もる。1バッチは実データで実際に実行するため、
        本物のAPI呼び出しが発生する（＝わずかに課金される）。"""
        old_stdout, old_stderr = sys.stdout, sys.stderr
        writer = QueueWriter(self.signals)
        sys.stdout = writer
        sys.stderr = writer
        error = None
        try:
            unique_queries = _load_unique_queries_for_estimate(input_csv, filter_column, filter_op, filter_value)
            total_unique = len(unique_queries)
            if total_unique == 0:
                print("見積り対象のqueryが0件でした（絞り込み条件を確認してください）。")
            else:
                sample = unique_queries[:batch_size]
                print(
                    f"見積り: 対象ユニークquery数 {total_unique}件のうち先頭 {len(sample)}件を"
                    "1バッチとして実際に実行します..."
                )
                level12_model, level3_model = classification_common_lib.MODEL_PRESETS[model_key]

                t0 = time.time()
                if batch_api:
                    from lib import ai_classify_batch as ai_classify_batch_lib

                    _, sample_in, sample_out, _failed_ranges, _failed_queries = ai_classify_batch_lib.classify_unique(
                        sample, len(sample), level12_model, level3_model, api_key=token,
                    )
                else:
                    from lib import ai_classify as ai_classify_lib

                    mapping, sample_in, sample_out, _failed_queries = ai_classify_lib.classify_unique(
                        sample, len(sample), workers, level12_model, level3_model, api_key=token,
                    )
                elapsed = time.time() - t0
                total_batches = max(1, math.ceil(total_unique / batch_size))
                est_in = sample_in * total_batches
                est_out = sample_out * total_batches
                # classify_unique()はフェーズ1(level12_model)・フェーズ2(level3_model)
                # 合算のトークン数しか返さないため、2モデルが異なる場合（haiku+sonnet）は
                # 単価を正確に按分できない。その場合は2モデルの単価の単純平均で近似し、
                # その旨を明記する（level12_model==level3_modelなら通常通り正確）。
                if level12_model == level3_model:
                    price_in, price_out = PRICING_PER_MTOK.get(level12_model, (0.0, 0.0))
                    cost_note = ""
                else:
                    p12 = PRICING_PER_MTOK.get(level12_model, (0.0, 0.0))
                    p3 = PRICING_PER_MTOK.get(level3_model, (0.0, 0.0))
                    price_in, price_out = (p12[0] + p3[0]) / 2, (p12[1] + p3[1]) / 2
                    cost_note = f"（{level12_model}と{level3_model}の単価の単純平均で近似した概算値です）"
                discount = BATCH_API_DISCOUNT if batch_api else 1.0
                est_cost = (est_in / 1_000_000 * price_in + est_out / 1_000_000 * price_out) * discount

                print("")
                print("=== 見積り結果 ===")
                print(f"モデル: {classification_common_lib.model_preset_label(model_key)}")
                print(f"Batches API使用: {'あり（50%割引適用）' if batch_api else 'なし（同期・即時）'}")
                print(f"バッチサイズ: {batch_size} / 対象ユニークquery数: {total_unique} / 想定バッチ数: {total_batches}")
                print(f"サンプル1バッチの所要時間: {elapsed:.1f}秒")
                print(f"サンプル1バッチ input/outputトークン: {sample_in} / {sample_out}")
                print(f"全体推定 input/outputトークン: {est_in} / {est_out}")
                print(
                    f"全体推定コスト: ${est_cost:.2f}{cost_note}"
                    "（1バッチの結果を単純に比例させた見積りです。実際のコストと異なる場合があります）"
                )
        except Exception as e:  # noqa: BLE001 GUIなので落とさず表示する
            error = e
        finally:
            sys.stdout, sys.stderr = old_stdout, old_stderr
        self.signals.done.emit(error)

    def _run_in_thread(self, key: str, func, args) -> None:
        old_stdout, old_stderr = sys.stdout, sys.stderr
        writer = QueueWriter(self.signals)
        sys.stdout = writer
        sys.stderr = writer
        error = None
        try:
            if key == "ai-classify":
                # 2026-08-27、AIによるクエリの分類の前段として、クエリの
                # クレンジング（重複排除）を自動実行する（旧・プレビュー欄の
                # 専用ボタンを廃止した代わり）。cmd_dedupの出力（入力行数/
                # 除去件数/出力先）がそのままログに流れるので、何が起きたかは
                # ログを見れば分かる。dedup後のCSVをai-classifyの実際の入力にする
                # （output_utils.pyが元々想定していた「dedupの出力をclassifyに
                # 渡す」パイプラインを自動化したもの）。
                print("=== クエリのクレンジング（重複排除）を自動実行します ===")
                dedup_args = _Args()
                dedup_args.input_csv = args.input_csv
                dedup_args.columns_only = False
                args.input_csv = cli_main.cmd_dedup(dedup_args)
                print("=== AIによるクエリの分類を実行します ===")
            func(args)
        except Exception as e:  # noqa: BLE001 GUIなので落とさず表示する
            error = e
        finally:
            sys.stdout, sys.stderr = old_stdout, old_stderr
        self.signals.done.emit(error)

    def _append_log(self, text: str) -> None:
        cursor = self.log_text.textCursor()
        cursor.movePosition(QTextCursor.MoveOperation.End)
        self.log_text.setTextCursor(cursor)
        self.log_text.insertPlainText(text)
        self.log_text.ensureCursorVisible()

    def _on_run_finished(self, error: Exception | None) -> None:
        self._set_running(False)
        if error is not None:
            self._append_log(f"\nエラー: {error}\n")
            QMessageBox.critical(self, APP_TITLE, f"実行中にエラーが発生しました:\n{error}")
            return
        self._refresh_output_preview(self._before_run_files)

    def _set_running(self, running: bool) -> None:
        self.running = running
        self.run_button.setEnabled(not running)
        self.estimate_button.setEnabled(not running)
        self._set_progress_running(running)

    def _set_progress_running(self, running: bool) -> None:
        # Qtの不定進捗（busy）表現: min=max=0にすると内部的にアニメーションする。
        if running:
            self.progress.setRange(0, 0)
        else:
            self.progress.setRange(0, 1)
            self.progress.setValue(0)

    # ---------- 出力操作 ----------

    def _choose_output_dir(self) -> None:
        os.makedirs(self.output_dir, exist_ok=True)
        chosen = QFileDialog.getExistingDirectory(self, "出力フォルダ", self.output_dir)
        if chosen:
            self.output_dir = chosen
            self.output_dir_edit.setText(chosen)

    def _snapshot_output_dir(self) -> set[str]:
        if not os.path.isdir(self.output_dir):
            return set()
        return set(os.listdir(self.output_dir))

    def _refresh_output_preview(self, before_files: set[str]) -> None:
        """直前の実行（dedup/ai-classify/analyze）で出力フォルダに新規作成された
        ファイルのうち、CSVが1件だけならそれをプレビューする。analyzeのように
        複数のCSV+HTMLレポートを一度に出力するツールでは、どれを見せるべきか
        一意に決められないため、その旨を表示するだけにする（何もプレビューしない）。"""
        new_csvs = sorted(f for f in (self._snapshot_output_dir() - before_files) if f.endswith(".csv"))
        if len(new_csvs) == 1:
            self._load_output_preview(os.path.join(self.output_dir, new_csvs[0]))
        elif len(new_csvs) > 1:
            if self.output_preview_table is not None:
                self.output_preview_body.removeWidget(self.output_preview_table)
                self.output_preview_table.deleteLater()
                self.output_preview_table = None
            self.output_preview_placeholder.setText(
                "複数のCSVが出力されたため、ここではプレビューしません（出力先フォルダをご確認ください）。"
            )
            self.output_preview_placeholder.show()
        # 新規CSVが0件（見積りのみ実行した等）の場合は、直前のプレビューをそのまま残す。


def _analyze_model_display_label(model_key: str) -> str:
    """analyzeのAIコメンタリー用モデル選択コンボボックスの表示テキスト
    （_model_preset_display_labelのMODEL_CHOICES単体版）。"""
    return f"{model_key} ({classification_common_lib.MODEL_CHOICES[model_key]})"


class SettingsDialog(QDialog):
    """ヘッダー右端の⚙ボタンから開く、AI関連設定の一元ダイアログ。APIキーに加え、
    ai-classify/analyzeそれぞれのモデル選択もここに集約する（2026-08-27、各ツールの
    実行設定欄から移動）。ここで編集する内容はAI_SETTINGSそのものなので、閉じても
    即座に各ツールの実行に反映される（実行時にここを読むだけで、各ツールの
    オプション欄には表示しない）。"""

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.setWindowTitle("AI設定")
        self.setFixedSize(420, 300)

        layout = QVBoxLayout(self)
        card = QFrame()
        card.setObjectName("card")
        card_layout = QVBoxLayout(card)
        card_layout.setContentsMargins(16, 16, 16, 16)
        layout.addWidget(card)

        info = _muted_label(
            "AIのAPIキー・使用モデルをここで一括管理します。\n"
            "ai-classify / analyze のBatches API・AIコメンタリー使用時は、この設定を使用します。",
            wrap=True,
        )
        card_layout.addWidget(info)

        key_row = QHBoxLayout()
        card_layout.addLayout(key_row)
        key_label = _muted_label("ANTHROPIC_API_KEY")
        key_row.addWidget(key_label)
        self.key_entry = QLineEdit(AI_SETTINGS.api_key)
        self.key_entry.setEchoMode(QLineEdit.Password)
        # 入力欄が空のときに、期待する形式をグレーのプレースホルダーで示す
        # （実際のキー本体は表示しない。Qtのplaceholder文字はPasswordモードでも
        # マスクされず通常表示される）。
        self.key_entry.setPlaceholderText("sk-ant-...")
        key_row.addWidget(self.key_entry, stretch=1)

        ai_classify_row = QHBoxLayout()
        card_layout.addLayout(ai_classify_row)
        ai_classify_row.addWidget(_muted_label("AI分類のモデル"))
        self.ai_classify_model_combo = QComboBox()
        for preset in classification_common_lib.MODEL_PRESETS:
            self.ai_classify_model_combo.addItem(_model_preset_display_label(preset), preset)
        self.ai_classify_model_combo.setCurrentIndex(
            self.ai_classify_model_combo.findData(AI_SETTINGS.ai_classify_model)
        )
        _bound_combo_width(self.ai_classify_model_combo, min_chars=14)
        ai_classify_row.addWidget(self.ai_classify_model_combo, stretch=1)

        analyze_row = QHBoxLayout()
        card_layout.addLayout(analyze_row)
        analyze_row.addWidget(_muted_label("レポートのAIコメンタリーのモデル"))
        self.analyze_model_combo = QComboBox()
        for model_key in classification_common_lib.MODEL_CHOICES:
            self.analyze_model_combo.addItem(_analyze_model_display_label(model_key), model_key)
        self.analyze_model_combo.setCurrentIndex(
            self.analyze_model_combo.findData(AI_SETTINGS.analyze_model)
        )
        _bound_combo_width(self.analyze_model_combo, min_chars=14)
        analyze_row.addWidget(self.analyze_model_combo, stretch=1)

        card_layout.addStretch(1)
        button_row = QHBoxLayout()
        button_row.addStretch(1)
        save_button = QPushButton("保存して閉じる")
        save_button.clicked.connect(self._save_and_close)
        button_row.addWidget(save_button)
        card_layout.addLayout(button_row)

        self.key_entry.setFocus()

    def _save_and_close(self) -> None:
        AI_SETTINGS.api_key = self.key_entry.text()
        AI_SETTINGS.ai_classify_model = self.ai_classify_model_combo.currentData()
        AI_SETTINGS.analyze_model = self.analyze_model_combo.currentData()
        QMessageBox.information(self, "AI設定", "保存しました。")
        self.accept()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(APP_TITLE)
        # 元は860x800だったが、横スクロールを廃止した上で画面幅をおよそ70%に縮小
        # （長い説明文はword-wrapで折り返す設計にしたため、幅を詰めても内容は欠けない）。
        self.resize(600, 820)
        self.setMinimumSize(520, 600)

        central = QWidget()
        self.setCentralWidget(central)
        root_layout = QVBoxLayout(central)
        root_layout.setContentsMargins(12, 10, 12, 12)

        # ヘッダー（タイトル + 右端に⚙設定ボタン）
        header = QHBoxLayout()
        root_layout.addLayout(header)
        title_label = QLabel(APP_TITLE)
        title_label.setFont(QFont(title_label.font().family(), 16, QFont.Bold))
        header.addWidget(title_label)
        header.addStretch(1)
        settings_button = QPushButton("⚙  設定")
        settings_button.setFixedWidth(90)
        settings_button.clicked.connect(self._open_settings_dialog)
        header.addWidget(settings_button)

        root_layout.addWidget(MainPage())

    def _open_settings_dialog(self) -> None:
        SettingsDialog(self).exec()


def main() -> None:
    app = QApplication(sys.argv)
    app.setStyleSheet(STYLESHEET)

    window = MainWindow()
    window.show()

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
