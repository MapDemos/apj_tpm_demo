tools/data_cleaning/ — CSVクレンジング・AI分類・傾向分析CLI
============================

想定入力CSVの列（共通）:
"endpoint","query","bbox","proximity","types","poi_category",
"poi_category_exclusions","result_limit","language","country",
"near","navigation_profile","datetime"

全機能は main.py の1本のCLIにサブコマンドとしてまとまっている。
サブコマンド一覧: dedup / add-query-count / count-queries / ai-classify /
ai-retry / count-classifications / analyze / analyze-ai

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
  LLMを使って "query" 列を分類し、"ai_classification" 列を追加した
  CSVを出力する。"query" 列のユニークな値だけを抽出してLLMに送り、
  結果を {query: label} の辞書で全行にマッピングする（同じqueryが
  何度出現してもAI呼び出しは1回で済み、同一クエリが別バッチに分かれて
  別々の判定結果になる不整合も防げる。lib/ai_classify.py の
  classify_unique を参照）。バッチ分割＋並行処理で、1バッチがまるごと
  失敗した場合は中身を1件ずつ個別に再試行し、それでも失敗した行だけ
  others にフォールバックする。

  --model haiku|sonnet でモデルを切り替えられる（デフォルト haiku）。

  --batch-api を付けると、通常のプロキシ経由リクエストの代わりに
  Anthropic Message Batches API（非同期・トークン単価50%引き、結果取得
  まで数分〜最大24時間）を使う。プロキシ経由では動かない可能性が高く、
  本物の ANTHROPIC_API_KEY か --token での上書きが必要。anthropicパッケージが
  未インストールでも、--batch-api指定時はmain.pyが自動で
  tools/data_cleaning/.venv/ を作成しanthropicをインストール、そのvenvの
  pythonで自分自身を再実行する（Homebrew管理下のpython3は
  externally-managed-environmentのため直接pip installできないための対応。
  .venv/はgitignore対象）。通常モードには影響しない。

  分類カテゴリの定義は lib/classification_common.py を参照:
  1=poi, 2=poi_brand, 3=poi_category, 4=address,
  5=unsupported_query_location_intent, 6=broken_query, 7=others

事前準備（--batch-api使用時のみ）:
  export ANTHROPIC_API_KEY=sk-ant-...   （または --token sk-ant-... で上書き）
  ※anthropicパッケージ自体は初回実行時にmain.pyが自動でインストールするので不要

実行例:
  python3 main.py ai-classify input.csv
  python3 main.py ai-classify input.csv --model sonnet
  python3 main.py ai-classify input.csv --batch-size 30 --workers 8
  python3 main.py ai-classify input.csv --max-batches 3   # 動作確認用に件数を絞る
  python3 main.py ai-classify input.csv --batch-api
  python3 main.py ai-classify input.csv --batch-api --token sk-ant-...


--------------------------------------------------------------
ai-retry  [suffix: classified_retry_analysis_result]
--------------------------------------------------------------
概要:
  ai-classify の出力CSVのうち、"ai_classification" が指定カテゴリ
  （--category、デフォルト others）になっている行だけを対象にAIで
  再分類し、その列だけを更新した別CSVを出力する。分類ロジックは
  ai-classify と同じ lib/ai_classify.py の classify_unique をそのまま
  再利用する（ユニーククエリ抽出・プロンプト修正・個別再試行フォールバック
  もそのまま反映される）。--model も ai-classify と同様に指定可能。

  --batch-api も ai-classify と同様に指定可能。通常のプロキシ経由リクエスト
  の代わりに Anthropic Message Batches API（非同期・トークン単価50%引き、
  結果取得まで数分〜最大24時間）を使う。プロキシ経由では動かない可能性が
  高く、本物の ANTHROPIC_API_KEY か --token での上書きが必要。anthropicパッケージの
  自動インストールについてはai-classifyの説明を参照（挙動は共通）。

事前準備（--batch-api使用時のみ）:
  export ANTHROPIC_API_KEY=sk-ant-...   （または --token sk-ant-... で上書き）
  ※anthropicパッケージ自体は初回実行時にmain.pyが自動でインストールするので不要

実行例:
  python3 main.py ai-retry classified.csv
  python3 main.py ai-retry classified.csv --category poi_brand
  python3 main.py ai-retry classified.csv --model sonnet
  python3 main.py ai-retry classified.csv --max-batches 3   # 動作確認用
  python3 main.py ai-retry classified.csv --batch-api
  python3 main.py ai-retry classified.csv --batch-api --token sk-ant-...


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
analyze  [suffix: trend_daily_volume_result / trend_hourly_volume_result / trend_proximity_prefecture_result / trend_top_queries_result / trend_daily_category_result / trend_column_usage_result / trend_long_tail_result / trend_report(html)]
--------------------------------------------------------------
概要:
  ai-classify（または ai-retry）の出力CSV（"ai_classification" 列付き）を
  対象に、クエリ傾向を7観点で分析する。AIは呼ばない（分類済みCSVの集計のみ）。

  A. 日別クエリ量（全カテゴリ合計。折れ線グラフ）
  B. 時間帯別クエリ量（全日付をまとめて0〜23時の時間帯別に集計。棒グラフ。
     元データのdatetime列はUTC表記のため、JSTに変換してから集計する。
     見出し・CSV列名（hour_jst）にJSTである旨を明記）
  C. 都道府県別proximity分布（proximity座標を最寄りの都道府県代表地点に
     スナップして集計。代表地点は lib/jp_prefectures.py にハードコードした
     47都道府県庁所在地の概算緯度経度＋ローマ字表記。外部API呼び出しなし。
     表示順は件数順ではなく北海道→沖縄の標準的な都道府県順。proximity未指定・
     パース失敗の行は「(no proximity)」として別枠集計）
  D. カテゴリ別頻出クエリ（各カテゴリ上位N件。--top-n で指定、デフォルト20）
  E. 日別のカテゴリ推移（datetime列の日付部分でグループ化。折れ線グラフ＋
     行=ai_classification・列=dateのマトリクス表、セルは count(ratio%) 形式）
  F. パラメータ利用率（bbox/proximity/poi_category/poi_category_exclusions/
     near/navigation_profileの6パラメータが指定されている行の割合。カテゴリ別
     には分けない、全体を通した単純な利用率）
  G. ロングテール分布（queryごとの総出現回数を 1000+/500-999/100-499/10-99/2-9/1
     の6バケットに分け、各バケットが総検索ボリュームの何%を占めるかを円グラフで
     表示。全体＋カテゴリ別、計8枚。「何回も検索されるqueryだけが重要とは限らない
     （低頻度queryの集合が無視できないボリュームを持つ場合がある）」を可視化する狙い）

  1回の実行でCSV7種（Aはdate,count、Bはhour,count、Cはprefecture,count,
  rate_pct、Eはdate,ai_classification,count,ratioのロングフォーマット、
  Fはparameter,count,total,rate_pct、Gはscope,bucket,unique_query_count,
  total_count,volume_pct）＋HTMLレポート1種（同一タイムスタンプ）を
  local_output/ に出力する。
  HTMLレポートはCSVと同じ内容をグラフ・テーブル付きでまとめたもの
  （ブラウザでそのまま開けるスタンドアロンファイル、英語表記、ライト/ダークモード対応。
  query・カテゴリ名・都道府県名などデータ由来の値は元の言語のまま）。

実行例:
  python3 main.py analyze classified.csv
  python3 main.py analyze classified.csv --top-n 30


--------------------------------------------------------------
analyze-ai  [suffix: trend_daily_volume_result / trend_hourly_volume_result / trend_proximity_prefecture_result / trend_top_queries_result / trend_daily_category_result / trend_column_usage_result / trend_long_tail_result / trend_report_ai(html)]
--------------------------------------------------------------
概要:
  analyze と同じA〜G集計を行った上で、その集計結果をもとにLLM（Claude Sonnet 5、
  プロキシ経由）にクエリ傾向のコメンタリーを書かせる版。CSV7種の内容・出力先は
  analyzeと全く同じ（HTMLだけ suffix が trend_report_ai になる）。

  AIコメンタリーは2種類:
  - レポート冒頭の全体サマリー（2〜3行の短い概況、overview）
  - D〜G各セクションに埋め込む「AI Insight」枠（Dはセクション全体に1つ＋
    カテゴリごとに1つずつ、E/F/Gはそれぞれセクション全体に1つ）
    ※新設のA〜C（日別/時間帯別クエリ量・都道府県別proximity分布）には
    現状AI Insightを付けていない
  いずれも平易・簡潔な英語で書くようプロンプトで指示している。

  鉄則: AIに渡すのは analyze が計算する集計結果（カテゴリ別頻出クエリ上位N件・
  日別カテゴリ件数・列指定率・ロングテール分布）だけで、入力CSVの生データ
  （行そのもの・query全件）は一切AIに渡さない。集計データの組み立ては
  lib/ai_analyze.py の build_summary_payload を参照。AI呼び出しに失敗した場合は
  コメンタリー・AI Insightなしでレポートを出力する（処理全体は止まらない）。

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


--------------------------------------------------------------
GUI版（同僚への配布用 .app）
--------------------------------------------------------------
概要:
  gui_app.py は上記の全サブコマンド（dedup 〜 analyze-ai）をTkinterのGUIから
  実行できるようにしたラッパー。ロジックはmain.pyのcmd_*関数をそのまま呼ぶだけで、
  分類ロジック・出力ファイル名などCLI版と完全に同じ。

  出力先はCLI版と異なり、常に ~/Documents/AthenaCSVTool/local_output/
  （.appとしてビルド＝frozen判定された場合のみ切り替わる。python3 gui_app.py で
  直接実行した場合はCLI版と同じ data_cleaning/local_output/ に出る。
  判定ロジックは lib/output_utils.py 参照）。

  ai-classify/ai-retryの --batch-api は、GUIでは「Batches API使用」チェックボックス
  ＋APIキー入力欄で有効化する。要colleague自身のANTHROPIC_API_KEY・課金は各自持ち。
  通常のプロキシ経由（デフォルト）はAPIキー不要。

ビルド方法（配布する側が実行）:
  ./build_gui.sh
  → .build_venv/ を自動作成してpyinstaller・anthropicパッケージをインストールし、
    dist/Athena CSV Tool.app を生成する。
  → colleagueには dist/Athena CSV Tool.app をzip等でそのまま渡せばよい
    （colleague側にPython/pipのインストールは不要）。

配布時の注意:
  - 未署名ビルドのため、colleagueが初回起動する際にGatekeeperの警告
    （"開発元を確認できないため開けません"）が出る。Finderで.appを右クリック→
    「開く」を選ぶと起動できる。正式に警告を消すにはApple Developer ID証明書での
    コード署名＋notarizationが別途必要（今回は未対応）。
  - build/・dist/・.build_venv/・*.spec はビルドごとに生成される一時物なので
    .gitignore済み（コミット不要）。配布時はdist/配下の.appだけを渡す。
