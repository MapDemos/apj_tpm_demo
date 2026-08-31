tools/data_cleaning/ — CSVクレンジング・AI分類・傾向分析CLI
============================

想定入力CSVの列（共通）:
"endpoint","query","bbox","proximity","types","poi_category",
"poi_category_exclusions","result_limit","language","country",
"near","navigation_profile","datetime"

全機能は main.py の1本のCLIにサブコマンドとしてまとまっている。
サブコマンド一覧: dedup / add-query-count / count-column / ai-classify /
ai-retry / analyze

    python3 main.py <subcommand> input.csv [オプション]
    python3 main.py <subcommand> --help   # サブコマンドごとの詳細

列を追加するサブコマンド（dedup / add-query-count の "same_query_count"、
ai-classify の "ai_classification"）は、入力に既に同名の列がある場合
（=一度実行済みのCSVを誤って再度渡した場合）、上書きせず "same_query_count_2"
のように連番を振って追加する（lib/column_utils.py の unique_column_name）。

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
count-column  [suffix: count_analysis_result / --column ai_classification 時は classification_count_analysis_result]
--------------------------------------------------------------
概要:
  指定した列（--column、デフォルト "query"）の値が全体で何回出現するかを、
  行の近さに関係なくカウントする（旧 count-queries / count-classifications を統合。
  対象列が違うだけでロジックはほぼ同じだったため1コマンドにまとめた）。
  出力CSV列: <列名>, count, ratio

  --column ai_classification を指定した場合（ai-classify/ai-retryの出力を
  対象にする想定）のみ、lib/classification_common.py のカテゴリ順（想定外の
  ラベルは件数降順で末尾）に並べる。それ以外の列はcountの降順、同数なら初出順。

実行例:
  python3 main.py count-column input.csv                          # queryを集計（デフォルト）
  python3 main.py count-column classified.csv --column ai_classification


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

  モデルはHaikuファミリー固定（--model引数は廃止）。2026-08-30、固定モデルID
  文字列でなく、実行のたびにModels APIで最新版を自動選択するように変更した
  （classification_common.resolve_model()。ネットワークエラー等で解決できない
  場合はCLASSIFY_MODEL/ANALYZE_MODELの固定値にフォールバックする）。

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
  python3 main.py ai-classify input.csv --batch-size 1000 --workers 8
  python3 main.py ai-classify input.csv --max-batches 3   # 動作確認用に件数を絞る
  python3 main.py ai-classify input.csv --no-batch-api    # 同期・即時（--sync-batch-size使用）
  python3 main.py ai-classify input.csv --batch-api --token sk-ant-...

  --batch-size（デフォルト1000）は--batch-api使用時、--sync-batch-size
  （デフォルト300）は--no-batch-api時に、それぞれ1回のAPI呼び出しに含める
  クエリ件数として使う（2026-08-30、設定を分離。project memory参照:
  --batch-api使用時は非同期ジョブ登録のため非ストリーミングSDKのmax_tokens
  ガード対象外で300超も指定可能、不使用時は全呼び出しが同期のため300前後が
  実質上限）。


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
analyze  [suffix: trend_daily_volume_result / trend_hourly_volume_result / trend_proximity_prefecture_result / trend_top_queries_result / trend_daily_category_result / trend_column_usage_result / trend_long_tail_result / trend_report(html) または --with-ai-commentary指定時は trend_report_ai(html)]
--------------------------------------------------------------
概要:
  ai-classify（または ai-retry）の出力CSV（"ai_classification" 列付き）を
  対象に、クエリ傾向を7観点で分析する。デフォルトではAIは呼ばない
  （分類済みCSVの集計のみ）。

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

  --with-ai-commentary を付けると、上記の集計結果をもとにLLM（本物のAnthropic API、
  モデルはSonnet固定・--model引数は廃止）にクエリ傾向の
  コメンタリーを書かせ、レポートに追加する（HTML以外のCSV7種の内容・出力先は
  付けない場合と全く同じ。HTMLのsuffixだけ trend_report_ai になる）。
  2026-08-25、プロキシ経由の呼び出しを廃止し、本物の ANTHROPIC_API_KEY か
  --token での上書きが必要な方式に変更した（ai-classify/ai-retryの --batch-api
  と同様、anthropicパッケージが未インストールでも--with-ai-commentary指定時は
  main.pyが自動でtools/data_cleaning/.venv/を作成しanthropicをインストールする）。

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

事前準備（--with-ai-commentary使用時のみ）:
  export ANTHROPIC_API_KEY=sk-ant-...   （または --token sk-ant-... で上書き）
  ※anthropicパッケージ自体は初回実行時にmain.pyが自動でインストールするので不要

実行例:
  python3 main.py analyze classified.csv
  python3 main.py analyze classified.csv --top-n 30
  python3 main.py analyze classified.csv --with-ai-commentary
  python3 main.py analyze classified.csv --top-n 30 --with-ai-commentary
  python3 main.py analyze classified.csv --with-ai-commentary --token sk-ant-...


--------------------------------------------------------------
想定の処理フロー（一例）
--------------------------------------------------------------
1. python3 main.py dedup input.csv                        で重複除去（元フォーマット保持）
2. python3 main.py ai-classify <dedupの出力>.csv           でAI分類（ai_classification列を追加）
3. python3 main.py count-column <ai-classifyの出力>.csv --column ai_classification  で分類結果の件数・割合を確認
4. othersが多ければ python3 main.py ai-retry <ai-classifyの出力>.csv で再分類
   （必要なら lib/classification_common.py のプロンプトを見直してから）
5. python3 main.py analyze <最終的な分類済みCSV>.csv        でクエリ傾向を分析（HTMLレポート込み）


--------------------------------------------------------------
GUI版（同僚への配布用 .app）
--------------------------------------------------------------
概要:
  gui_app.py は上記の全サブコマンド（dedup 〜 analyze）をTkinterのGUIから
  実行できるようにしたラッパー。ロジックはmain.pyのcmd_*関数をそのまま呼ぶだけで、
  分類ロジック・出力ファイル名などCLI版と完全に同じ。タブ名は「🧹 クエリの
  クレンジング」「📊 クエリの分析」。

  ファイルを開くと、列名を大文字小文字問わず候補リスト（query, q, クエリ,
  検索キーワード, キーワード, search keyword 等）と照合し、クエリ列らしき
  候補を情報表示するだけの確認ダイアログを出す（自動リネーム等は行わない。
  本ツールは列名「query」を前提に処理するため、表記ゆれのあるCSVを誤って
  そのまま処理してしまう事故を防ぐための注意喚起）。

  出力先は各タブ（クレンジング/分析）ごとに独立して選択可能（出力先パスの
  右横にある「📂」アイコンボタンでフォルダ選択ダイアログを開く。開く/変更を
  別ボタンにせず1つに統合しており、現在のフォルダから始まるダイアログで
  そのまま選び直せば変更になる）。初期値はCLI版の既定と同じ
  ~/Documents/AthenaCSVTool/local_output/（.appとしてビルド＝frozen判定された
  場合のみ切り替わる。python3 gui_app.py で直接実行した場合はCLI版と同じ
  data_cleaning/local_output/。判定ロジックは lib/output_utils.py 参照）。
  実行直前にlib/output_utils.OUTPUT_DIRをそのタブの選択フォルダへ上書きしてから
  main.pyのcmd_*関数を呼ぶことで、CLI側のロジックには一切手を入れずに
  出力先を切り替えている。

  AIのANTHROPIC_API_KEYは、ヘッダー右端の「⚙ 設定」ボタンから開くダイアログに
  一元化されている（ai-classifyの--batch-api、analyzeの--with-ai-commentary
  のいずれも、実行時にこの1箇所のキーを参照する。非persistent、ディスクには
  保存しない）。Batches API使用の有無・バッチサイズ（Batches API使用時/不使用時
  で別設定）・並行数も同じ⚙設定ダイアログに集約されている（2026-08-30、
  Batches API使用トグルを実行設定欄からここに移動。project memory参照。
  デフォルトはBatches API使用ON・バッチサイズ1000（使用時）/300（不使用時）・
  並行数8）。

  ai-classifyの「実行」ボタンを押すと、内部で(1)周辺クエリの重複排除
  （cmd_dedup、CSVの行自体は削除しない）→(2)query列だけを見たユニーク数
  カウント（AIに送信する対象を決める重複排除）を自動実行し、(2)の結果と
  設定中のバッチサイズ・Batches API使用有無から実績ベースの分析式でトークン数・
  コスト（USD/JPY）を計算し、モーダルダイアログに表示する（2026-08-30、
  「📊 少量実行して見積」ボタン＝実APIを実際に叩くサンプル実行方式を廃止。
  project memory参照。新方式は無料・即時）。モーダル内の「実行」ボタンを押すと
  実際の分類処理を開始する（キャンセルすれば何も実行されない）。

  進捗バーの下には、現在どのフェーズ（レベル1分類→レベル2分類(POI判定)→
  レベル3分類→カテゴリ再判定）にいるかと進捗率(%)を表示する（2026-08-30、残り時間の目安から
  置き換え。project memory参照。ログの「done=N/M」「N/Mバッチ完了」等の行を
  解析する。個別/グループリトライで母数が変わると%も出し直すため、進捗が
  後退することもある）。

  分類完了時（レポート生成も含む）には、モーダルダイアログに加えてmacOS
  通知センター経由の通知も出す（2026-08-30新設。Dockアイコンへのバッジ付与は
  PySide6標準機能では実現できないため見送り、通知センターのみ）。

  analyzeの --with-ai-commentary は、GUIでは「AIコメンタリー」チェックボックス
  （デフォルトOFF）で有効化する（モデルはSonnet固定）。
  APIキーは上記のヘッダー⚙設定を使用する。

ビルド方法（配布する側が実行）:
  ./build_gui.sh
  → .build_venv/ を自動作成してpyinstaller・anthropicパッケージをインストールし、
    dist/Octopus.app を生成する。
  → colleagueには dist/Octopus.app をzip等でそのまま渡せばよい
    （colleague側にPython/pipのインストールは不要）。

配布時の注意:
  - 未署名ビルドのため、colleagueが初回起動する際にGatekeeperの警告
    （"開発元を確認できないため開けません"）が出る。Finderで.appを右クリック→
    「開く」を選ぶと起動できる。正式に警告を消すにはApple Developer ID証明書での
    コード署名＋notarizationが別途必要（今回は未対応）。
  - build/・dist/・.build_venv/・*.spec はビルドごとに生成される一時物なので
    .gitignore済み（コミット不要）。配布時はdist/配下の.appだけを渡す。
