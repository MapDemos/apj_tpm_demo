#!/usr/bin/env python3
"""
data_cleaning/ のCSVクレンジング・AI分類・傾向分析を1つにまとめたCLI。

サブコマンド:
  dedup                  重複除去（--columns-onlyでquery列のみ抽出版。
                          same_query_count列を自動付与）
  add-query-count        same_query_count列だけを付与する（重複除去はしない、プログラム的カウントのみ、AI不使用）
  count-column           指定した列の出現回数を集計する（--columnでquery/ai_classification等を指定、デフォルトquery）
  ai-classify             AI分類（プロキシ経由・並行処理。--batch-apiでBatches API版
                          （要ANTHROPIC_API_KEYまたは--token）に切り替え可）
  ai-retry                ai_classificationが指定カテゴリ（デフォルトothers）の行だけAIで再分類
                          （--batch-apiでBatches API版に切り替え可）
  analyze                クエリ傾向分析（HTMLレポート込み。--with-ai-commentaryでAI要約を追加）

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
from lib.output_utils import current_timestamp, make_output_path


def cmd_dedup(args: argparse.Namespace) -> None:
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
    output_path = make_output_path(args.input_csv, "classified_analysis_result")

    with open(args.input_csv, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        if fieldnames is None or "query" not in fieldnames:
            raise ValueError('入力CSVに "query" 列が見つかりません')
        rows = list(reader)

    if args.max_batches is not None:
        rows = rows[: args.max_batches * args.batch_size]

    queries = [row.get("query", "") for row in rows]
    unique_count = len(set(queries))
    model = classification_common_lib.MODEL_CHOICES[args.model]

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
        from lib.classification_common import SYSTEM_PROMPT

        mapping, total_in, total_out, failed_ranges = ai_classify_batch_lib.classify_unique(
            queries, args.batch_size, model, SYSTEM_PROMPT, api_key=args.token,
        )
    else:
        mapping, total_in, total_out = ai_classify_lib.classify_unique(queries, args.batch_size, args.workers, model)
    elapsed = time.time() - t0

    # 既にai_classification列が付いた入力（=一度分類済みのCSVを誤って再度渡した場合）
    # を上書きしないよう、衝突すれば_2,_3...にする。
    classification_column = column_utils_lib.unique_column_name(fieldnames, "ai_classification")
    out_fieldnames = list(fieldnames) + [classification_column]
    for row in rows:
        row[classification_column] = mapping[row.get("query", "")]

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=out_fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f"\n処理件数: {len(rows)}（うちユニークなquery: {unique_count}件をAIに送信）")
    print(f"モデル: {model}")
    if args.batch_api:
        print(f"失敗バッチ数（othersで埋めた範囲）: {failed_ranges}")
    print(f"所要時間: {elapsed:.1f}秒")
    token_note = "（Batches APIのため通常の50%価格で課金）" if args.batch_api else ""
    print(f"input tokens合計 : {total_in}{token_note}")
    print(f"output tokens合計: {total_out}{token_note}")
    if classification_column != "ai_classification":
        print(f"注意: 入力に既に \"ai_classification\" 列があったため \"{classification_column}\" 列として追加しました")
    print(f"出力先: {output_path}")


def cmd_ai_retry(args: argparse.Namespace) -> None:
    output_path = make_output_path(args.input_csv, "classified_retry_analysis_result")

    with open(args.input_csv, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        if fieldnames is None or "query" not in fieldnames:
            raise ValueError('入力CSVに "query" 列が見つかりません')
        if "ai_classification" not in fieldnames:
            raise ValueError('入力CSVに "ai_classification" 列が見つかりません')
        rows = list(reader)

    target_category = args.category
    target_indices = [i for i, row in enumerate(rows) if row.get("ai_classification") == target_category]

    if not target_indices:
        print(f"{target_category}の行が見つかりませんでした。再実行対象なし。")
        with open(output_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
        print(f"出力先: {output_path}（入力をそのままコピー）")
        return

    if args.max_batches is not None:
        limit = args.max_batches * args.batch_size
        target_indices = target_indices[:limit]

    target_queries = [rows[i]["query"] for i in target_indices]
    unique_count = len(set(target_queries))
    model = classification_common_lib.MODEL_CHOICES[args.model]

    print(f"再実行対象（{target_category}）: {len(target_indices)}件（全{len(rows)}件中、うちユニークなquery: {unique_count}件をAIに送信）", file=sys.stderr)

    t0 = time.time()
    failed_ranges = None
    if args.batch_api:
        # ai-classifyの--batch-apiと同じくAnthropic Message Batches API版に切り替える。
        # トークン単価が通常の50%になる代わりに非同期ジョブ(数分〜最大24時間)になる。
        # プロキシ経由では動かない可能性が高いため、本物のANTHROPIC_API_KEY（--tokenで上書き可）が必要。
        try:
            from lib import ai_classify_batch as ai_classify_batch_lib
        except ImportError as e:
            print(f"エラー: anthropicパッケージが必要です（pip install anthropic）: {e}", file=sys.stderr)
            sys.exit(1)
        from lib.classification_common import SYSTEM_PROMPT

        mapping, total_in, total_out, failed_ranges = ai_classify_batch_lib.classify_unique(
            target_queries, args.batch_size, model, SYSTEM_PROMPT, api_key=args.token,
        )
    else:
        mapping, total_in, total_out = ai_classify_lib.classify_unique(target_queries, args.batch_size, args.workers, model)
    elapsed = time.time() - t0

    for i in target_indices:
        rows[i]["ai_classification"] = mapping[rows[i]["query"]]

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    still_same = sum(1 for i in target_indices if rows[i]["ai_classification"] == target_category)

    print(f"\n再実行件数: {len(target_indices)}")
    print(f"モデル: {model}")
    print(f"再実行後も{target_category}のまま: {still_same}件")
    if args.batch_api:
        print(f"失敗バッチ数（othersで埋めた範囲）: {failed_ranges}")
    print(f"所要時間: {elapsed:.1f}秒")
    token_note = "（Batches APIのため通常の50%価格で課金）" if args.batch_api else ""
    print(f"input tokens合計 : {total_in}{token_note}")
    print(f"output tokens合計: {total_out}{token_note}")
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
    if args.with_ai_commentary:
        summary_payload = ai_analyze_lib.build_summary_payload(order, top_queries, daily, usage, long_tail)
        try:
            ai_commentary = ai_analyze_lib.generate_commentary(summary_payload)
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
    )
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(html_report)

    print(f"総行数: {total_rows}")
    print(f"カテゴリ数: {len(order)}（{', '.join(order)}）")
    if args.with_ai_commentary:
        print(f"AIコメンタリー: {'生成成功' if ai_commentary else '生成失敗（レポートには含まれません）'}")
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
        "API版に切り替え可、要ANTHROPIC_API_KEYまたは--token）",
    )
    p.add_argument("input_csv")
    p.add_argument(
        "--model",
        default="haiku",
        choices=list(classification_common_lib.MODEL_CHOICES.keys()),
        help="分類に使うモデル（デフォルト: haiku）",
    )
    p.add_argument(
        "--batch-api",
        action="store_true",
        help="Anthropic Message Batches APIを使う（トークン単価が通常の50%%だが非同期・要anthropicパッケージ）。"
        "プロキシ経由では動かない可能性が高いため、本物のANTHROPIC_API_KEYか--tokenが必要",
    )
    p.add_argument(
        "--token",
        default=None,
        help="--batch-api使用時にANTHROPIC_API_KEY環境変数の代わりに使うAPIキー",
    )
    p.add_argument("--batch-size", type=int, default=30)
    p.add_argument("--workers", type=int, default=8, help="並行実行するリクエスト数（--batch-api指定時は無視）")
    p.add_argument("--max-batches", type=int, default=None, help="先頭から指定バッチ数までに処理を絞る（動作確認用）")
    p.set_defaults(func=cmd_ai_classify)

    p = sub.add_parser(
        "ai-retry",
        help="ai_classificationが指定カテゴリ（デフォルトothers）の行だけAIで再分類する（--batch-apiでAnthropic "
        "Message Batches API版に切り替え可、要ANTHROPIC_API_KEYまたは--token）",
    )
    p.add_argument("input_csv")
    p.add_argument(
        "--category",
        default="others",
        choices=list(classification_common_lib.CATEGORIES.values()),
        help="再分類対象にするai_classificationの値（デフォルト: others）",
    )
    p.add_argument(
        "--model",
        default="haiku",
        choices=list(classification_common_lib.MODEL_CHOICES.keys()),
        help="分類に使うモデル（デフォルト: haiku）",
    )
    p.add_argument(
        "--batch-api",
        action="store_true",
        help="Anthropic Message Batches APIを使う（トークン単価が通常の50%%だが非同期・要anthropicパッケージ）。"
        "プロキシ経由では動かない可能性が高いため、本物のANTHROPIC_API_KEYか--tokenが必要",
    )
    p.add_argument(
        "--token",
        default=None,
        help="--batch-api使用時にANTHROPIC_API_KEY環境変数の代わりに使うAPIキー",
    )
    p.add_argument("--batch-size", type=int, default=30)
    p.add_argument("--workers", type=int, default=8, help="並行実行するリクエスト数（--batch-api指定時は無視）")
    p.add_argument("--max-batches", type=int, default=None, help="先頭から指定バッチ数までに処理を絞る（動作確認用）")
    p.set_defaults(func=cmd_ai_retry)

    p = sub.add_parser("analyze", help="クエリ傾向を分析する（HTMLレポート込み。--with-ai-commentaryでAIコメンタリーを追加）")
    p.add_argument("input_csv")
    p.add_argument("--top-n", type=int, default=20, help="カテゴリ別頻出クエリの上位何件を出すか（デフォルト20）")
    p.add_argument(
        "--with-ai-commentary",
        action="store_true",
        help="集計結果をもとにLLM（Claude Sonnet 5、プロキシ経由）にクエリ傾向のコメンタリーを書かせ、"
        "レポートに追加する（元CSVの生データはAIに渡さない）",
    )
    p.set_defaults(func=cmd_analyze)

    return parser


def ensure_batch_api_venv_and_reexec() -> None:
    """--batch-api使用時にanthropicパッケージが無ければ、tools/data_cleaning/.venv を
    自動作成してインストールし、そのvenvのpythonで自分自身を再実行する。

    Homebrew管理下のpython3は`externally-managed-environment`（PEP 668）のため
    直接`pip install`できない。venvを切ってそちらのpythonに乗り換えることで、
    ユーザーに事前セットアップを要求せずに済ませる。
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
        # ここでは何もせず、呼び出し元（cmd_ai_classify/cmd_ai_retry）の
        # 通常のImportErrorハンドリングに任せる。
        return

    script_dir = os.path.dirname(os.path.abspath(__file__))
    venv_dir = os.path.join(script_dir, ".venv")
    venv_python = os.path.join(venv_dir, "bin", "python3")

    if not os.path.exists(venv_python):
        print(f"[--batch-api] anthropicパッケージ用の仮想環境を作成します: {venv_dir}", file=sys.stderr)
        subprocess.run([sys.executable, "-m", "venv", venv_dir], check=True)

    print("[--batch-api] venv内にanthropicパッケージをインストールします...", file=sys.stderr)
    subprocess.run([venv_python, "-m", "pip", "install", "--quiet", "anthropic"], check=True)

    env = dict(os.environ, _DATA_CLEANING_VENV_ACTIVE="1")
    os.execve(venv_python, [venv_python] + sys.argv, env)


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if getattr(args, "batch_api", False):
        ensure_batch_api_venv_and_reexec()
    args.func(args)


if __name__ == "__main__":
    main()
