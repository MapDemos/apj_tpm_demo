tools/data_cleaning/ 配下スクリプト一覧
============================

想定入力CSVの列（共通）:
"endpoint","query","bbox","proximity","types","poi_category",
"poi_category_exclusions","result_limit","language","country",
"near","navigation_profile","datetime"

出力ファイルについて
--------------------------------------------------------------
全スクリプトとも output_csv 引数は無く、input.csv 1本だけを渡す。
出力先は自動的に output/ 配下、ファイル名は

    <元のファイル名（拡張子なし）>_<何をしたか分かるsuffix>_<YYYYMMDD_HHMMSS>.csv

という形式になる（lib/output_utils.py の make_output_path が生成）。
パイプラインで前段の出力を次段の入力に渡していくと、ファイル名に
suffixが積み重なっていくので、ファイル名だけで処理履歴を追える。
output/ 配下のCSVはgitignore対象（.gitignoreで*.csvを除外）。

フォルダ構成について
--------------------------------------------------------------
直接実行するスクリプト（python3 xxx.py として使うもの）は
data_cleaning/ 直下に置き、他のスクリプトからimportされるだけの
共有モジュール（classification_common.py, output_utils.py）は
lib/ 配下にまとめている。


--------------------------------------------------------------
dedup_queries.py  [suffix: cleaning]
--------------------------------------------------------------
概要:
  入力CSVの全列を保持したまま、"query" が後ろ5行以内に再出現する重複を削除する。

実行例:
  python3 dedup_queries.py input.csv


--------------------------------------------------------------
clean_queries.py  [suffix: cleaning_queryonly]
--------------------------------------------------------------
概要:
  dedup_queries.py と同じ重複除去ロジックだが、"query" 列だけを
  抽出して1列のCSVとして出力する版（他の列は捨てられる）。

実行例:
  python3 clean_queries.py input.csv


--------------------------------------------------------------
count_queries.py  [suffix: count_analysis_result]
--------------------------------------------------------------
概要:
  CSV内の "query" 列の出現回数を、行の近さに関係なく全体でカウントする。
  出力CSV列: query, count（countの降順、同数なら初出順）

実行例:
  python3 count_queries.py input.csv


--------------------------------------------------------------
lib/classification_common.py
--------------------------------------------------------------
概要:
  classify_queries.py / classify_queries_batch.py が共有する、
  query分類のカテゴリ定義（1〜7の番号とカテゴリ名の対応）とプロンプト
  生成ロジック。単体では実行しない（importされるだけのモジュール）。
  実行エントリポイントではないため lib/ 配下にまとめている。

  カテゴリ: 1=poi, 2=poi_brand, 3=poi_category, 4=address,
  5=unsupported_query_location_intent, 6=broken_query, 7=others


--------------------------------------------------------------
classify_queries.py  [suffix: classified_analysis_result]
--------------------------------------------------------------
概要:
  LLM（Claude Haiku、プロキシ経由）を使って "query" 列を分類し、
  "ai_classification" 列を追加したCSVを出力する。バッチ分割＋並行処理版。
  1バッチがまるごと失敗した場合は、その中身を1件ずつ個別に再試行し、
  それでも失敗した行だけを others にフォールバックする。

実行例:
  python3 classify_queries.py input.csv
  python3 classify_queries.py input.csv --batch-size 30 --workers 8
  python3 classify_queries.py input.csv --max-batches 3   # 動作確認用に件数を絞る


--------------------------------------------------------------
classify_queries_batch.py  [suffix: classified_batch_analysis_result]
--------------------------------------------------------------
概要:
  classify_queries.py と同じ分類タスクを、Anthropic Message Batches API
  （非同期・トークン単価50%引き、結果取得まで数分〜最大24時間）で行う版。
  プロキシ経由では動かない可能性が高く、本物の ANTHROPIC_API_KEY が必要。

事前準備:
  pip install anthropic
  export ANTHROPIC_API_KEY=sk-ant-...

実行例:
  python3 classify_queries_batch.py input.csv
  python3 classify_queries_batch.py input.csv --batch-size 30


--------------------------------------------------------------
retry_others_queries.py  [suffix: classified_retry_analysis_result]
--------------------------------------------------------------
概要:
  classify_queries.py の出力CSVのうち、"ai_classification" が "others"
  になっている行だけを対象に再分類し、その列だけを更新した別CSVを出力する。
  分類ロジックは classify_queries.py の classify_all をそのまま再利用する
  （プロンプト修正・個別再試行フォールバックの改善もそのまま反映される）。

実行例:
  python3 retry_others_queries.py classified.csv
  python3 retry_others_queries.py classified.csv --max-batches 3   # 動作確認用


--------------------------------------------------------------
count_classifications.py  [suffix: classification_count_analysis_result]
--------------------------------------------------------------
概要:
  classify_queries.py（または retry_others_queries.py）の出力CSVにある
  "ai_classification" 列を件数集計する。
  出力CSV列: ai_classification, count, ratio
  （classification_common.py のカテゴリ順で出力、想定外ラベルは件数降順で末尾に追加）

実行例:
  python3 count_classifications.py classified.csv


--------------------------------------------------------------
lib/output_utils.py
--------------------------------------------------------------
概要:
  各スクリプトが共有する、出力ファイルパスの命名ロジック
  （make_output_path: 元ファイル名 + suffix + 秒までのタイムスタンプ → output/配下）。
  単体では実行しない（importされるだけのモジュール）。
  実行エントリポイントではないため lib/ 配下にまとめている。


--------------------------------------------------------------
想定の処理フロー（一例）
--------------------------------------------------------------
1. dedup_queries.py     で重複除去（元フォーマット保持）
2. classify_queries.py  でAI分類（ai_classification列を追加）
3. count_classifications.py で分類結果の件数・割合を確認
4. othersが多ければ retry_others_queries.py で再分類
   （必要なら classification_common.py のプロンプトを見直してから）
