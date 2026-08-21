"""
data_cleaning/ 配下の各スクリプトが共有する、出力ファイルパスの命名ロジック（lib/配下）。

出力は必ず data_cleaning/local_output/ 配下に、
    <元のファイル名（拡張子なし）>_<suffix>_<YYYYMMDD_HHMMSS>.csv
という名前で書き出す。output_csvの引数を各スクリプトから無くし、
「何のツールで処理した結果か」がファイル名だけで分かるようにするための共通処理。

パイプラインで複数ステップを繋いだ場合（例: dedupの出力をclassifyに渡す）、
入力ファイル名に既についているsuffixはそのまま残るので、ファイル名を見れば
処理の履歴（cleaning → classified_analysis_result → ...）がそのまま追える。
"""

import os
import sys
from datetime import datetime

if getattr(sys, "frozen", False):
    # PyInstallerでバンドルされたGUIアプリの場合、__file__はアプリ内部の
    # 一時展開パス（onefileなら_MEIPASS、onedirでもContents/Resources配下）を指し、
    # 書き込み不可 or アプリ更新/再起動で消える。ユーザーのホーム配下に固定する。
    _DATA_CLEANING_DIR = os.path.expanduser("~/Documents/AthenaCSVTool")
else:
    _DATA_CLEANING_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT_DIR = os.path.join(_DATA_CLEANING_DIR, "local_output")


def current_timestamp() -> str:
    """秒までのフルタイムスタンプを1本生成する。
    1回の実行で複数ファイルを出力するスクリプト（例: analyze_query_trends.py）が、
    ファイル間でタイムスタンプを揃えたい場合に使う。"""
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def make_output_path(input_path: str, suffix: str, timestamp: str | None = None, ext: str = "csv") -> str:
    """input_path のファイル名 + suffix + 秒までのフルタイムスタンプ から
    local_output/ 配下の出力パスを組み立てる。local_output/ ディレクトリが無ければ作成する。

    timestamp を省略した場合は呼び出し時点の時刻を使う。1回の実行で複数ファイルを
    出力する場合は current_timestamp() で1本生成し、共通で渡すとファイル名が揃う。
    ext は拡張子（デフォルト csv。HTMLレポート等を出す場合は "html" を渡す）。
    """
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    stem = os.path.splitext(os.path.basename(input_path))[0]
    timestamp = timestamp or current_timestamp()
    filename = f"{stem}_{suffix}_{timestamp}.{ext}"
    return os.path.join(OUTPUT_DIR, filename)
