#!/usr/bin/env python3
"""
data_cleaning/ のCSVクレンジング・AI分類・傾向分析を1つにまとめたCLI。

サブコマンド:
  dedup                  重複除去（--columns-onlyでquery列のみ抽出版）
  count-queries          query出現回数カウント
  ai-classify             AI分類（プロキシ経由・並行処理）
  ai-classify-batch       AI分類（Anthropic Message Batches API版、要ANTHROPIC_API_KEY）
  ai-retry                ai_classificationがothersの行だけAIで再分類
  count-classifications  分類結果の件数集計
  analyze                クエリ傾向分析（HTMLレポート込み）

各サブコマンドの詳細は `python3 main.py <subcommand> --help` を参照。
出力は全サブコマンド共通で local_output/ 配下に自動生成される
（<入力ファイル名>_<suffix>_<タイムスタンプ>.csv、詳細は lib/output_utils.py）。
"""

import argparse
import csv
import sys
import time

from lib import ai_classify as ai_classify_lib
from lib import analyze_trends as analyze_trends_lib
from lib import count_classifications as count_classifications_lib
from lib import count_queries as count_queries_lib
from lib import dedup as dedup_lib
from lib.output_utils import current_timestamp, make_output_path


def cmd_dedup(args: argparse.Namespace) -> None:
    if args.columns_only:
        queries = dedup_lib.extract_queries(args.input_csv)
        before = len(queries)
        cleaned = dedup_lib.dedupe_within_window(queries, key=lambda q: q)
        after = len(cleaned)
        output_path = make_output_path(args.input_csv, "cleaning_queryonly")
        dedup_lib.write_queries(output_path, cleaned)
        print(f"抽出したquery件数: {before}")
        print(f"重複除去後のquery件数: {after}（{before - after}件削除）")
    else:
        fieldnames, rows = dedup_lib.extract_rows(args.input_csv)
        before = len(rows)
        cleaned = dedup_lib.dedupe_within_window(rows, key=lambda r: r["query"])
        after = len(cleaned)
        output_path = make_output_path(args.input_csv, "cleaning")
        dedup_lib.write_rows(output_path, fieldnames, cleaned)
        print(f"入力行数: {before}")
        print(f"重複除去後の行数: {after}（{before - after}件削除）")
    print(f"出力先: {output_path}")


def cmd_count_queries(args: argparse.Namespace) -> None:
    queries = count_queries_lib.extract_queries(args.input_csv)
    items = count_queries_lib.count_queries(queries)
    output_path = make_output_path(args.input_csv, "count_analysis_result")
    count_queries_lib.write_counts(output_path, items)

    total = len(queries)
    unique = len(items)
    duplicated = sum(1 for _, c in items if c > 1)

    print(f"総行数: {total}")
    print(f"ユニークなquery数: {unique}")
    print(f"2回以上出現するquery数: {duplicated}")
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

    t0 = time.time()
    labels, total_in, total_out = ai_classify_lib.classify_all(queries, args.batch_size, args.workers)
    elapsed = time.time() - t0

    out_fieldnames = list(fieldnames) + ["ai_classification"]
    for row, label in zip(rows, labels):
        row["ai_classification"] = label

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=out_fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f"\n処理件数: {len(rows)}")
    print(f"所要時間: {elapsed:.1f}秒")
    print(f"input tokens合計 : {total_in}")
    print(f"output tokens合計: {total_out}")
    print(f"出力先: {output_path}")


def cmd_ai_classify_batch(args: argparse.Namespace) -> None:
    try:
        from lib import ai_classify_batch as ai_classify_batch_lib
        import anthropic
    except ImportError as e:
        print(f"エラー: anthropicパッケージが必要です（pip install anthropic）: {e}", file=sys.stderr)
        sys.exit(1)

    from lib.classification_common import MODEL, SYSTEM_PROMPT, numbers_to_labels, parse_response_text
    import json

    output_path = make_output_path(args.input_csv, "classified_batch_analysis_result")

    with open(args.input_csv, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        if fieldnames is None or "query" not in fieldnames:
            raise ValueError('入力CSVに "query" 列が見つかりません')
        rows = list(reader)

    queries = [row.get("query", "") for row in rows]
    all_requests = ai_classify_batch_lib.build_requests(queries, args.batch_size, MODEL, SYSTEM_PROMPT)

    client = anthropic.Anthropic()  # ANTHROPIC_API_KEY 環境変数から読む

    labels: list[str] = ["others"] * len(queries)
    total_in = 0
    total_out = 0
    failed_ranges = 0

    t0 = time.time()

    # 100,000リクエスト/ジョブの上限に合わせてジョブを分割
    for job_start in range(0, len(all_requests), ai_classify_batch_lib.MAX_REQUESTS_PER_JOB):
        job_requests_meta = all_requests[job_start:job_start + ai_classify_batch_lib.MAX_REQUESTS_PER_JOB]
        job_requests = [r for _, _, r in job_requests_meta]

        results_by_id = ai_classify_batch_lib.run_batch_job(client, job_requests)

        for start, end, req in job_requests_meta:
            result = results_by_id.get(req.custom_id)
            chunk_len = end - start

            if result is None:
                print(f"  警告: {req.custom_id} の結果が見つかりません（othersで埋めます）", file=sys.stderr)
                failed_ranges += 1
                continue

            if result.type != "succeeded":
                print(f"  警告: {req.custom_id} は {result.type}（othersで埋めます）", file=sys.stderr)
                failed_ranges += 1
                continue

            message = result.message
            content_blocks = message.content or []
            text = "".join(b.text for b in content_blocks if b.type == "text")
            text = parse_response_text(text)

            try:
                numbers = json.loads(text)
                if not isinstance(numbers, list) or len(numbers) != chunk_len:
                    raise ValueError("要素数不一致")
                chunk_labels = numbers_to_labels(numbers)
            except (json.JSONDecodeError, ValueError) as e:
                print(f"  警告: {req.custom_id} のパースに失敗（othersで埋めます）: {e}", file=sys.stderr)
                failed_ranges += 1
                continue

            for i, label in enumerate(chunk_labels):
                labels[start + i] = label

            usage = message.usage
            total_in += usage.input_tokens or 0
            total_out += usage.output_tokens or 0

    elapsed = time.time() - t0

    out_fieldnames = list(fieldnames) + ["ai_classification"]
    for row, label in zip(rows, labels):
        row["ai_classification"] = label

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=out_fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f"\n処理件数: {len(rows)}")
    print(f"失敗バッチ数（othersで埋めた範囲）: {failed_ranges}")
    print(f"所要時間: {elapsed:.1f}秒")
    print(f"input tokens合計 : {total_in}（Batches APIのため通常の50%価格で課金）")
    print(f"output tokens合計: {total_out}（Batches APIのため通常の50%価格で課金）")
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

    target_indices = [i for i, row in enumerate(rows) if row.get("ai_classification") == "others"]

    if not target_indices:
        print("othersの行が見つかりませんでした。再実行対象なし。")
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

    print(f"再実行対象: {len(target_indices)}件（全{len(rows)}件中）", file=sys.stderr)

    t0 = time.time()
    labels, total_in, total_out = ai_classify_lib.classify_all(target_queries, args.batch_size, args.workers)
    elapsed = time.time() - t0

    for i, label in zip(target_indices, labels):
        rows[i]["ai_classification"] = label

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    still_others = sum(1 for i in target_indices if rows[i]["ai_classification"] == "others")

    print(f"\n再実行件数: {len(target_indices)}")
    print(f"再実行後もothersのまま: {still_others}件")
    print(f"所要時間: {elapsed:.1f}秒")
    print(f"input tokens合計 : {total_in}")
    print(f"output tokens合計: {total_out}")
    print(f"出力先: {output_path}")


def cmd_count_classifications(args: argparse.Namespace) -> None:
    labels = count_classifications_lib.extract_labels(args.input_csv)
    items = count_classifications_lib.count_labels(labels)
    total = len(labels)

    output_path = make_output_path(args.input_csv, "classification_count_analysis_result")
    count_classifications_lib.write_counts(output_path, items, total)

    print(f"総行数: {total}")
    for label, count in items:
        ratio = f"{count / total * 100:.1f}%" if total else "0.0%"
        print(f"  {label}: {count}件（{ratio}）")
    print(f"出力先: {output_path}")


def cmd_analyze(args: argparse.Namespace) -> None:
    fieldnames, rows = analyze_trends_lib.read_rows(args.input_csv)
    total_rows = len(rows)

    seen_categories = {row.get("ai_classification", "") for row in rows}
    order = analyze_trends_lib.category_order(seen_categories)

    top_queries = analyze_trends_lib.compute_top_queries(rows, args.top_n)
    daily = analyze_trends_lib.compute_daily_category(rows)
    usage = analyze_trends_lib.compute_column_usage(rows)

    ts = current_timestamp()
    top_queries_path = make_output_path(args.input_csv, "trend_top_queries_result", timestamp=ts)
    daily_path = make_output_path(args.input_csv, "trend_daily_category_result", timestamp=ts)
    usage_path = make_output_path(args.input_csv, "trend_column_usage_result", timestamp=ts)
    report_path = make_output_path(args.input_csv, "trend_report", timestamp=ts, ext="html")

    analyze_trends_lib.write_top_queries_csv(top_queries_path, top_queries, order)
    analyze_trends_lib.write_daily_category_csv(daily_path, daily, order)
    analyze_trends_lib.write_column_usage_csv(usage_path, usage, order)

    generated_at = f"{ts[:4]}-{ts[4:6]}-{ts[6:8]} {ts[9:11]}:{ts[11:13]}:{ts[13:15]}"
    html_report = analyze_trends_lib.render_html_report(
        args.input_csv, generated_at, total_rows, order, top_queries, daily, usage, args.top_n
    )
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(html_report)

    print(f"総行数: {total_rows}")
    print(f"カテゴリ数: {len(order)}（{', '.join(order)}）")
    print("出力先:")
    print(f"  {top_queries_path}")
    print(f"  {daily_path}")
    print(f"  {usage_path}")
    print(f"  {report_path}  ← HTMLレポート")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="main.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("dedup", help="重複除去（後ろ5行以内・最初の出現を正とする）")
    p.add_argument("input_csv")
    p.add_argument("--columns-only", action="store_true", help="query列のみ抽出して出力する（他の列は捨てる）")
    p.set_defaults(func=cmd_dedup)

    p = sub.add_parser("count-queries", help="query列の出現回数をカウントする")
    p.add_argument("input_csv")
    p.set_defaults(func=cmd_count_queries)

    p = sub.add_parser("ai-classify", help="LLMでquery列を分類する（プロキシ経由・並行処理）")
    p.add_argument("input_csv")
    p.add_argument("--batch-size", type=int, default=30)
    p.add_argument("--workers", type=int, default=8, help="並行実行するリクエスト数")
    p.add_argument("--max-batches", type=int, default=None, help="先頭から指定バッチ数までに処理を絞る（動作確認用）")
    p.set_defaults(func=cmd_ai_classify)

    p = sub.add_parser("ai-classify-batch", help="LLMでquery列を分類する（Anthropic Message Batches API版、要ANTHROPIC_API_KEY）")
    p.add_argument("input_csv")
    p.add_argument("--batch-size", type=int, default=30)
    p.set_defaults(func=cmd_ai_classify_batch)

    p = sub.add_parser("ai-retry", help="ai_classificationがothersの行だけAIで再分類する")
    p.add_argument("input_csv")
    p.add_argument("--batch-size", type=int, default=30)
    p.add_argument("--workers", type=int, default=8, help="並行実行するリクエスト数")
    p.add_argument("--max-batches", type=int, default=None, help="先頭から指定バッチ数までに処理を絞る（動作確認用）")
    p.set_defaults(func=cmd_ai_retry)

    p = sub.add_parser("count-classifications", help="ai_classification列を件数集計する")
    p.add_argument("input_csv")
    p.set_defaults(func=cmd_count_classifications)

    p = sub.add_parser("analyze", help="クエリ傾向を分析する（HTMLレポート込み）")
    p.add_argument("input_csv")
    p.add_argument("--top-n", type=int, default=20, help="カテゴリ別頻出クエリの上位何件を出すか（デフォルト20）")
    p.set_defaults(func=cmd_analyze)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
