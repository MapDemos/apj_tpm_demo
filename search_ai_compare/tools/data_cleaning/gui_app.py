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
  APIキーの入力もヘッダーの⚙設定（SettingsDialog）に集約した（2026-08-27にモデルは
  ai-classify=Haiku固定・analyze=Sonnet固定にしたため、モデル選択UI自体は廃止）。
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
import re
import sys
import threading
import time

from PySide6.QtCore import Qt, QObject, Signal
from PySide6.QtGui import QFont, QTextCursor
from PySide6.QtWidgets import (
    QApplication,
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
    QStyle,
    QSystemTrayIcon,
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
# 各ツールのAPIキー入力欄をヘッダーの⚙設定ダイアログに集約し、全てのAI処理が
# ここから読む。モデルはai-classify=Haiku固定・analyze=Sonnet固定（2026-08-27、
# 選択制だったモデル設定を廃止しclassification_common.CLASSIFY_MODEL/ANALYZE_MODEL
# に一本化）。2026-08-29、バッチサイズ・並行数もここに集約した（各ツールの実行設定欄に
# あると「AIコメンタリー」等のオン/オフと並んで目立ちすぎる・毎回意識する必要が
# 無い設定なので、APIキーと同じ「裏方の設定」として⚙設定ダイアログに寄せた）。
# 非persistent（ディスクに保存しない）。
# 2026-08-28、30→90に変更（main.pyの--batch-sizeデフォルト変更と合わせた。
# project memory参照）。2026-08-29、90→300にさらに変更（同じくmain.pyと合わせた。
# max_tokensも4096→15800に拡大済み）。2026-08-30、Batches API使用時/不使用時で
# バッチサイズの設定を分離した（main.pyの--batch-size/--sync-batch-size分離と
# 同じ理由。project memory参照: 非同期ジョブ登録は非ストリーミングSDKのmax_tokens
# 超過ガード対象外のためbatch_sizeを大きく取れるが、不使用時は全呼び出しが同期の
# ためガード対象で300前後が実質上限）。同日、実データ550件・1チャンクでの検証
# （欠落率0.7%、既存水準と同程度）を踏まえてBatches API使用時のデフォルトを
# 300→1000にさらに引き上げ（main.pyの--batch-sizeデフォルト変更と合わせた）。
DEFAULT_BATCH_SIZE = 1000
DEFAULT_SYNC_BATCH_SIZE = 300
DEFAULT_WORKERS = 8


class AISettings:
    def __init__(self) -> None:
        self.api_key: str = ""
        self.batch_size: int = DEFAULT_BATCH_SIZE
        self.sync_batch_size: int = DEFAULT_SYNC_BATCH_SIZE
        self.workers: int = DEFAULT_WORKERS
        # 2026-08-30、実行設定欄（build_ai_options）にあった「Batches API使用」
        # トグルをここに移動した（project memory参照。batch_size等と同じく毎回
        # 意識する設定ではなく「裏方の設定」寄りのため、コスト影響が大きい割に
        # 実行設定欄で毎回触るような場所には置かない判断）。
        self.batch_api: bool = True


AI_SETTINGS = AISettings()


# ---------- AI呼び出しコストの見積り ----------
# 2026-08-30、実サンプルAPI呼び出しによる見積り（少量実行して見積）を廃止し、
# ユニークquery数とbatch_size・batch_api有無から実績ベースの分析式で計算する
# 方式に変更した（project memory参照）。「少量実行して見積」は無料ではなく
# （実際に1バッチAPIを叩くため課金が発生する）、かつ毎回リアルタイムで待つ
# 必要があったが、新方式は無料・即時。

# USD/1Mトークンのリスト価格。ファミリー（haiku/sonnet）単位で持つ（2026-08-30、
# モデルIDが自動解決でバージョンごとに変わるようになったため、固定モデルID文字列
# キーの辞書だと引けなくなる問題への対策。Sonnet 5には2026-08-31までの導入価格
# ($2/$10)があるが、導入期間が終わっても見積りロジックを直さなくて済むよう、
# 恒久的なリスト価格を採用する）。
PRICING_PER_MTOK_BY_FAMILY: dict[str, tuple[float, float]] = {
    "haiku": (1.00, 5.00),
    "sonnet": (3.00, 15.00),
}
BATCH_API_DISCOUNT = 0.5  # Message Batches API使用時は通常価格の50%
USD_TO_JPY = 150.0  # 見積り表示用の概算為替レート（固定値、変動しても厳密追従はしない）

# 分析式トークン見積りの実績ベース係数（2026-08-30新設、project memory参照）。
# 2回の実行実績（24,137件・batch_size300／550件・batch_size600相当）から逆算した
# 概算値。サンプル数が少ないため今後の実行実績で調整の余地あり。
#   - _CONTENT_IN_PER_QUERY / _CONTENT_OUT_PER_QUERY: batch_sizeに依存しない
#     「クエリ本文＋分類結果」部分のトークン数（ユニーク1件あたり平均）。
#   - _SYSTEM_PROMPT_TOKENS_*: 各フェーズのsystem prompt実測トークン数
#     （lib/classification_common.pyのSYSTEM_PROMPT_LEVEL12/LEVEL3参照。
#     いずれもHaiku 4.5のキャッシュ最低サイズ4096トークン未満でキャッシュ非対象）。
#   - _POI_RATE: レベル3（taxonomy判定）まで進む行の比率。550件実行実績で255件
#     （46.4%）。カテゴリ再判定フェーズ（少数のみ対象）は計算に含めず、その分
#     わずかに過小評価になる。
#
# _CONTENT_OUT_PER_QUERY: 2026-08-29、level3（taxonomyリーフ判定）の出力形式を
# カテゴリ文字列からカテゴリ番号に変更し、level3のoutputトークンが実測で約58%
# 減った（project memory参照）。11.7は「level3が旧・文字列出力だった頃」の実績
# ベース値なので、この変更分を反映して逆算し直した: 旧値からlevel3寄与分
# （_POI_RATE×旧level3実測12.05トークン/件）を除いた「level12のみの寄与分」
# （約6.11トークン/件）に、新level3実測5.06トークン/件×_POI_RATEを足し直した。
_CONTENT_IN_PER_QUERY = 30.0
_CONTENT_OUT_PER_QUERY = 8.5
_SYSTEM_PROMPT_TOKENS_LEVEL12 = 3731
# 2026-08-29、level3の出力形式変更（カテゴリ文字列→番号、taxonomyを「番号: 名前」の
# 行で明示列挙する形に変更）でsystem prompt自体もわずかに増えた（2588→2795、
# count_tokens APIで実測。project memory参照）。
_SYSTEM_PROMPT_TOKENS_LEVEL3 = 2795
_POI_RATE = 0.464


def estimate_tokens(unique_count: int, batch_size: int) -> tuple[int, int]:
    """ユニークquery数とbatch_sizeから、input/outputトークン数を分析式で見積もる
    （実API呼び出し無し。project memory参照）。batch_apiの有無自体は直接の
    パラメータではなく、呼び出し元がbatch_size（Batches API用/--sync-batch-size用）
    を使い分けることで反映する（フォーミュラ自体は両モードで共通——system prompt・
    フェーズ構成は同じで、chunk化の単位が違うだけのため）。"""
    if unique_count <= 0 or batch_size <= 0:
        return 0, 0
    chunks_level12 = math.ceil(unique_count / batch_size)
    poi_count = unique_count * _POI_RATE
    chunks_level3 = math.ceil(poi_count / batch_size) if poi_count > 0 else 0
    system_overhead = (
        chunks_level12 * _SYSTEM_PROMPT_TOKENS_LEVEL12 + chunks_level3 * _SYSTEM_PROMPT_TOKENS_LEVEL3
    )
    input_tokens = round(unique_count * _CONTENT_IN_PER_QUERY + system_overhead)
    output_tokens = round(unique_count * _CONTENT_OUT_PER_QUERY)
    return input_tokens, output_tokens


def estimate_cost(input_tokens: int, output_tokens: int, model_family: str, batch_api: bool) -> float:
    """見積りトークン数からUSDコストを計算する。"""
    price_in, price_out = PRICING_PER_MTOK_BY_FAMILY.get(model_family, (0.0, 0.0))
    discount = BATCH_API_DISCOUNT if batch_api else 1.0
    return (input_tokens / 1_000_000 * price_in + output_tokens / 1_000_000 * price_out) * discount


# 進捗バーの%表示（_update_progress_from_log参照）が拾う進捗ログの形式。
# 2026-08-30、残り時間の目安を廃止しこちらに置き換えた（project memory参照）。
# 3パターンをまとめて解析する:
#   ①Batches API使用時のジョブポーリング行（ai_classify_batch.pyのrun_batch_job。
#     phase_label付きでdone=N/Mを出すよう変更済み）
#   ②Batches API不使用時のバッチ完了行（ai_classify.pyの_run_batches_concurrently）
#   ③個別/グループリトライの進捗行（ai_classify_batch.py/ai_classify.py共通）
_PROGRESS_JOB_RE = re.compile(r"\[(.+?)\].*done=(\d+)/(\d+)")
_PROGRESS_SYNC_RE = re.compile(r"(.+?)中\.\.\. (\d+)/(\d+) バッチ完了")
_PROGRESS_RETRY_RE = re.compile(r"(.+?): グループリトライ (\d+)/(\d+)グループ完了")


def _load_unique_queries_for_estimate(
    input_csv: str, filter_column: str | None, filter_op: str | None, filter_value: str | None
) -> list[str]:
    """query列のユニーク値だけを抽出する（見積り計算・実行前の重複排除カウント
    共通で使う）。filter_column指定時はai-classify本体の絞り込みと同じロジック
    （row_filter_lib）で対象行を絞り込んだ上で抽出する。"""
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

    # 2026-08-27、モデルはHaiku固定（CLASSIFY_MODEL）になったため選択UI自体が
    # 不要になり廃止した。「最大バッチ数」は「少量実行して見積」ボタンで
    # 十分カバーできるためGUIからは廃止（CLIでは引き続き利用可）。
    # 2026-08-29、バッチサイズ・並行数はヘッダーの⚙設定ダイアログ（AI_SETTINGS）に
    # 移動した（毎回触る設定ではなく、APIキーと同じ「裏方の設定」寄りのため）。
    # ここではAI_SETTINGSを読むだけのgetterにする。2026-08-30、Batches API使用時/
    # 不使用時でバッチサイズの設定を分離した（main.pyの--batch-size/
    # --sync-batch-size分離と同じ理由。project memory参照）ため、option_getters
    # ["batch_api"]（下で定義、辞書経由の遅延参照なのでこの時点で未定義でも良い）の
    # 値でどちらを読むか切り替える。
    option_getters["batch_size"] = lambda: (
        AI_SETTINGS.batch_size if option_getters["batch_api"]() else AI_SETTINGS.sync_batch_size
    )
    option_getters["workers"] = lambda: AI_SETTINGS.workers

    # レポート出力: 分類完了後、続けてanalyzeサブコマンド相当のHTMLレポート
    # （AIコメンタリー無し・上位クエリ50件固定）も自動生成するかどうか
    # （2026-08-29新設。従来は分類→レポートの2ステップを別々にツールを
    # 切り替えて実行する必要があった）。他のオン/オフ設定と同じ「使う/使わない」
    # ではなく「はい/いいえ」にしているのは、Batches API使用・AIコメンタリーが
    # 「機能をオン/オフする」設定なのに対し、これは「レポートを出すか出さないか」
    # という結果に対するYes/No選択のため、文言を分けた方が意味が伝わりやすいと
    # 判断したため。
    report_row = QVBoxLayout()
    layout.addLayout(report_row)
    report_top = QHBoxLayout()
    report_row.addLayout(report_top)
    report_label = _muted_label("レポート出力")
    report_top.addWidget(report_label)
    report_combo = QComboBox()
    report_combo.addItems(["はい", "いいえ"])
    report_combo.setCurrentText("いいえ")
    _bound_combo_width(report_combo, min_chars=6)
    report_top.addWidget(report_combo)
    report_top.addStretch(1)
    report_row.addWidget(
        _muted_label("（分類完了後に続けてHTMLレポートも生成する。AIコメンタリー無し・上位50件固定）", wrap=True)
    )
    option_getters["with_report"] = lambda: report_combo.currentText() == "はい"

    # 2026-08-30、「Batches API使用」トグルをヘッダーの⚙設定ダイアログ
    # （AI_SETTINGS.batch_api）に移動した（project memory参照。コストへの影響が
    # 大きい割に毎回意識する設定ではなく、batch_size等と同じ「裏方の設定」寄りの
    # ため）。ここではAI_SETTINGSを読むだけのgetterにする。
    option_getters["batch_api"] = lambda: AI_SETTINGS.batch_api

    layout.addWidget(
        _muted_label(
            "（モデル: Haikuファミリー固定（バージョン自動選択）。APIキー・Batches API使用・"
            "バッチサイズ・並行数はヘッダーの⚙設定を使用）",
            wrap=True,
        )
    )

    return option_getters


def build_analyze_options(page: "MainPage", layout: QVBoxLayout) -> dict:
    # 2026-08-27、「上位クエリ件数」の選択UIを廃止し50件に固定（選択肢としての
    # 意味が分かりづらいとの指摘のため。_build_argsでargs.top_n=50を直接設定）。
    # 2026-08-29、チェックボックスから「使う/使わない」のドロップダウンに変更
    # （project memory参照。オン/オフが視覚的に紛らわしいとの指摘のため）。
    ai_commentary_row = QVBoxLayout()
    layout.addLayout(ai_commentary_row)
    ai_top = QHBoxLayout()
    ai_commentary_row.addLayout(ai_top)
    ai_label = _muted_label("AIコメンタリー")
    ai_top.addWidget(ai_label)
    ai_combo = QComboBox()
    ai_combo.addItems(["使う", "使わない"])
    ai_combo.setCurrentText("使わない")  # 従来のQCheckBox()のデフォルト（未チェック）を踏襲
    _bound_combo_width(ai_combo, min_chars=6)
    ai_top.addWidget(ai_combo)
    ai_top.addStretch(1)
    ai_commentary_row.addWidget(
        _muted_label(
            "（本物のAnthropic APIでレポートに要約を追加。モデル: Sonnet固定。APIキーはヘッダーの⚙設定を使用）",
            wrap=True,
        )
    )

    return {
        "with_ai_commentary": lambda: ai_combo.currentText() == "使う",
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
        self._cancel_event: threading.Event | None = None
        self._before_run_files: set[str] = set()
        # 出力フォルダは実行直前にoutput_utils_lib.OUTPUT_DIRへ反映する（_on_run参照）。
        self.output_dir = OUTPUT_DIR
        # 完了通知用のQSystemTrayIcon（_notify_completion参照）。遅延生成する。
        self._tray_icon: QSystemTrayIcon | None = None

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

        # 2026-08-30、「少量実行して見積」ボタンは廃止した（project memory参照）。
        # 見積りは実行ボタン押下時に自動計算しモーダルダイアログで表示する方式に
        # 変更したため、専用ボタンは不要になった（_on_run/_show_estimate_dialog参照）。
        # 「実行」の下にキャンセルボタンを置く（2026-08-29新設）。実行中(self.running)
        # にのみ有効化する。ai-classifyの実処理は複数のフェーズ（レベル1/2分類→
        # レベル3分類→カテゴリ再判定、Batches API使用時はさらにジョブ完了までの
        # ポーリング）に分かれており、cancel_eventをフェーズの境目・ポーリング
        # ループで確認して中断する（classification_common.OperationCancelled参照）。
        # 既に投げてしまった1回分のAPI呼び出し自体は打ち切れないため、押してから
        # 実際に停止するまである程度のタイムラグが起こりうる。
        run_row3 = QHBoxLayout()
        run_col.addLayout(run_row3)
        self.cancel_button = QPushButton("✕  キャンセル")
        self.cancel_button.setFixedHeight(38)
        self.cancel_button.setEnabled(False)
        self.cancel_button.clicked.connect(self._on_cancel)
        run_row3.addWidget(self.cancel_button)
        run_row3.addStretch(1)

        self.progress = QProgressBar()
        self.progress.setFixedHeight(6)
        self.progress.setTextVisible(False)
        self._set_progress_running(False)
        run_body.addWidget(self.progress)

        # 進捗バーの下にフェーズ名と進捗率(%)を表示する（2026-08-30、残り時間の
        # 目安を廃止し置き換え）。ログに流れる「レベル1/2分類」等のフェーズ名＋
        # 「done=N/M」（Batches API使用時）または「N/Mバッチ完了」（不使用時）を
        # リアルタイムに解析して算出する（_update_progress_from_log参照）。
        # フェーズが切り替わったらリセットする。個別/グループリトライで母数が
        # 変わった場合はその時点の母数で%を出し直すため、進捗が後退することもある。
        self.progress_label = _muted_label("")
        run_body.addWidget(self.progress_label)
        self._progress_phase: str | None = None

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

        self._reset_progress()

    # ---------- 実行 ----------

    def _on_run(self) -> None:
        if self.running:
            return
        if not self.input_csv:
            QMessageBox.warning(self, APP_TITLE, "入力CSVを選択してください。")
            return

        key = self.current_key
        token = AI_SETTINGS.api_key.strip()
        if key == "ai-classify":
            # Batches APIの有無によらず、本物のAnthropic APIキーが常に必須
            # （2026-08-27、プロキシ経由の呼び出しを廃止したため）。
            if not token and not os.environ.get("ANTHROPIC_API_KEY"):
                QMessageBox.warning(
                    self, APP_TITLE, "ヘッダーの⚙設定でANTHROPIC_API_KEYを入力してください。"
                )
                return
        elif key == "analyze":
            with_ai_commentary = self.option_getters["with_ai_commentary"]()
            if with_ai_commentary and not token and not os.environ.get("ANTHROPIC_API_KEY"):
                QMessageBox.warning(
                    self, APP_TITLE, "AIコメンタリー使用時はヘッダーの⚙設定でANTHROPIC_API_KEYを入力してください。"
                )
                return

        deduped_input_csv = self.input_csv
        if key == "ai-classify":
            # 2026-08-30、実行ボタン押下時に前段の重複排除（cmd_dedup、"周辺クエリの
            # 重複排除"＝近傍窓内の同一query除去）を先に同期実行し、その出力に対して
            # query列だけを見たユニーク数（"全体を見てのクエリの重複排除"＝AIに送る
            # 対象を決めるための重複排除。CSVの行自体はここでは削除しない）を数えて
            # から見積りモーダルを出す方式に変更した（project memory参照）。
            # cmd_dedupの出力CSVは以降の実行でもそのまま入力として使い、
            # _run_in_thread側では二重にdedupしない。
            try:
                dedup_args = _Args()
                dedup_args.input_csv = self.input_csv
                dedup_args.columns_only = False
                QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
                deduped_input_csv = cli_main.cmd_dedup(dedup_args)
            except Exception as e:  # noqa: BLE001 GUIなので落とさず表示する
                QApplication.restoreOverrideCursor()
                QMessageBox.critical(self, APP_TITLE, f"重複排除に失敗しました:\n{e}")
                return

            option_getters = self.option_getters
            filter_column = option_getters["filter_column"]()
            filter_op = option_getters["filter_op"]()
            filter_value = option_getters["filter_value"]()
            try:
                unique_queries = _load_unique_queries_for_estimate(
                    deduped_input_csv, filter_column, filter_op, filter_value
                )
            except Exception as e:  # noqa: BLE001 GUIなので落とさず表示する
                QApplication.restoreOverrideCursor()
                QMessageBox.critical(self, APP_TITLE, f"見積り計算に失敗しました:\n{e}")
                return

            batch_api = option_getters["batch_api"]()
            batch_size = AI_SETTINGS.batch_size if batch_api else AI_SETTINGS.sync_batch_size
            # モデルのバージョン自動解決（project memory参照）。見積り表示用に
            # ここで一度だけ呼ぶ（軽いAPI呼び出し。失敗時はresolve_model内で
            # フォールバックするため例外は出ない）。
            model = classification_common_lib.resolve_model("haiku", api_key=token or None)
            QApplication.restoreOverrideCursor()

            proceed = self._show_estimate_dialog(
                unique_count=len(unique_queries), batch_size=batch_size, batch_api=batch_api, model=model,
            )
            if not proceed:
                return

        args = self._build_args(key, self.option_getters)
        if key == "ai-classify":
            args.input_csv = deduped_input_csv

        # main.pyのcmd_*関数はlib/output_utils.make_output_path()経由で出力先を決めており、
        # make_output_path()は呼び出し時点でoutput_utils_lib.OUTPUT_DIRを参照する。
        # ここで選択フォルダに一度だけ差し替えてから実行することで、main.py側のロジックを
        # 一切変更せずに出力先を切り替えられる。
        output_utils_lib.OUTPUT_DIR = self.output_dir

        # キャンセルボタン用のイベント。ai-classifyのみ意味を持つ（main.py
        # cmd_ai_classifyがargs.cancel_eventをgetattrで拾い、classify_unique()の
        # フェーズ境目・ポーリングループで確認する）が、他ツールでも属性自体は
        # 常にセットしておく（無ければ単に参照されないだけ）。
        self._cancel_event = threading.Event()
        args.cancel_event = self._cancel_event

        self._before_run_files = self._snapshot_output_dir()
        self._reset_progress()
        self._set_running(True)

        thread = threading.Thread(target=self._run_in_thread, args=(key, self.current_func, args), daemon=True)
        thread.start()

    def _show_estimate_dialog(self, unique_count: int, batch_size: int, batch_api: bool, model: str) -> bool:
        """見積りモーダルを表示し、「実行」が押されればTrueを返す
        （2026-08-30新設。project memory参照: 実APIサンプル実行を廃止し、
        ユニークquery数とbatch_size・batch_api有無から実績ベースの分析式で
        計算するだけの無料・即時見積りに変更）。"""
        input_tokens, output_tokens = estimate_tokens(unique_count, batch_size)
        cost_usd = estimate_cost(input_tokens, output_tokens, "haiku", batch_api)
        cost_jpy = cost_usd * USD_TO_JPY
        dialog = EstimateDialog(
            self, unique_count=unique_count, batch_size=batch_size, batch_api=batch_api,
            model=model, input_tokens=input_tokens, output_tokens=output_tokens,
            cost_usd=cost_usd, cost_jpy=cost_jpy,
        )
        return dialog.exec() == QDialog.DialogCode.Accepted

    def _build_args(self, key: str, option_getters: dict) -> _Args:
        args = _Args()
        args.input_csv = self.input_csv

        if key == "ai-classify":
            args.filter_column = option_getters["filter_column"]()
            args.filter_op = option_getters["filter_op"]()
            args.filter_value = option_getters["filter_value"]()
            # cmd_ai_classify側でargs.batch_api次第でどちらを使うか選ぶため
            # （main.pyの--batch-size/--sync-batch-size分離と同じ。project
            # memory参照）、option_getters["batch_size"]（モード込みで解決済みの
            # 値）ではなく、AI_SETTINGSの両方の値をそのまま渡す。
            args.batch_size = AI_SETTINGS.batch_size
            args.sync_batch_size = AI_SETTINGS.sync_batch_size
            args.workers = option_getters["workers"]()
            args.batch_api = option_getters["batch_api"]()
            args.with_report = option_getters["with_report"]()
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
            token = AI_SETTINGS.api_key.strip()
            args.token = token or None

        return args

    def _run_in_thread(self, key: str, func, args) -> None:
        old_stdout, old_stderr = sys.stdout, sys.stderr
        writer = QueueWriter(self.signals)
        sys.stdout = writer
        sys.stderr = writer
        error = None
        try:
            if key == "ai-classify":
                # 2026-08-30、クエリのクレンジング（重複排除、cmd_dedup）は
                # _on_run側で見積りモーダルを出す前に既に実行済み（project memory
                # 参照）。ここで再実行すると二重にdedupしてしまうため呼ばない。
                # args.input_csvは既にcmd_dedupの出力パスに差し替わっている。
                print(f"=== クエリのクレンジング（重複排除）済みCSVを使用します: {args.input_csv} ===")
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
        self._update_progress_from_log(text)

    def _on_run_finished(self, error: Exception | None) -> None:
        self._set_running(False)
        self._cancel_event = None
        if isinstance(error, classification_common_lib.OperationCancelled):
            self._append_log("\nキャンセルしました。\n")
            return
        if error is not None:
            self._append_log(f"\nエラー: {error}\n")
            QMessageBox.critical(self, APP_TITLE, f"実行中にエラーが発生しました:\n{error}")
            return
        self._refresh_output_preview(self._before_run_files)
        self._notify_completion()

    def _set_running(self, running: bool) -> None:
        self.running = running
        self.run_button.setEnabled(not running)
        self.cancel_button.setEnabled(running)
        self._set_progress_running(running)

    # ---------- キャンセル ----------

    def _on_cancel(self) -> None:
        if not self.running or self._cancel_event is None:
            return
        self._cancel_event.set()
        # 二重クリックでの誤解を防ぐため、リクエスト後はボタン自体を無効化する
        # （実行中のAPI呼び出し完了・ジョブポーリングの次のチェックまでは実際には
        # 止まらない。project memory・classification_common.OperationCancelled参照）。
        self.cancel_button.setEnabled(False)
        self._append_log("\nキャンセルをリクエストしました。実行中のAPI呼び出しの完了を待って停止します…\n")

    # ---------- 進捗（フェーズ名＋%） ----------

    def _reset_progress(self) -> None:
        self._progress_phase = None
        self.progress_label.setText("")
        # ツール切り替え時（_on_select）にもここを通るため、レンジ自体も
        # current_keyに合わせて出し直す（_set_progress_running参照。ai-classify
        # なら確定的0-100、analyzeなら不定進捗のrunning=false状態と同じ扱い）。
        self._set_progress_running(False)

    def _update_progress_from_log(self, text: str) -> None:
        """ログに流れる進捗行（_PROGRESS_JOB_RE/_PROGRESS_SYNC_RE/_PROGRESS_RETRY_RE
        参照）をリアルタイムに解析し、フェーズ名と進捗率(%)を進捗バーに反映する
        （2026-08-30、残り時間の目安から置き換え。project memory参照）。
        フェーズが切り替わったら（レベル1/2分類→レベル3分類→カテゴリ再判定、など）
        表示をリセットする。個別/グループリトライで母数（total）が変わった場合は
        その時点の母数で%を出し直すため、進捗が後退することもある（意図した挙動）。"""
        if self.current_key != "ai-classify":
            return
        m = _PROGRESS_JOB_RE.search(text) or _PROGRESS_SYNC_RE.search(text) or _PROGRESS_RETRY_RE.search(text)
        if not m:
            return
        label, done, total = m.group(1).strip(), int(m.group(2)), int(m.group(3))
        if label != self._progress_phase:
            self._progress_phase = label
        if total <= 0:
            return
        percent = min(100, round(done / total * 100))
        self.progress.setValue(percent)
        self.progress_label.setText(f"{label}: {percent}%（{done}/{total}）")

    def _set_progress_running(self, running: bool) -> None:
        # ai-classifyは実際のバッチ完了状況から%を出せるため確定的な進捗バーに
        # する（2026-08-30、_update_progress_from_log参照）。analyzeにはこの
        # 種の進捗ログが無いため、従来通り不定進捗（busy）表現のままにする
        # （Qtではmin=max=0にすると内部的にアニメーションする）。
        if getattr(self, "current_key", None) == "ai-classify":
            self.progress.setRange(0, 100)
            self.progress.setValue(0)
        elif running:
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

    # ---------- 完了通知 ----------

    def _notify_completion(self) -> None:
        """処理完了時（レポート生成・AI分類完了）に、モーダルダイアログ＋
        macOS通知センター経由の通知を出す（2026-08-30新設。project memory参照。
        Dockアイコンへのバッジ付与はPySide6標準機能では実現できずPyObjC等の
        追加依存が必要になるため見送り、通知センター経由のみ実装した）。"""
        label = {"ai-classify": "AIによるクエリの分類", "analyze": "傾向分析"}.get(self.current_key, self.current_key)
        message = f"{label}が完了しました。"

        if QSystemTrayIcon.isSystemTrayAvailable():
            icon = QApplication.style().standardIcon(QStyle.StandardPixmap.SP_MessageBoxInformation)
            if self._tray_icon is None:
                self._tray_icon = QSystemTrayIcon(icon, self)
            else:
                self._tray_icon.setIcon(icon)
            self._tray_icon.show()
            self._tray_icon.showMessage(APP_TITLE, message, icon, 5000)

        QMessageBox.information(self, APP_TITLE, message)


class EstimateDialog(QDialog):
    """実行ボタン押下時に自動表示する見積りモーダル（2026-08-30新設。project
    memory参照）。実APIサンプル実行は行わず、ユニークquery数・batch_size・
    batch_api有無から分析式で計算した値を表示するだけなので無料・即時。
    「実行」を押すとQDialog.Accepted、「キャンセル」を押すとRejectedを返す。"""

    def __init__(
        self, parent: QWidget | None, *, unique_count: int, batch_size: int, batch_api: bool, model: str,
        input_tokens: int, output_tokens: int, cost_usd: float, cost_jpy: float,
    ):
        super().__init__(parent)
        self.setWindowTitle("見積り")
        self.setFixedSize(420, 320)

        layout = QVBoxLayout(self)
        card = QFrame()
        card.setObjectName("card")
        card_layout = QVBoxLayout(card)
        card_layout.setContentsMargins(16, 16, 16, 16)
        layout.addWidget(card)

        batch_api_text = "使う（50%割引適用）" if batch_api else "使わない（同期・即時）"
        lines = [
            f"ユニークquery数: {unique_count:,}件（重複排除後にAIへ送信する件数）",
            f"モデル: {model}",
            f"Batches API使用: {batch_api_text}",
            f"バッチサイズ: {batch_size:,}",
            "",
            f"推定input tokens: {input_tokens:,}",
            f"推定output tokens: {output_tokens:,}",
            "",
            f"推定コスト: ${cost_usd:,.2f}（約{cost_jpy:,.0f}円）",
        ]
        card_layout.addWidget(_muted_label("\n".join(lines), wrap=True))
        card_layout.addWidget(
            _muted_label(
                "（実績ベースの分析式による概算です。実際のコストと異なる場合があります。"
                "実APIは呼び出していません）",
                wrap=True,
            )
        )

        card_layout.addStretch(1)
        button_row = QHBoxLayout()
        button_row.addStretch(1)
        cancel_button = QPushButton("キャンセル")
        cancel_button.clicked.connect(self.reject)
        button_row.addWidget(cancel_button)
        run_button = QPushButton("▶  実行")
        run_button.setObjectName("runButton")
        run_button.clicked.connect(self.accept)
        button_row.addWidget(run_button)
        card_layout.addLayout(button_row)


class SettingsDialog(QDialog):
    """ヘッダー右端の⚙ボタンから開く、AI関連設定の一元ダイアログ。ここで編集する
    内容はAI_SETTINGSそのものなので、閉じても即座に各ツールの実行に反映される
    （実行時にここを読むだけで、各ツールのオプション欄には表示しない）。
    2026-08-27、モデル選択（ai-classify/analyzeそれぞれのコンボボックス）は
    ai-classify=Haiku固定・analyze=Sonnet固定にしたため廃止し、APIキー入力のみに
    縮小した（固定値はclassification_common.CLASSIFY_MODEL/ANALYZE_MODEL）。
    2026-08-29、バッチサイズ・並行数もここに移動した（project memory参照。
    ai-classifyの実行設定欄からは廃止し、ここのAI_SETTINGSを読むだけにした）。"""

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.setWindowTitle("AI設定")
        self.setFixedSize(420, 400)

        layout = QVBoxLayout(self)
        card = QFrame()
        card.setObjectName("card")
        card_layout = QVBoxLayout(card)
        card_layout.setContentsMargins(16, 16, 16, 16)
        layout.addWidget(card)

        info = _muted_label(
            "AIのAPIキーをここで一括管理します。\n"
            "ai-classify / analyze のBatches API・AIコメンタリー使用時は、この設定を使用します。\n"
            "（モデルはai-classify: Haikuファミリー固定、analyze: Sonnetファミリー固定。"
            "バージョンは実行のたびにModels APIで最新版を自動選択）",
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

        # 2026-08-30、ai-classifyの実行設定欄にあった「Batches API使用」トグルを
        # ここに移動した（project memory参照。コストへの影響が大きい割に毎回
        # 意識する設定ではなく、batch_size等と同じ「裏方の設定」寄りのため）。
        batch_api_row = _option_row(card_layout, "Batches API使用")
        self.batch_api_combo = QComboBox()
        self.batch_api_combo.addItems(["使う", "使わない"])
        self.batch_api_combo.setCurrentText("使う" if AI_SETTINGS.batch_api else "使わない")
        _bound_combo_width(self.batch_api_combo, min_chars=6)
        batch_api_row.addWidget(self.batch_api_combo)
        batch_api_row.addStretch(1)

        # 2026-08-30、Batches API使用時/不使用時でバッチサイズの設定を分離した
        # （project memory参照: 非同期ジョブ登録はmax_tokensを動的計算するため
        # 300超を許容できるが、不使用時は全呼び出しが同期のため非ストリーミング
        # SDKのmax_tokensガード対象で300前後が実質上限）。
        batch_size_row = _option_row(card_layout, "バッチサイズ（Batches API使用時）")
        self.batch_size_spin = QSpinBox()
        # 2026-08-29、上限を100→1000に拡大（デフォルト300に対応するため。
        # project memory参照）。
        self.batch_size_spin.setRange(1, 1000)
        self.batch_size_spin.setValue(AI_SETTINGS.batch_size)
        batch_size_row.addWidget(self.batch_size_spin)
        batch_size_row.addStretch(1)

        sync_batch_size_row = _option_row(card_layout, "バッチサイズ（Batches API不使用時）")
        self.sync_batch_size_spin = QSpinBox()
        # 上限は320（max_tokens=15800固定・1件あたり最大約48.75トークン必要という
        # 実測ベースの見積りから逆算した安全圏。project memory参照）。これを超えると
        # 非ストリーミングSDKのmax_tokens>約16,000ガードに引っかかるリスクが増す。
        self.sync_batch_size_spin.setRange(1, 320)
        self.sync_batch_size_spin.setValue(AI_SETTINGS.sync_batch_size)
        sync_batch_size_row.addWidget(self.sync_batch_size_spin)
        sync_batch_size_row.addStretch(1)

        workers_row = _option_row(card_layout, "並行数")
        self.workers_spin = QSpinBox()
        self.workers_spin.setRange(1, 32)
        self.workers_spin.setValue(AI_SETTINGS.workers)
        workers_row.addWidget(self.workers_spin)
        workers_row.addStretch(1)
        card_layout.addWidget(
            _muted_label(
                "（並行数はBatches API不使用時はチャンク並行処理数、使用時は"
                "個別リトライの並行数として使う）",
                wrap=True,
            )
        )

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
        AI_SETTINGS.batch_api = self.batch_api_combo.currentText() == "使う"
        AI_SETTINGS.batch_size = self.batch_size_spin.value()
        AI_SETTINGS.sync_batch_size = self.sync_batch_size_spin.value()
        AI_SETTINGS.workers = self.workers_spin.value()
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
