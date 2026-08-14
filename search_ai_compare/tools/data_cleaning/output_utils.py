"""
data_cleaning/ 配下の各スクリプトが共有する、出力ファイルパスの命名ロジック。

出力は必ず data_cleaning/output/ 配下に、
    <元のファイル名（拡張子なし）>_<suffix>_<YYYYMMDD_HHMMSS>.csv
という名前で書き出す。output_csvの引数を各スクリプトから無くし、
「何のツールで処理した結果か」がファイル名だけで分かるようにするための共通処理。

パイプラインで複数ステップを繋いだ場合（例: dedupの出力をclassifyに渡す）、
入力ファイル名に既についているsuffixはそのまま残るので、ファイル名を見れば
処理の履歴（cleaning → classified_analysis_result → ...）がそのまま追える。
"""

import os
from datetime import datetime

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")


def make_output_path(input_path: str, suffix: str) -> str:
    """input_path のファイル名 + suffix + 秒までのフルタイムスタンプ から
    output/ 配下の出力パスを組み立てる。output/ ディレクトリが無ければ作成する。"""
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    stem = os.path.splitext(os.path.basename(input_path))[0]
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{stem}_{suffix}_{timestamp}.csv"
    return os.path.join(OUTPUT_DIR, filename)
