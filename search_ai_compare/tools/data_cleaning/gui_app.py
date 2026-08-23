#!/usr/bin/env python3
"""
main.py（CSVクレンジング・AI分類・傾向分析CLI）のCustomTkinter GUIラッパー（Octopus）。

同僚に配布する.appにパッケージングするためのエントリポイント
（build_gui.sh参照）。ロジックは一切持たず、main.pyのcmd_*関数を
argparse.Namespace相当のオブジェクトで直接呼び出すだけ。
出力先は lib/output_utils.py が frozen(.app化)時に自動で
~/Documents/AthenaCSVTool/local_output/ に切り替える。

見た目まわり:
  CustomTkinterを使用し、常時ダーク固定・独自配色(gui_theme.json、
  Mapboxっぽい寒色系アクセント)で統一している。CustomTkinterに表形式
  ウィジェットが無いため、CSVプレビューのTreeviewだけttk（darkに
  スタイル上書き）を残している（_setup_ttk_style参照）。それ以外は
  全てCTk*ウィジェットで統一。

画面構成:
  ウィンドウ最上部（タイトルの直下）にタブが2つ並ぶ、これが最上位概念。
    - 🧹 クエリのクレンジング（元データを書き換える）
    - 📊 クエリの分析（元データはいじらず集計・分析するだけ）
  各タブは完全に独立した1画面（TabPage）で、中身の構造は両タブで同じ
  （機能面での違いはツール一覧だけ）:
    ファイルを開く → 出力フォルダ/HTMLレポートを開く → プレビュー（列+先頭5行）
    → ツール選択ドロップダウン → オプション欄 → 実行 → ログ
"""

import csv
import itertools
import os
import queue
import subprocess
import sys
import threading
import tkinter as tk
import webbrowser
from tkinter import filedialog, messagebox, ttk

import customtkinter as ctk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import main as cli_main  # noqa: E402
from lib import classification_common as classification_common_lib  # noqa: E402
from lib.output_utils import OUTPUT_DIR  # noqa: E402

APP_TITLE = "Octopus"

# ---------- 配色（gui_theme.jsonと対応。CTk*ウィジェットの理論値では
# 表現しきれない部分（ttk側・ミュートテキスト・アクセント差し色）を
# コード側で直接使うための定数） ----------
COLOR_BG = "#1A1D24"
COLOR_PANEL = "#242833"
COLOR_BORDER = "#333947"
COLOR_TEXT = "#E7E9EE"
COLOR_MUTED = "#8B93A6"
COLOR_ACCENT = "#4264FB"
COLOR_ACCENT_HOVER = "#2F4FE0"
COLOR_ENTRY_BG = "#20242C"


def _resource_path(*parts: str) -> str:
    """開発時(python3 gui_app.py)とPyInstallerでfrozen化された.app実行時の
    両方で、同梱リソース（gui_theme.json）を正しいパスで見つけるためのヘルパー。
    frozen時はsys._MEIPASSが展開先の一時ディレクトリを指す。"""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, *parts)


class _Args:
    """main.pyのcmd_xxx関数がargs.xxxでアクセスする属性を持つだけの簡易Namespace。"""


class QueueWriter:
    """print()の出力をキューに流し込むsys.stdout/stderrの差し替え先。
    Tkinterのメインループ側でポーリングしてログ欄に反映する（別スレッドから
    直接ウィジェットを触らないようにするため）。"""

    def __init__(self, q: "queue.Queue[str]"):
        self.q = q

    def write(self, text: str) -> None:
        if text:
            self.q.put(text)

    def flush(self) -> None:
        pass


def _setup_ttk_style() -> None:
    """CSVプレビュー表(ttk.Treeview)だけはCustomTkinterに表形式ウィジェットが
    無いため素のttkを使う。そのままだとダークテーマから浮いて見えるので、
    独自配色に合わせてスタイルを上書きする。"""
    style = ttk.Style()
    style.theme_use("clam")
    style.configure(
        "TFrame", background=COLOR_PANEL,
    )
    style.configure(
        "Treeview",
        background=COLOR_ENTRY_BG,
        fieldbackground=COLOR_ENTRY_BG,
        foreground=COLOR_TEXT,
        bordercolor=COLOR_BORDER,
        borderwidth=0,
        rowheight=26,
        font=("", 11),
    )
    style.map(
        "Treeview",
        background=[("selected", COLOR_ACCENT)],
        foreground=[("selected", "#F5F7FA")],
    )
    style.configure(
        "Treeview.Heading",
        background=COLOR_PANEL,
        foreground=COLOR_TEXT,
        font=("", 11, "bold"),
        relief="flat",
        borderwidth=0,
    )
    style.map("Treeview.Heading", background=[("active", COLOR_BORDER)])
    style.configure(
        "Horizontal.TScrollbar",
        background=COLOR_PANEL,
        troughcolor=COLOR_BG,
        bordercolor=COLOR_BORDER,
        arrowcolor=COLOR_TEXT,
    )


def _section_card(parent: ctk.CTkFrame, title: str) -> ctk.CTkFrame:
    """タイトル付きの角丸カードを1枚作り、中身を積むためのbodyフレームを返す。
    プレビュー/ツール実行設定/ログの3ブロックをそれぞれ独立したカードとして
    見せることで、フラットに並ぶだけだった旧UIより視覚的な区切りを付ける。"""
    card = ctk.CTkFrame(parent, fg_color=COLOR_PANEL, corner_radius=12, border_width=1, border_color=COLOR_BORDER)
    card.pack(fill="both", pady=(0, 16), padx=2)
    ctk.CTkLabel(
        card, text=title, font=ctk.CTkFont(size=13, weight="bold"), text_color=COLOR_TEXT,
    ).pack(anchor="w", padx=16, pady=(14, 8))
    body = ctk.CTkFrame(card, fg_color="transparent")
    body.pack(fill="both", expand=True, padx=16, pady=(0, 16))
    return body


def _divider(parent: ctk.CTkFrame) -> None:
    ctk.CTkFrame(parent, fg_color=COLOR_BORDER, height=1, corner_radius=0).pack(fill="x", pady=14)


# ---------- コマンド別オプションのビルダー ----------
# それぞれ body(親フレーム)にウィジェットを積み、{変数名: tk.Variable} を返す。
# main.pyのargs.xxxと同じ名前をキーにしているので、_build_argsで機械的に詰め替えられる。


def _option_row(body: ctk.CTkFrame, label: str) -> ctk.CTkFrame:
    row = ctk.CTkFrame(body, fg_color="transparent")
    row.pack(fill="x", pady=4)
    ctk.CTkLabel(row, text=label, width=170, anchor="w", text_color=COLOR_MUTED).pack(side="left")
    return row


def _make_stepper(parent: ctk.CTkFrame, var: tk.IntVar, minimum: int, maximum: int) -> ctk.CTkFrame:
    """ttk.Spinbox相当。CustomTkinterにスピンボックスが無いため、
    [－][数値入力][＋]の3ウィジェットで代用する。"""
    frame = ctk.CTkFrame(parent, fg_color="transparent")

    def _step(delta: int) -> None:
        try:
            value = var.get()
        except tk.TclError:
            value = minimum
        var.set(max(minimum, min(maximum, value + delta)))

    ctk.CTkButton(frame, text="－", width=30, command=lambda: _step(-1)).pack(side="left")
    ctk.CTkEntry(frame, textvariable=var, width=56, justify="center").pack(side="left", padx=6)
    ctk.CTkButton(frame, text="＋", width=30, command=lambda: _step(1)).pack(side="left")
    return frame


def build_dedup_options(body: ctk.CTkFrame) -> dict:
    var = tk.BooleanVar(value=False)
    row = _option_row(body, "query列のみ抽出")
    ctk.CTkCheckBox(row, text="", variable=var, width=24).pack(side="left")
    return {"columns_only": var}


def build_ai_options(body: ctk.CTkFrame, with_category: bool) -> dict:
    option_vars: dict[str, tk.Variable] = {}

    if with_category:
        cat_var = tk.StringVar(value="others")
        row = _option_row(body, "再分類対象カテゴリ")
        ctk.CTkOptionMenu(
            row, variable=cat_var, values=list(classification_common_lib.CATEGORIES.values()), width=220,
        ).pack(side="left")
        option_vars["category"] = cat_var

    model_var = tk.StringVar(value="haiku")
    row = _option_row(body, "モデル")
    ctk.CTkOptionMenu(
        row, variable=model_var, values=list(classification_common_lib.MODEL_CHOICES.keys()), width=140,
    ).pack(side="left")
    option_vars["model"] = model_var

    batch_size_var = tk.IntVar(value=30)
    row = _option_row(body, "バッチサイズ")
    _make_stepper(row, batch_size_var, 1, 100).pack(side="left")
    option_vars["batch_size"] = batch_size_var

    workers_var = tk.IntVar(value=8)
    row = _option_row(body, "並行数(通常API時)")
    _make_stepper(row, workers_var, 1, 32).pack(side="left")
    option_vars["workers"] = workers_var

    max_batches_var = tk.StringVar(value="")
    row = _option_row(body, "最大バッチ数(空欄=全件)")
    ctk.CTkEntry(row, textvariable=max_batches_var, width=90).pack(side="left")
    option_vars["max_batches"] = max_batches_var

    batch_api_var = tk.BooleanVar(value=False)
    token_var = tk.StringVar(value="")

    token_row = _option_row(body, "ANTHROPIC_API_KEY")
    token_entry = ctk.CTkEntry(token_row, textvariable=token_var, width=280, show="•")
    token_entry.pack(side="left")
    token_entry.configure(state="disabled")

    def on_batch_api_toggle() -> None:
        token_entry.configure(state="normal" if batch_api_var.get() else "disabled")

    row = _option_row(body, "Batches API使用")
    ctk.CTkCheckBox(row, text="", variable=batch_api_var, width=24, command=on_batch_api_toggle).pack(side="left")
    ctk.CTkLabel(row, text="（半額・非同期・要ご自身のAPIキー、課金は各自）", text_color=COLOR_MUTED).pack(
        side="left", padx=8
    )

    option_vars["batch_api"] = batch_api_var
    option_vars["token"] = token_var
    return option_vars


COUNT_COLUMN_CHOICES = {
    "クエリ（query列）": "query",
    "AI分類結果（ai_classification列）": "ai_classification",
}


def build_count_column_options(body: ctk.CTkFrame) -> dict:
    var = tk.StringVar(value=next(iter(COUNT_COLUMN_CHOICES)))
    row = _option_row(body, "集計対象の列")
    ctk.CTkOptionMenu(row, variable=var, values=list(COUNT_COLUMN_CHOICES.keys()), width=260).pack(side="left")
    return {"column": var}


def build_analyze_options(body: ctk.CTkFrame) -> dict:
    top_n_var = tk.IntVar(value=20)
    row = _option_row(body, "上位クエリ件数")
    _make_stepper(row, top_n_var, 5, 100).pack(side="left")

    ai_var = tk.BooleanVar(value=False)
    row = _option_row(body, "AIコメンタリー")
    ctk.CTkCheckBox(row, text="", variable=ai_var, width=24).pack(side="left")
    ctk.CTkLabel(row, text="（Claude Sonnet 5・プロキシ経由でレポートに要約を追加）", text_color=COLOR_MUTED).pack(
        side="left", padx=8
    )

    return {"top_n": top_n_var, "with_ai_commentary": ai_var}


# (コマンドキー, 表示名, main.pyの関数, オプションビルダー(Noneなら無し))
CLEANING_TOOLS = [
    ("dedup", "🧹  重複クエリの除去", cli_main.cmd_dedup, build_dedup_options),
    ("add-query-count", "🔢  同一クエリの出現回数の追加", cli_main.cmd_add_query_count, None),
    ("ai-classify", "🤖  AIによるクエリの分類（高負荷）", cli_main.cmd_ai_classify,
     lambda body: build_ai_options(body, with_category=False)),
    ("ai-retry", "🔁  AIによるクエリの分類のリトライ（高負荷）", cli_main.cmd_ai_retry,
     lambda body: build_ai_options(body, with_category=True)),
]

ANALYSIS_TOOLS = [
    ("count-column", "📈  出現回数を集計", cli_main.cmd_count_column, build_count_column_options),
    ("analyze", "📑  傾向分析＋HTMLレポート", cli_main.cmd_analyze, build_analyze_options),
]


class TabPage:
    """1タブ分の画面全体（ファイルを開く〜ログ）。データクレンジング/データ分析の
    どちらのタブも、渡すtools一覧が違うだけで構造は完全に同じ。他タブの状態とは
    無関係に、ファイル選択・出力・ログを独立して持つ。"""

    def __init__(self, parent: ctk.CTkFrame, tools: list, description: str):
        self.tools = tools
        self.input_csv: str | None = None
        self.file_display = tk.StringVar(value="（未選択）")
        self.option_vars: dict[str, tk.Variable] = {}
        self.log_queue: "queue.Queue[str]" = queue.Queue()
        self.running = False
        self._last_html_report: str | None = None
        self._before_run_files: set[str] = set()

        self._build(parent, description)
        parent.after(100, self._poll_log_queue)

    def _build(self, parent: ctk.CTkFrame, description: str) -> None:
        # CTkScrollableFrameはホイール/トラックパッドのスクロールを自前で
        # 処理してくれる（マウス直下のインスタンスにだけ効く）ので、旧実装の
        # 自前Canvas+bind_all振り分け(_make_scrollable/_bind_mousewheel_scroll)は不要。
        outer = ctk.CTkScrollableFrame(parent, fg_color="transparent")
        outer.pack(fill="both", expand=True, padx=14, pady=14)

        if description:
            ctk.CTkLabel(outer, text=description, text_color=COLOR_MUTED).pack(anchor="w", pady=(0, 12))

        # ファイルを開く
        file_frame = ctk.CTkFrame(outer, fg_color="transparent")
        file_frame.pack(fill="x", pady=4)
        ctk.CTkButton(file_frame, text="📂  ファイルを開く...", command=self._choose_csv, width=180).pack(side="left")
        ctk.CTkLabel(file_frame, textvariable=self.file_display, text_color=COLOR_MUTED).pack(
            side="left", padx=12
        )

        # 出力フォルダ + HTMLレポート
        output_frame = ctk.CTkFrame(outer, fg_color="transparent")
        output_frame.pack(fill="x", pady=4)
        ctk.CTkButton(output_frame, text="📁  出力フォルダ", command=self._open_output_folder, width=140).pack(
            side="left"
        )
        ctk.CTkLabel(output_frame, text=OUTPUT_DIR, text_color=COLOR_MUTED).pack(side="left", padx=12)
        self.open_report_button = ctk.CTkButton(
            output_frame, text="📄  HTMLレポートを開く", command=self._open_report, state="disabled", width=170,
        )
        self.open_report_button.pack(side="right")

        _divider(outer)

        # プレビュー
        preview_body = _section_card(outer, "プレビュー（列 + 先頭5行）")
        self.preview_container = preview_body
        ctk.CTkLabel(
            self.preview_container, text="CSVを選択するとここに表示されます", text_color=COLOR_MUTED
        ).pack(anchor="w")

        # 実行設定（ツール選択 → オプション → 実行 → 進捗）
        run_body = _section_card(outer, "実行設定")

        select_row = ctk.CTkFrame(run_body, fg_color="transparent")
        select_row.pack(fill="x")
        ctk.CTkLabel(select_row, text="ツール:", font=ctk.CTkFont(size=13, weight="bold")).pack(side="left")
        self.tool_var = tk.StringVar(value=self.tools[0][1])
        ctk.CTkOptionMenu(
            select_row, variable=self.tool_var, values=[label for _, label, _, _ in self.tools],
            width=380, command=self._on_select_by_label,
        ).pack(side="left", padx=10)

        self.options_frame = ctk.CTkFrame(run_body, fg_color="transparent")
        self.options_frame.pack(fill="x", pady=(14, 0))

        run_row = ctk.CTkFrame(run_body, fg_color="transparent")
        run_row.pack(fill="x", pady=(16, 0))
        self.run_button = ctk.CTkButton(
            run_row, text="▶  実行", command=self._on_run, width=140, height=38,
            fg_color=COLOR_ACCENT, hover_color=COLOR_ACCENT_HOVER, text_color="#F5F7FA",
            font=ctk.CTkFont(size=13, weight="bold"),
        )
        self.run_button.pack(side="left")

        self.progress = ctk.CTkProgressBar(run_body, mode="indeterminate", height=6)
        self.progress.set(0)
        self.progress.pack(fill="x", pady=(14, 0))

        # ログ
        log_body = _section_card(outer, "ログ")
        self.log_text = ctk.CTkTextbox(log_body, wrap="word", height=160, state="disabled")
        self.log_text.pack(fill="both", expand=True)

        self._on_select(0)

    def _choose_csv(self) -> None:
        path = filedialog.askopenfilename(
            title="入力CSVを選択", filetypes=[("CSV files", "*.csv"), ("All files", "*.*")]
        )
        if not path:
            return
        self.input_csv = path
        self.file_display.set(path)
        self._load_preview(path)

    # ---------- プレビュー ----------

    def _load_preview(self, path: str) -> None:
        for child in self.preview_container.winfo_children():
            child.destroy()

        try:
            with open(path, newline="", encoding="utf-8-sig") as f:
                reader = csv.reader(f)
                header = next(reader, None)
                sample_rows = list(itertools.islice(reader, 5))
        except Exception as e:  # noqa: BLE001 プレビューはあくまで補助表示なので落とさない
            ctk.CTkLabel(self.preview_container, text=f"プレビュー読み込み失敗: {e}", text_color="#FF6B6B").pack(
                anchor="w"
            )
            return

        if not header:
            ctk.CTkLabel(self.preview_container, text="CSVが空です", text_color=COLOR_MUTED).pack(anchor="w")
            return

        # CustomTkinterに表形式ウィジェットが無いためここだけttk.Treeviewを使う
        # （ダーク配色は_setup_ttk_styleで上書き済み）。
        tree_frame = ttk.Frame(self.preview_container)
        tree_frame.pack(fill="both", expand=True)

        tree = ttk.Treeview(tree_frame, columns=header, show="headings", height=5)
        for col in header:
            tree.heading(col, text=col)
            tree.column(col, width=120, anchor="w", stretch=False)
        for row in sample_rows:
            tree.insert("", "end", values=row)

        x_scroll = ttk.Scrollbar(tree_frame, orient="horizontal", command=tree.xview)
        tree.configure(xscrollcommand=x_scroll.set)
        tree.pack(side="top", fill="both", expand=True)
        x_scroll.pack(side="bottom", fill="x")

    # ---------- ツール選択 ----------

    def _on_select_by_label(self, label: str) -> None:
        index = next(i for i, t in enumerate(self.tools) if t[1] == label)
        self._on_select(index)

    def _on_select(self, index: int) -> None:
        for child in self.options_frame.winfo_children():
            child.destroy()
        key, label, func, builder = self.tools[index]
        self.current_key = key
        self.current_func = func
        if builder is not None:
            self.option_vars = builder(self.options_frame) or {}
        else:
            self.option_vars = {}
            ctk.CTkLabel(self.options_frame, text="（オプションなし）", text_color=COLOR_MUTED).pack(anchor="w")

    # ---------- 実行 ----------

    def _on_run(self) -> None:
        if self.running:
            return
        if not self.input_csv:
            messagebox.showwarning(APP_TITLE, "入力CSVを選択してください。")
            return

        key = self.current_key
        if key in ("ai-classify", "ai-retry"):
            batch_api = self.option_vars["batch_api"].get()
            token = self.option_vars["token"].get().strip()
            if batch_api and not token and not os.environ.get("ANTHROPIC_API_KEY"):
                messagebox.showwarning(
                    APP_TITLE, "Batches API使用時はANTHROPIC_API_KEYを入力してください。"
                )
                return

        args = self._build_args(key, self.option_vars)

        self._set_running(True)
        self._before_run_files = self._snapshot_output_dir()

        thread = threading.Thread(target=self._run_in_thread, args=(self.current_func, args), daemon=True)
        thread.start()

    def _build_args(self, key: str, option_vars: dict) -> _Args:
        args = _Args()
        args.input_csv = self.input_csv

        if key == "dedup":
            args.columns_only = option_vars["columns_only"].get()

        elif key == "count-column":
            args.column = COUNT_COLUMN_CHOICES[option_vars["column"].get()]

        elif key in ("ai-classify", "ai-retry"):
            args.model = option_vars["model"].get()
            args.batch_size = option_vars["batch_size"].get()
            args.workers = option_vars["workers"].get()
            args.batch_api = option_vars["batch_api"].get()
            token = option_vars["token"].get().strip()
            args.token = token or None
            max_batches_raw = option_vars["max_batches"].get().strip()
            args.max_batches = int(max_batches_raw) if max_batches_raw else None
            if key == "ai-retry":
                args.category = option_vars["category"].get()

        elif key == "analyze":
            args.top_n = option_vars["top_n"].get()
            args.with_ai_commentary = option_vars["with_ai_commentary"].get()

        return args

    def _run_in_thread(self, func, args) -> None:
        old_stdout, old_stderr = sys.stdout, sys.stderr
        writer = QueueWriter(self.log_queue)
        sys.stdout = writer
        sys.stderr = writer
        error = None
        try:
            func(args)
        except Exception as e:  # noqa: BLE001 GUIなので落とさず表示する
            error = e
        finally:
            sys.stdout, sys.stderr = old_stdout, old_stderr
        self.log_queue.put(("__DONE__", error))

    def _snapshot_output_dir(self) -> set[str]:
        if not os.path.isdir(OUTPUT_DIR):
            return set()
        return set(os.listdir(OUTPUT_DIR))

    def _poll_log_queue(self) -> None:
        try:
            while True:
                item = self.log_queue.get_nowait()
                if isinstance(item, tuple) and item[0] == "__DONE__":
                    self._on_run_finished(item[1])
                else:
                    self._append_log(item)
        except queue.Empty:
            pass
        self.log_text.after(100, self._poll_log_queue)

    def _append_log(self, text: str) -> None:
        self.log_text.configure(state="normal")
        self.log_text.insert("end", text)
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def _on_run_finished(self, error: Exception | None) -> None:
        self._set_running(False)
        if error is not None:
            self._append_log(f"\nエラー: {error}\n")
            messagebox.showerror(APP_TITLE, f"実行中にエラーが発生しました:\n{error}")

        new_files = self._snapshot_output_dir() - self._before_run_files
        html_files = [f for f in new_files if f.endswith(".html")]
        if html_files:
            self._last_html_report = os.path.join(OUTPUT_DIR, sorted(html_files)[-1])
            self.open_report_button.configure(state="normal")

    def _set_running(self, running: bool) -> None:
        self.running = running
        self.run_button.configure(state="disabled" if running else "normal")
        if running:
            self.progress.start()
        else:
            self.progress.stop()

    # ---------- 出力操作 ----------

    def _open_output_folder(self) -> None:
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        subprocess.run(["open", OUTPUT_DIR], check=False)

    def _open_report(self) -> None:
        if self._last_html_report and os.path.exists(self._last_html_report):
            webbrowser.open(f"file://{self._last_html_report}")


def main() -> None:
    ctk.set_appearance_mode("dark")  # 常時ダーク固定（システム連動しない）
    ctk.set_default_color_theme(_resource_path("gui_theme.json"))
    _setup_ttk_style()

    root = ctk.CTk()
    root.title(APP_TITLE)
    root.geometry("860x800")
    root.minsize(720, 620)
    root.configure(fg_color=COLOR_BG)

    tabview = ctk.CTkTabview(
        root, fg_color=COLOR_BG, border_width=0,
        segmented_button_font=ctk.CTkFont(size=13, weight="bold"),
    )
    tabview.pack(fill="both", expand=True, padx=6, pady=6)

    cleaning_tab = tabview.add("🧹  クエリのクレンジング")
    analysis_tab = tabview.add("📊  クエリの分析")

    TabPage(cleaning_tab, CLEANING_TOOLS, "元データそのものを書き換える処理です。")
    TabPage(analysis_tab, ANALYSIS_TOOLS, "元データはいじらず、集計・分析のみ行います。")

    root.mainloop()


if __name__ == "__main__":
    main()
