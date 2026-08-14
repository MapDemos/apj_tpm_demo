tools/data_cleaning/ — CSVクレンジング・AI分類・傾向分析CLI
============================

想定入力CSVの列（共通）:
"endpoint","query","bbox","proximity","types","poi_category",
"poi_category_exclusions","result_limit","language","country",
"near","navigation_profile","datetime"

全機能は main.py の1本のCLIにサブコマンドとしてまとまっている。
サブコマンド一覧: dedup / add-query-count / count-queries / ai-classify /
ai-classify-batch / ai-retry / count-classifications / analyze / analyze-ai

    python3 main.py <subcommand> input.csv [オプション]
    python3 main.py <subcommand> --help   # サブコマンドごとの詳細

出力ファイルについて
--------------------------------------------------------------
全サブコマンドとも output_csv 引数は無く、input.csv 1本だけを渡す。
出力先は自動的に local_output/ 配下、ファイル名は

    <元のファイル名（拡張子なし）>_<何をしたか分かるsuffix>_<YYYYMMDD_HHMMSS>.csv

という形式になる（lib/output_utils.py の make_output_path が生成）。
パイプラインで前段の出力を次段の入力に渡していくと、ファイル名に
suffixが積み重なっていくので、ファイル名だけで処理履歴を追える。
local_output/ 配下のCSV・HTMLはgitignore対象（.gitignoreで除外）。

フォルダ構成について
--------------------------------------------------------------
main.py が唯一のエントリポイント（直接実行するのはこれだけ）。
各サブコマンドの実処理ロジックは lib/ 配下のモジュールに切り出してあり、
lib/ 配下のファイルは単体では実行しない（main.py からimportされるだけ）。


--------------------------------------------------------------
dedup  [suffix: cleaning / cleaning_queryonly]
--------------------------------------------------------------
概要:
  "query" が後ろ5行以内に再出現する重複を削除する（最初の出現を正とする）。
  --columns-only を付けると、全列を保持する代わりに "query" 列だけを
  抽出した1列のCSVを出力する（他の列は捨てられる）。

  同時に "same_query_count" 列を自動付与する（重複除去する"前"の入力全体で
  そのqueryが何回出現したかを、プログラム的にカウントするだけ。AIは使わない）。

実行例:
  python3 main.py dedup input.csv
  python3 main.py dedup input.csv --columns-only


--------------------------------------------------------------
add-query-count  [suffix: query_count_annotated]
--------------------------------------------------------------
概要:
  dedup の "same_query_count" 列付与だけを単体で行うサブコマンド。
  重複除去はせず、全行をそのまま保持した上で、"query" 列の値が入力全体で
  何回出現するかを数え、"same_query_count" 列として追加する。
  プログラム的なカウントのみでAIは使わない。

実行例:
  python3 main.py add-query-count input.csv


--------------------------------------------------------------
count-queries  [suffix: count_analysis_result]
--------------------------------------------------------------
概要:
  CSV内の "query" 列の出現回数を、行の近さに関係なく全体でカウントする。
  出力CSV列: query, count（countの降順、同数なら初出順）

実行例:
  python3 main.py count-queries input.csv


--------------------------------------------------------------
ai-classify  [suffix: classified_analysis_result]
--------------------------------------------------------------
概要:
  LLM（Claude Haiku、プロキシ経由）を使って "query" 列を分類し、
  "ai_classification" 列を追加したCSVを出力する。バッチ分割＋並行処理版。
  1バッチがまるごと失敗した場合は、その中身を1件ずつ個別に再試行し、
  それでも失敗した行だけを others にフォールバックする。

  分類カテゴリの定義は lib/classification_common.py を参照:
  1=poi, 2=poi_brand, 3=poi_category, 4=address,
  5=unsupported_query_location_intent, 6=broken_query, 7=others

実行例:
  python3 main.py ai-classify input.csv
  python3 main.py ai-classify input.csv --batch-size 30 --workers 8
  python3 main.py ai-classify input.csv --max-batches 3   # 動作確認用に件数を絞る


--------------------------------------------------------------
ai-classify-batch  [suffix: classified_batch_analysis_result]
--------------------------------------------------------------
概要:
  ai-classify と同じ分類タスクを、Anthropic Message Batches API
  （非同期・トークン単価50%引き、結果取得まで数分〜最大24時間）で行う版。
  プロキシ経由では動かない可能性が高く、本物の ANTHROPIC_API_KEY が必要。
  anthropicパッケージ未インストール時は、このサブコマンドだけがエラーで
  止まり、他のサブコマンドには影響しない。

事前準備:
  pip install anthropic
  export ANTHROPIC_API_KEY=sk-ant-...

実行例:
  python3 main.py ai-classify-batch input.csv
  python3 main.py ai-classify-batch input.csv --batch-size 30


--------------------------------------------------------------
ai-retry  [suffix: classified_retry_analysis_result]
--------------------------------------------------------------
概要:
  ai-classify の出力CSVのうち、"ai_classification" が "others" になっている
  行だけを対象にAIで再分類し、その列だけを更新した別CSVを出力する。
  分類ロジックは ai-classify と同じ lib/ai_classify.py の classify_all を
  そのまま再利用する（プロンプト修正・個別再試行フォールバックの改善もそのまま反映される）。

実行例:
  python3 main.py ai-retry classified.csv
  python3 main.py ai-retry classified.csv --max-batches 3   # 動作確認用


--------------------------------------------------------------
count-classifications  [suffix: classification_count_analysis_result]
--------------------------------------------------------------
概要:
  ai-classify（または ai-retry）の出力CSVにある "ai_classification" 列を
  件数集計する。
  出力CSV列: ai_classification, count, ratio
  （lib/classification_common.py のカテゴリ順で出力、想定外ラベルは件数降順で末尾に追加）

実行例:
  python3 main.py count-classifications classified.csv


--------------------------------------------------------------
analyze  [suffix: trend_top_queries_result / trend_daily_category_result / trend_column_usage_result / trend_long_tail_result / trend_report(html)]
--------------------------------------------------------------
概要:
  ai-classify（または ai-retry）の出力CSV（"ai_classification" 列付き）を
  対象に、クエリ傾向を4観点で分析する。AIは呼ばない（分類済みCSVの集計のみ）。

  A. カテゴリ別頻出クエリ（各カテゴリ上位N件。--top-n で指定、デフォルト20）
  B. 日別のカテゴリ推移（datetime列の日付部分でグループ化。折れ線グラフ＋
     行=ai_classification・列=dateのマトリクス表、セルは count(ratio%) 形式）
  C. カテゴリ×列指定率クロス集計（bbox/proximity/near の指定率をカテゴリ別に集計）
  D. ロングテール分布（queryごとの総出現回数を 1000+/500-999/100-499/10-99/2-9/1
     の6バケットに分け、各バケットが総検索ボリュームの何%を占めるかを円グラフで
     表示。全体＋カテゴリ別、計8枚。「何回も検索されるqueryだけが重要とは限らない
     （低頻度queryの集合が無視できないボリュームを持つ場合がある）」を可視化する狙い）

  1回の実行でCSV4種（Bの出力CSVはdate,ai_classification,count,ratioの
  ロングフォーマット、Dはscope,bucket,unique_query_count,total_count,volume_pct）
  ＋HTMLレポート1種（同一タイムスタンプ）を local_output/ に出力する。
  HTMLレポートはCSVと同じ内容をグラフ・テーブル付きでまとめたもの
  （ブラウザでそのまま開けるスタンドアロンファイル、英語表記、ライト/ダークモード対応。
  query・カテゴリ名などデータ由来の値は元の言語のまま）。

実行例:
  python3 main.py analyze classified.csv
  python3 main.py analyze classified.csv --top-n 30


--------------------------------------------------------------
analyze-ai  [suffix: trend_top_queries_result / trend_daily_category_result / trend_column_usage_result / trend_long_tail_result / trend_report_ai(html)]
--------------------------------------------------------------
概要:
  analyze と同じA/B/C/D集計を行った上で、その集計結果をもとにLLM（Claude Sonnet 5、
  プロキシ経由）にクエリ傾向のコメンタリーを書かせ、HTMLレポート上部に追加する版。
  CSV4種の内容・出力先はanalyzeと全く同じ（HTMLだけ suffix が trend_report_ai になる）。

  鉄則: AIに渡すのは analyze が計算する集計結果（カテゴリ別頻出クエリ上位N件・
  日別カテゴリ件数・列指定率。ロングテール分布は現状AIコメンタリーの入力には
  含めていない）だけで、入力CSVの生データ（行そのもの・query全件）は一切AIに
  渡さない。集計データの組み立ては lib/ai_analyze.py の build_summary_payload を
  参照。AI呼び出しに失敗した場合はコメンタリーなしでレポートを出力する
  （処理全体は止まらない）。

実行例:
  python3 main.py analyze-ai classified.csv
  python3 main.py analyze-ai classified.csv --top-n 30


--------------------------------------------------------------
想定の処理フロー（一例）
--------------------------------------------------------------
1. python3 main.py dedup input.csv                        で重複除去（元フォーマット保持）
2. python3 main.py ai-classify <dedupの出力>.csv           でAI分類（ai_classification列を追加）
3. python3 main.py count-classifications <ai-classifyの出力>.csv  で分類結果の件数・割合を確認
4. othersが多ければ python3 main.py ai-retry <ai-classifyの出力>.csv で再分類
   （必要なら lib/classification_common.py のプロンプトを見直してから）
5. python3 main.py analyze <最終的な分類済みCSV>.csv        でクエリ傾向を分析（HTMLレポート込み）
