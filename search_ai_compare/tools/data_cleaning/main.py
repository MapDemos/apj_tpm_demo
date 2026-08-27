#!/usr/bin/env python3
"""
data_cleaning/ のCSVクレンジング・AI分類・傾向分析を1つにまとめたCLI。

サブコマンド:
  dedup                  重複除去（--columns-onlyでquery列のみ抽出版。
                          same_query_count列を自動付与）
  add-query-count        same_query_count列だけを付与する（重複除去はしない、プログラム的カウントのみ、AI不使用）
  count-column           指定した列の出現回数を集計する（--columnでquery/ai_classification等を指定、デフォルトquery）
  ai-classify             AI分類（本物のAnthropic APIを直接叩く。要ANTHROPIC_API_KEY
                          または--token。同期・並行処理がデフォルトで、--batch-apiで
                          非同期のBatches API版（50%割引・ジョブ待ちあり）に切り替え可）。
                          --filter-column/--filter-op/--filter-valueで対象行を
                          任意の列×演算子×値で絞り込める（未指定なら全行対象）。
                          既に分類済み(ai_classification列あり)のファイルに絞り込み
                          指定で実行すると、マッチした行だけ既存の3列を上書きする
                          （旧ai-retryサブコマンドはこの機能に統合し廃止）
  analyze                クエリ傾向分析（HTMLレポート込み。--with-ai-commentaryで本物のAnthropic API
                          （要ANTHROPIC_API_KEYまたは--token、--modelでモデル選択可）によるAI要約を追加）

各サブコマンドの詳細は `python3 main.py <subcommand> --help` を参照。
出力は全サブコマンド共通で local_output/ 配下に自動生成される
（<入力ファイル名>_<suffix>_<タイムスタンプ>.csv、詳細は lib/output_utils.py）。
"""

import argparse
import csv
import os
import subprocess
import sys
import time

from lib import ai_analyze as ai_analyze_lib
from lib import ai_classify as ai_classify_lib
from lib import analyze_trends as analyze_trends_lib
from lib import classification_common as classification_common_lib
from lib import column_utils as column_utils_lib
from lib import count_column as count_column_lib
from lib import dedup as dedup_lib
from lib import query_count_column as query_count_column_lib
from lib import row_filter as row_filter_lib
from lib.output_utils import current_timestamp, make_output_path

# anthropicパッケージのバージョンpin。1.0.0でMessages.create()からtemperature
# 引数が削除されるなど破壊的変更があり、無指定でpip installすると
# ビルド/実行のたびに違うバージョンが入ってしまう（build_gui.shも同じ値を
# 使うこと。2026-08-27発覚のtemperature TypeErrorバグを踏まえて追加）。
ANTHROPIC_PIN = "anthropic>=0.122,<1"


def cmd_dedup(args: argparse.Namespace) -> str:
    fieldnames, rows = dedup_lib.extract_rows(args.input_csv)
    before = len(rows)
    # same_query_count は重複除去前の全行に対して数える
    # （除去後は近傍の重複しか見えなくなるため、除去前の総出現回数を使う）
    counts = query_count_column_lib.compute_counts(rows)

    if args.columns_only:
        target_rows = [{"query": r["query"]} for r in rows]
        count_column = query_count_column_lib.COLUMN_NAME
        out_fieldnames = ["query", count_column]
        suffix = "cleaning_queryonly"
    else:
        target_rows = rows
        # 既にsame_query_count列が付いた入力（=一度clean/count済みのCSVを
        # 誤って再度渡した場合）を上書きしないよう、衝突すれば_2,_3...にする。
        count_column = column_utils_lib.unique_column_name(fieldnames, query_count_column_lib.COLUMN_NAME)
        out_fieldnames = fieldnames + [count_column]
        suffix = "cleaning"

    cleaned = dedup_lib.dedupe_within_window(target_rows, key=lambda r: r["query"])
    query_count_column_lib.annotate(cleaned, counts, column=count_column)
    after = len(cleaned)

    output_path = make_output_path(args.input_csv, suffix)
    dedup_lib.write_rows(output_path, out_fieldnames, cleaned)

    print(f"入力行数: {before}")
    print(f"重複除去後の行数: {after}（{before - after}件削除）")
    if count_column != query_count_column_lib.COLUMN_NAME:
        print(f"注意: 入力に既に \"{query_count_column_lib.COLUMN_NAME}\" 列があったため \"{count_column}\" 列として追加しました")
    print(f"出力先: {output_path}")
    return output_path


def cmd_add_query_count(args: argparse.Namespace) -> None:
    fieldnames, rows = query_count_column_lib.read_rows(args.input_csv)
    counts = query_count_column_lib.compute_counts(rows)
    # 既にsame_query_count列が付いた入力（=一度実行済みのCSVを誤って再度渡した場合）
    # を上書きしないよう、衝突すれば_2,_3...にする。
    count_column = column_utils_lib.unique_column_name(fieldnames, query_count_column_lib.COLUMN_NAME)
    query_count_column_lib.annotate(rows, counts, column=count_column)
    out_fieldnames = fieldnames + [count_column]

    output_path = make_output_path(args.input_csv, "query_count_annotated")
    query_count_column_lib.write_rows(output_path, out_fieldnames, rows)

    print(f"総行数: {len(rows)}")
    print(f"ユニークなquery数: {len(counts)}")
    if count_column != query_count_column_lib.COLUMN_NAME:
        print(f"注意: 入力に既に \"{query_count_column_lib.COLUMN_NAME}\" 列があったため \"{count_column}\" 列として追加しました")
    print(f"出力先: {output_path}")


def cmd_count_column(args: argparse.Namespace) -> None:
    column = args.column
    values = count_column_lib.extract_values(args.input_csv, column)
    items = count_column_lib.count_values(values, column)
    total = len(values)

    suffix = "classification_count_analysis_result" if column == "ai_classification" else "count_analysis_result"
    output_path = make_output_path(args.input_csv, suffix)
    count_column_lib.write_counts(output_path, column, items, total)

    print(f"総行数: {total}")
    print(f"ユニークな{column}数: {len(items)}")
    if column == "ai_classification":
        for label, count in items:
            ratio = f"{count / total * 100:.1f}%" if total else "0.0%"
            print(f"  {label}: {count}件（{ratio}）")
    else:
        duplicated = sum(1 for _, c in items if c > 1)
        print(f"2回以上出現する{column}数: {duplicated}")
    print(f"出力先: {output_path}")


def cmd_ai_classify(args: argparse.Namespace) -> None:
    """query列を分類する。--filter-column/--filter-op/--filter-valueで対象行を
    任意の列×演算子×値で絞り込める（未指定なら全行が対象、旧来のai-classify相当）。

    絞り込みを指定し、かつ入力に既にai_classification/_2/_3列が揃っている場合
    （＝一度分類済みのファイルへの再実行）は、マッチした行だけその3列を上書きし、
    他の行は保持する（旧ai-retryサブコマンド相当。対象列・演算子を汎用化して統合し、
    ai-retryは廃止した）。
    絞り込みを指定したが、その3列がまだ無い場合（＝初回実行で対象を絞りたい場合）は、
    3列を新規作成し、マッチしなかった行は空文字のまま（未分類）にする。
    絞り込み無しで実行し、かつ既に3列が揃っている場合は、旧来通り列名衝突を避けて
    新規に_2,_3...列を作る（既存の分類結果を破壊しない）。"""
    output_path = make_output_path(args.input_csv, "classified_analysis_result")

    with open(args.input_csv, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        if fieldnames is None or "query" not in fieldnames:
            raise ValueError('入力CSVに "query" 列が見つかりません')
        rows = list(reader)

    filter_column = args.filter_column or None
    if filter_column and filter_column not in fieldnames:
        raise ValueError(f'--filter-column で指定された列 "{filter_column}" が入力CSVに見つかりません')
    if filter_column and (not args.filter_op or args.filter_value is None):
        raise ValueError("--filter-column を指定する場合は --filter-op と --filter-value も指定してください")

    target_indices = row_filter_lib.filter_row_indices(rows, filter_column, args.filter_op, args.filter_value)

    if filter_column and not target_indices:
        print(f'絞り込み条件（{filter_column} {args.filter_op} {args.filter_value!r}）に一致する行が見つかりませんでした。処理対象なし。')
        with open(output_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
        print(f"出力先: {output_path}（入力をそのままコピー）")
        return

    if args.max_batches is not None:
        target_indices = target_indices[: args.max_batches * args.batch_size]

    target_queries = [rows[i].get("query", "") for i in target_indices]
    unique_count = len(set(target_queries))

    level12_model, level3_model = classification_common_lib.MODEL_PRESETS[args.model]

    if filter_column:
        print(
            f"絞り込み対象（{filter_column} {args.filter_op} {args.filter_value!r}）: "
            f"{len(target_indices)}件（全{len(rows)}件中、うちユニークなquery: {unique_count}件をAIに送信）",
            file=sys.stderr,
        )

    if args.resume_batch_job and not args.batch_api:
        raise ValueError("--resume-batch-job は --batch-api 指定時のみ使えます")

    t0 = time.time()
    failed_ranges = None
    if args.batch_api:
        # Anthropic Message Batches API版。トークン単価が通常の50%になる代わりに
        # 非同期ジョブ(数分〜最大24時間)になる。プロキシ経由では動かない可能性が
        # 高いため、本物のANTHROPIC_API_KEY（--tokenで上書き可）が必要。
        try:
            from lib import ai_classify_batch as ai_classify_batch_lib
        except ImportError as e:
            print(f"エラー: anthropicパッケージが必要です（pip install anthropic）: {e}", file=sys.stderr)
            sys.exit(1)

        mapping, total_in, total_out, failed_ranges, failed_queries = ai_classify_batch_lib.classify_unique(
            target_queries, args.batch_size, level12_model, level3_model, api_key=args.token,
            resume_state_path=args.resume_batch_job,
        )
    else:
        # 2026-08-27、プロキシ（Lambda URL）経由の呼び出しを廃止し、本物の
        # Anthropic APIを直接叩く同期呼び出しに変更（詳細はai_classify.pyの
        # モジュールdocstring参照）。--batch-apiと同じくANTHROPIC_API_KEYが必要。
        try:
            mapping, total_in, total_out, failed_queries = ai_classify_lib.classify_unique(
                target_queries, args.batch_size, args.workers, level12_model, level3_model, api_key=args.token,
            )
        except ImportError as e:
            print(f"エラー: anthropicパッケージが必要です（pip install anthropic）: {e}", file=sys.stderr)
            sys.exit(1)
    elapsed = time.time() - t0

    base_columns = ["ai_classification", "ai_classification_2", "ai_classification_3"]
    has_existing_columns = all(c in fieldnames for c in base_columns)

    skipped_due_to_failure = 0

    if filter_column and has_existing_columns:
        # 部分上書きモード（旧ai-retry相当）: マッチした行だけ既存3列を上書き、
        # 他の行・他の列はそのまま保持する。ただし、そのqueryの分類がAPI呼び出し失敗に
        # よるunknownフォールバックだった場合は、既存3列（前回までの正しい分類結果
        # かもしれない値）を破壊しないよう上書きをスキップする（モデルが本当に
        # 「unknown」と判定した場合は通常どおり上書きする）。
        c1_col, c2_col, c3_col = base_columns
        out_fieldnames = fieldnames
        for i in target_indices:
            query = rows[i].get("query", "")
            if query in failed_queries:
                skipped_due_to_failure += 1
                continue
            c1, c2, c3 = mapping[query]
            rows[i][c1_col], rows[i][c2_col], rows[i][c3_col] = c1, c2, c3
    else:
        # 全件モード、または絞り込みはあるが3列がまだ無い初回実行。
        # 既にai_classification列が付いた入力（=一度分類済みのCSVを誤って再度渡した場合）
        # を上書きしないよう、衝突すれば3列まとめて_2,_3...にする
        # （unique_column_nameを列ごとに個別適用すると、"ai_classification_2"という
        # 正規の列名自体を衝突回避後の名前と誤認識してしまうため、3列専用のヘルパーを使う）。
        c1_col, c2_col, c3_col = column_utils_lib.unique_column_names(fieldnames, base_columns)
        out_fieldnames = list(fieldnames) + [c1_col, c2_col, c3_col]
        for row in rows:
            row[c1_col], row[c2_col], row[c3_col] = "", "", ""
        for i in target_indices:
            c1, c2, c3 = mapping[rows[i].get("query", "")]
            rows[i][c1_col], rows[i][c2_col], rows[i][c3_col] = c1, c2, c3

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=out_fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f"\n処理件数: {len(target_indices)}（全{len(rows)}件中、うちユニークなquery: {unique_count}件をAIに送信）")
    print(f"モデル: {classification_common_lib.model_preset_label(args.model)}")
    if args.batch_api:
        print(f"失敗バッチ数（個別リトライに回した回数）: {failed_ranges}")
    if failed_queries:
        print(f"個別リトライでも分類に失敗したユニークquery数: {len(failed_queries)}件")
        if filter_column and has_existing_columns:
            print(f"  → 既存の分類結果を保持し上書きをスキップした行数: {skipped_due_to_failure}件")
    print(f"所要時間: {elapsed:.1f}秒")
    token_note = "（Batches APIのため通常の50%価格で課金）" if args.batch_api else ""
    print(f"input tokens合計 : {total_in}{token_note}")
    print(f"output tokens合計: {total_out}{token_note}")
    if c1_col != "ai_classification":
        print(f"注意: 入力に既に分類済み列があったため \"{c1_col}\"/\"{c2_col}\"/\"{c3_col}\" 列として追加しました")
    print(f"出力先: {output_path}")


def cmd_analyze(args: argparse.Namespace) -> None:
    fieldnames, rows = analyze_trends_lib.read_rows(args.input_csv)
    total_rows = len(rows)

    seen_categories = {row.get("ai_classification", "") for row in rows}
    order = analyze_trends_lib.category_order(seen_categories)

    top_queries = analyze_trends_lib.compute_top_queries(rows, args.top_n)
    daily = analyze_trends_lib.compute_daily_category(rows)
    usage = analyze_trends_lib.compute_column_usage(rows)
    long_tail = analyze_trends_lib.compute_long_tail_by_scope(rows, order)
    daily_volume = analyze_trends_lib.compute_daily_volume(rows)
    hourly_volume = analyze_trends_lib.compute_hourly_volume(rows)
    proximity_data = analyze_trends_lib.compute_proximity_by_prefecture(rows)
    classification_breakdown = analyze_trends_lib.compute_classification_breakdown(rows, order)
    poi_taxonomy_breakdown = analyze_trends_lib.compute_poi_taxonomy_breakdown(rows)
    address_structure_breakdown = analyze_trends_lib.compute_address_structure_breakdown(rows)

    ts = current_timestamp()
    top_queries_path = make_output_path(args.input_csv, "trend_top_queries_result", timestamp=ts)
    daily_path = make_output_path(args.input_csv, "trend_daily_category_result", timestamp=ts)
    usage_path = make_output_path(args.input_csv, "trend_column_usage_result", timestamp=ts)
    long_tail_path = make_output_path(args.input_csv, "trend_long_tail_result", timestamp=ts)
    daily_volume_path = make_output_path(args.input_csv, "trend_daily_volume_result", timestamp=ts)
    hourly_volume_path = make_output_path(args.input_csv, "trend_hourly_volume_result", timestamp=ts)
    proximity_path = make_output_path(args.input_csv, "trend_proximity_prefecture_result", timestamp=ts)

    analyze_trends_lib.write_top_queries_csv(top_queries_path, top_queries, order)
    analyze_trends_lib.write_daily_category_csv(daily_path, daily, order)
    analyze_trends_lib.write_column_usage_csv(usage_path, usage)
    analyze_trends_lib.write_long_tail_csv(long_tail_path, long_tail, order)
    analyze_trends_lib.write_daily_volume_csv(daily_volume_path, daily_volume)
    analyze_trends_lib.write_hourly_volume_csv(hourly_volume_path, hourly_volume)
    analyze_trends_lib.write_proximity_prefecture_csv(proximity_path, proximity_data)

    # --with-ai-commentary指定時のみ、集計結果(summary_payload)をAIに渡してコメンタリーを
    # 生成する。元CSVの生データ（行そのもの・query全件）は渡さない。
    ai_commentary = None
    ai_model = None
    if args.with_ai_commentary:
        summary_payload = ai_analyze_lib.build_summary_payload(order, top_queries, daily, usage, long_tail)
        ai_model = classification_common_lib.MODEL_CHOICES[args.model]
        try:
            ai_commentary = ai_analyze_lib.generate_commentary(summary_payload, model=ai_model, api_key=args.token)
        except Exception as e:
            print(f"警告: AIコメンタリー生成に失敗したため、コメンタリーなしでレポートを出力します: {e}", file=sys.stderr)
            ai_commentary = None

    report_suffix = "trend_report_ai" if args.with_ai_commentary else "trend_report"
    report_path = make_output_path(args.input_csv, report_suffix, timestamp=ts, ext="html")

    generated_at = f"{ts[:4]}-{ts[4:6]}-{ts[6:8]} {ts[9:11]}:{ts[11:13]}:{ts[13:15]}"
    html_report = analyze_trends_lib.render_html_report(
        args.input_csv, generated_at, total_rows, order, top_queries, daily, usage, args.top_n,
        daily_volume=daily_volume, hourly_volume=hourly_volume, proximity_data=proximity_data,
        long_tail=long_tail,
        ai_commentary=ai_commentary,
        classification_breakdown=classification_breakdown,
        poi_taxonomy_breakdown=poi_taxonomy_breakdown,
        address_structure_breakdown=address_structure_breakdown,
    )
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(html_report)

    print(f"総行数: {total_rows}")
    print(f"カテゴリ数: {len(order)}（{', '.join(order)}）")
    if args.with_ai_commentary:
        status = "生成成功" if ai_commentary else "生成失敗（レポートには含まれません）"
        print(f"AIコメンタリー: {status}（モデル: {args.model} / {ai_model}）")
    print("出力先:")
    print(f"  {top_queries_path}")
    print(f"  {daily_path}")
    print(f"  {usage_path}")
    print(f"  {long_tail_path}")
    print(f"  {daily_volume_path}")
    print(f"  {hourly_volume_path}")
    print(f"  {proximity_path}")
    report_label = "HTMLレポート（AIコメンタリー込み）" if ai_commentary else "HTMLレポート"
    print(f"  {report_path}  ← {report_label}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="main.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("dedup", help="重複除去（後ろ5行以内・最初の出現を正とする。same_query_count列を自動付与）")
    p.add_argument("input_csv")
    p.add_argument("--columns-only", action="store_true", help="query列のみ抽出して出力する（他の列は捨てる）")
    p.set_defaults(func=cmd_dedup)

    p = sub.add_parser(
        "add-query-count",
        help="重複除去はせず、query列の全体出現回数をsame_query_count列として全行に付与する（プログラム的カウント、AI不使用）",
    )
    p.add_argument("input_csv")
    p.set_defaults(func=cmd_add_query_count)

    p = sub.add_parser(
        "count-column",
        help="指定した列の出現回数を集計する（--columnで対象列を指定、デフォルトquery。"
        "ai_classification指定時はclassification_common.pyのカテゴリ順で出力）",
    )
    p.add_argument("input_csv")
    p.add_argument("--column", default="query", help="集計対象の列名（デフォルト: query。例: ai_classification）")
    p.set_defaults(func=cmd_count_column)

    p = sub.add_parser(
        "ai-classify",
        help="LLMでquery列を分類する（プロキシ経由・並行処理。--batch-apiでAnthropic Message Batches "
        "API版に切り替え可、要ANTHROPIC_API_KEYまたは--token）。--filter-column/--filter-op/"
        "--filter-valueで対象行を任意の列×演算子×値で絞り込める（未指定なら全行対象。既に分類済みの"
        "ファイルに絞り込み指定で実行すると、マッチした行だけ既存3列を上書きする＝旧ai-retry相当）",
    )
    p.add_argument("input_csv")
    p.add_argument(
        "--model",
        default="haiku+sonnet",
        choices=list(classification_common_lib.MODEL_PRESETS.keys()),
        help="分類に使うモデル構成（デフォルト: haiku+sonnet ＝ ai_classification/_2をHaiku・"
        "ai_classification_3をSonnetで判定。haiku/sonnetは両階層を同一モデルに統一する"
        "比較検証用の選択肢。--batch-api使用時も含め全プリセット指定可）",
    )
    p.add_argument(
        "--filter-column",
        default=None,
        help="対象行を絞り込む列名（未指定なら全行が対象）。--filter-op/--filter-valueと組で指定する",
    )
    p.add_argument(
        "--filter-op",
        default=None,
        choices=row_filter_lib.OPERATORS,
        help="絞り込みの演算子。=/!=は文字列の完全一致/不一致、>/<は両辺を数値変換できれば数値比較・"
        "できなければ文字列比較、Include/Excludeは部分一致(contains)/部分不一致",
    )
    p.add_argument(
        "--filter-value",
        default=None,
        help="絞り込みで比較する値",
    )
    p.add_argument(
        "--batch-api",
        action="store_true",
        help="同期呼び出しの代わりにAnthropic Message Batches APIを使う"
        "（トークン単価が通常の50%%だが非同期でジョブ完了待ちが発生する。要anthropicパッケージ）",
    )
    p.add_argument(
        "--token",
        default=None,
        help="ANTHROPIC_API_KEY環境変数の代わりに使うAPIキー（--batch-apiの有無によらず必要）",
    )
    p.add_argument(
        "--resume-batch-job",
        default=None,
        help="中断した--batch-apiジョブを再開する（local_output/batch_state_*.jsonのパスを指定）。"
        "input_csvや--filter-*/--batch-size/--modelは前回と同じものを指定すること",
    )
    p.add_argument("--batch-size", type=int, default=30)
    p.add_argument("--workers", type=int, default=8, help="並行実行するリクエスト数（--batch-api指定時は無視）")
    p.add_argument("--max-batches", type=int, default=None, help="先頭から指定バッチ数までに処理を絞る（動作確認用）")
    p.set_defaults(func=cmd_ai_classify)

    p = sub.add_parser("analyze", help="クエリ傾向を分析する（HTMLレポート込み。--with-ai-commentaryでAIコメンタリーを追加）")
    p.add_argument("input_csv")
    p.add_argument("--top-n", type=int, default=20, help="カテゴリ別頻出クエリの上位何件を出すか（デフォルト20）")
    p.add_argument(
        "--with-ai-commentary",
        action="store_true",
        help="集計結果をもとにLLM（本物のAnthropic API、要ANTHROPIC_API_KEYまたは--token）に"
        "クエリ傾向のコメンタリーを書かせ、レポートに追加する（元CSVの生データはAIに渡さない）",
    )
    p.add_argument(
        "--model",
        default="sonnet",
        choices=list(classification_common_lib.MODEL_CHOICES.keys()),
        help="AIコメンタリー生成に使うモデル（--with-ai-commentary指定時のみ使用、デフォルト: sonnet）",
    )
    p.add_argument(
        "--token",
        default=None,
        help="--with-ai-commentary使用時にANTHROPIC_API_KEY環境変数の代わりに使うAPIキー",
    )
    p.set_defaults(func=cmd_analyze)

    return parser


def ensure_anthropic_venv_and_reexec() -> None:
    """本物のAnthropic API（anthropicパッケージ）を直接叩く機能（--batch-api /
    analyzeの--with-ai-commentary）使用時にanthropicパッケージが無ければ、
    tools/data_cleaning/.venv を自動作成してインストールし、そのvenvのpythonで
    自分自身を再実行する。

    Homebrew管理下のpython3は`externally-managed-environment`（PEP 668）のため
    直接`pip install`できない。venvを切ってそちらのpythonに乗り換えることで、
    ユーザーに事前セットアップを要求せずに済ませる。

    （2026-08-25、analyzeの--with-ai-commentaryがプロキシ経由から本物のAPI直叩きに
    変わったのに伴い、--batch-api専用だったこの関数を汎用化・改名した）
    """
    try:
        import anthropic  # noqa: F401
        return
    except ImportError:
        pass

    if getattr(sys, "frozen", False):
        # GUIアプリ(PyInstallerバンドル)ではビルド時にanthropicパッケージを
        # 同梱済みの前提。ここに来るのはビルド漏れなので、venv作成やos.execveは
        # 実行できない（同梱pythonはpipもフルインタプリタも持たない）ため何もしない。
        return

    if os.environ.get("_DATA_CLEANING_VENV_ACTIVE") == "1":
        # 既にこのvenv上で動いているのにまだ無い＝install失敗。無限re-execを避けて
        # ここでは何もせず、呼び出し元（cmd_ai_classify/cmd_analyze）の
        # 通常のImportErrorハンドリングに任せる。
        return

    script_dir = os.path.dirname(os.path.abspath(__file__))
    venv_dir = os.path.join(script_dir, ".venv")
    venv_python = os.path.join(venv_dir, "bin", "python3")

    if not os.path.exists(venv_python):
        print(f"anthropicパッケージ用の仮想環境を作成します: {venv_dir}", file=sys.stderr)
        subprocess.run([sys.executable, "-m", "venv", venv_dir], check=True)

    print("venv内にanthropicパッケージをインストールします...", file=sys.stderr)
    subprocess.run([venv_python, "-m", "pip", "install", "--quiet", ANTHROPIC_PIN], check=True)

    env = dict(os.environ, _DATA_CLEANING_VENV_ACTIVE="1")
    os.execve(venv_python, [venv_python] + sys.argv, env)


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    # ai-classifyは2026-08-27より（--batch-apiの有無にかかわらず）常に本物の
    # Anthropic APIキーを直接使う設計に変更したため、anthropicパッケージが
    # 常に必要（旧・プロキシ経由の「通常API」パスは廃止。理由はai_classify.pyの
    # モジュールdocstring参照）。
    if getattr(args, "command", None) == "ai-classify" or getattr(args, "with_ai_commentary", False):
        ensure_anthropic_venv_and_reexec()
    args.func(args)


if __name__ == "__main__":
    main()
