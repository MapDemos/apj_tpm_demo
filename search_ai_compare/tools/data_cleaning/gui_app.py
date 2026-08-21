#!/usr/bin/env python3
"""
main.py（CSVクレンジング・AI分類・傾向分析CLI）のTkinter GUIラッパー。

同僚に配布する.appにパッケージングするためのエントリポイント
（build_gui.sh参照）。ロジックは一切持たず、main.pyのcmd_*関数を
argparse.Namespace相当のオブジェクトで直接呼び出すだけ。
出力先は lib/output_utils.py が frozen(.app化)時に自動で
~/Documents/AthenaCSVTool/local_output/ に切り替える。
"""

import os
import queue
import subprocess
import sys
import threading
import tkinter as tk
import webbrowser
from tkinter import filedialog, messagebox, ttk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import main as cli_main  # noqa: E402
from lib import classification_common as classification_common_lib  # noqa: E402
from lib.output_utils import OUTPUT_DIR  # noqa: E402

APP_TITLE = "Athena CSV Tool"

# (コマンドキー, 表示名, 呼び出す main.py の関数)
COMMANDS = [
    ("dedup", "重複除去 (dedup)", cli_main.cmd_dedup),
    ("add-query-count", "出現回数列を追加 (add-query-count)", cli_main.cmd_add_query_count),
    ("count-queries", "クエリ出現回数を集計 (count-queries)", cli_main.cmd_count_queries),
    ("ai-classify", "AI分類 (ai-classify)", cli_main.cmd_ai_classify),
    ("ai-retry", "AI再分類 (ai-retry)", cli_main.cmd_ai_retry),
    ("count-classifications", "分類結果を集計 (count-classifications)", cli_main.cmd_count_classifications),
    ("analyze", "傾向分析＋HTMLレポート (analyze)", cli_main.cmd_analyze),
    ("analyze-ai", "傾向分析＋AIコメンタリー (analyze-ai)", cli_main.cmd_analyze_ai),
]


class _Args:
    """main.pyのcmd_*関数がargs.xxxでアクセスする属性を持つだけの簡易Namespace。"""


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


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title(APP_TITLE)
        root.geometry("760x640")
        root.minsize(640, 480)

        self.input_csv = tk.StringVar()
        self.command_key = tk.StringVar(value=COMMANDS[0][0])
        self.log_queue: "queue.Queue[str]" = queue.Queue()
        self.running = False
        self._option_vars: dict[str, tk.Variable] = {}
        self._last_html_report: str | None = None

        self._build_layout()
        self._on_command_change()
        self.root.after(100, self._poll_log_queue)

    # ---------- レイアウト ----------

    def _build_layout(self) -> None:
        pad = {"padx": 8, "pady": 6}

        file_frame = ttk.Frame(self.root)
        file_frame.pack(fill="x", **pad)
        ttk.Label(file_frame, text="入力CSV:").pack(side="left")
        ttk.Entry(file_frame, textvariable=self.input_csv, state="readonly").pack(
            side="left", fill="x", expand=True, padx=6
        )
        ttk.Button(file_frame, text="選択...", command=self._choose_csv).pack(side="left")

        cmd_frame = ttk.Frame(self.root)
        cmd_frame.pack(fill="x", **pad)
        ttk.Label(cmd_frame, text="コマンド:").pack(side="left")
        cmd_combo = ttk.Combobox(
            cmd_frame,
            state="readonly",
            values=[label for _, label, _ in COMMANDS],
            width=40,
        )
        cmd_combo.current(0)
        cmd_combo.pack(side="left", padx=6)
        cmd_combo.bind("<<ComboboxSelected>>", lambda e: self._on_command_select(cmd_combo.current()))
        self._cmd_combo = cmd_combo

        self.options_frame = ttk.LabelFrame(self.root, text="オプション")
        self.options_frame.pack(fill="x", **pad)

        run_frame = ttk.Frame(self.root)
        run_frame.pack(fill="x", **pad)
        self.run_button = ttk.Button(run_frame, text="実行", command=self._on_run)
        self.run_button.pack(side="left")
        self.progress = ttk.Progressbar(run_frame, mode="indeterminate")
        self.progress.pack(side="left", fill="x", expand=True, padx=8)

        result_frame = ttk.Frame(self.root)
        result_frame.pack(fill="x", **pad)
        self.open_folder_button = ttk.Button(
            result_frame, text="出力フォルダを開く", command=self._open_output_folder
        )
        self.open_folder_button.pack(side="left")
        self.open_report_button = ttk.Button(
            result_frame, text="HTMLレポートを開く", command=self._open_report, state="disabled"
        )
        self.open_report_button.pack(side="left", padx=8)

        log_frame = ttk.LabelFrame(self.root, text="ログ")
        log_frame.pack(fill="both", expand=True, **pad)
        self.log_text = tk.Text(log_frame, wrap="word", height=16, state="disabled")
        log_scroll = ttk.Scrollbar(log_frame, command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=log_scroll.set)
        self.log_text.pack(side="left", fill="both", expand=True)
        log_scroll.pack(side="right", fill="y")

    def _choose_csv(self) -> None:
        path = filedialog.askopenfilename(
            title="入力CSVを選択", filetypes=[("CSV files", "*.csv"), ("All files", "*.*")]
        )
        if path:
            self.input_csv.set(path)

    def _on_command_select(self, index: int) -> None:
        self.command_key.set(COMMANDS[index][0])
        self._on_command_change()

    # ---------- コマンド別オプション ----------

    def _clear_options(self) -> None:
        for child in self.options_frame.winfo_children():
            child.destroy()
        self._option_vars = {}

    def _add_row(self, label: str, widget_factory):
        row = ttk.Frame(self.options_frame)
        row.pack(fill="x", padx=8, pady=4)
        ttk.Label(row, text=label, width=16).pack(side="left")
        widget_factory(row)

    def _on_command_change(self) -> None:
        self._clear_options()
        key = self.command_key.get()

        if key == "dedup":
            var = tk.BooleanVar(value=False)
            self._option_vars["columns_only"] = var
            self._add_row(
                "query列のみ抽出",
                lambda row: ttk.Checkbutton(row, variable=var).pack(side="left"),
            )

        elif key in ("ai-classify", "ai-retry"):
            if key == "ai-retry":
                cat_var = tk.StringVar(value="others")
                self._option_vars["category"] = cat_var
                self._add_row(
                    "再分類対象カテゴリ",
                    lambda row: ttk.Combobox(
                        row, textvariable=cat_var, state="readonly",
                        values=list(classification_common_lib.CATEGORIES.values()), width=30,
                    ).pack(side="left"),
                )

            model_var = tk.StringVar(value="haiku")
            self._option_vars["model"] = model_var
            self._add_row(
                "モデル",
                lambda row: ttk.Combobox(
                    row, textvariable=model_var, state="readonly",
                    values=list(classification_common_lib.MODEL_CHOICES.keys()), width=15,
                ).pack(side="left"),
            )

            batch_size_var = tk.IntVar(value=30)
            self._option_vars["batch_size"] = batch_size_var
            self._add_row(
                "バッチサイズ",
                lambda row: ttk.Spinbox(row, textvariable=batch_size_var, from_=1, to=100, width=8).pack(side="left"),
            )

            workers_var = tk.IntVar(value=8)
            self._option_vars["workers"] = workers_var
            self._add_row(
                "並行数(通常API時)",
                lambda row: ttk.Spinbox(row, textvariable=workers_var, from_=1, to=32, width=8).pack(side="left"),
            )

            max_batches_var = tk.StringVar(value="")
            self._option_vars["max_batches"] = max_batches_var
            self._add_row(
                "最大バッチ数(空欄=全件)",
                lambda row: ttk.Entry(row, textvariable=max_batches_var, width=10).pack(side="left"),
            )

            batch_api_var = tk.BooleanVar(value=False)
            self._option_vars["batch_api"] = batch_api_var
            token_var = tk.StringVar(value="")
            self._option_vars["token"] = token_var

            def build_batch_api_row(row: ttk.Frame) -> None:
                ttk.Checkbutton(row, variable=batch_api_var, command=self._sync_token_state).pack(side="left")
                ttk.Label(row, text="  （半額だが非同期・要ご自身のAPIキー）").pack(side="left")

            self._add_row("Batches API使用", build_batch_api_row)

            def build_token_row(row: ttk.Frame) -> None:
                entry = ttk.Entry(row, textvariable=token_var, width=44, show="•")
                entry.pack(side="left")
                self._token_entry = entry

            self._add_row("ANTHROPIC_API_KEY", build_token_row)
            self._sync_token_state()

        elif key in ("analyze", "analyze-ai"):
            top_n_var = tk.IntVar(value=20)
            self._option_vars["top_n"] = top_n_var
            self._add_row(
                "上位クエリ件数",
                lambda row: ttk.Spinbox(row, textvariable=top_n_var, from_=5, to=100, width=8).pack(side="left"),
            )
            if key == "analyze-ai":
                ttk.Label(
                    self.options_frame,
                    text="※AIコメンタリーは社内共有プロキシ経由（APIキー不要）",
                    foreground="gray",
                ).pack(anchor="w", padx=8, pady=(0, 4))

        # add-query-count / count-queries / count-classifications はオプションなし

    def _sync_token_state(self) -> None:
        if not hasattr(self, "_token_entry"):
            return
        using_batch_api = self._option_vars.get("batch_api") and self._option_vars["batch_api"].get()
        self._token_entry.configure(state="normal" if using_batch_api else "disabled")

    # ---------- 実行 ----------

    def _build_args(self, key: str) -> _Args:
        args = _Args()
        args.input_csv = self.input_csv.get()

        if key == "dedup":
            args.columns_only = self._option_vars["columns_only"].get()

        elif key in ("ai-classify", "ai-retry"):
            args.model = self._option_vars["model"].get()
            args.batch_size = self._option_vars["batch_size"].get()
            args.workers = self._option_vars["workers"].get()
            args.batch_api = self._option_vars["batch_api"].get()
            token = self._option_vars["token"].get().strip()
            args.token = token or None
            max_batches_raw = self._option_vars["max_batches"].get().strip()
            args.max_batches = int(max_batches_raw) if max_batches_raw else None
            if key == "ai-retry":
                args.category = self._option_vars["category"].get()

        elif key in ("analyze", "analyze-ai"):
            args.top_n = self._option_vars["top_n"].get()

        return args

    def _on_run(self) -> None:
        if self.running:
            return
        csv_path = self.input_csv.get()
        if not csv_path:
            messagebox.showwarning(APP_TITLE, "入力CSVを選択してください。")
            return

        key = self.command_key.get()
        if key in ("ai-classify", "ai-retry"):
            batch_api = self._option_vars["batch_api"].get()
            token = self._option_vars["token"].get().strip()
            if batch_api and not token and not os.environ.get("ANTHROPIC_API_KEY"):
                messagebox.showwarning(
                    APP_TITLE, "Batches API使用時はANTHROPIC_API_KEYを入力してください。"
                )
                return

        func = next(f for k, _, f in COMMANDS if k == key)
        args = self._build_args(key)

        self._set_running(True)
        self._before_run_files = self._snapshot_output_dir()

        thread = threading.Thread(target=self._run_in_thread, args=(func, args), daemon=True)
        thread.start()

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
        self.root.after(100, self._poll_log_queue)

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
        else:
            self.open_report_button.configure(state="disabled")

    def _set_running(self, running: bool) -> None:
        self.running = running
        self.run_button.configure(state="disabled" if running else "normal")
        if running:
            self.progress.start(12)
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
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
