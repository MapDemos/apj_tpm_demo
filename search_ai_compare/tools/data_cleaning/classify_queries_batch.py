#!/usr/bin/env python3
"""
Anthropic Message Batches API を使って query 列を分類し、
判定結果列を追加したCSVを出力するスクリプト。

classify_queries.py（プロキシ経由・同期/並行処理版）との違い:
- 通常の /v1/messages ではなく /v1/messages/batches を使う非同期バッチ処理
- トークン単価が通常の50%（Anthropic公式の割引）
- 送信から結果取得まで数分〜最大24時間かかる（目安は1時間以内）
- プロキシ経由では動かない可能性が高いため、本物の ANTHROPIC_API_KEY で
  Anthropic API に直接アクセスする

分類カテゴリの定義は classification_common.py を参照（番号1〜7で返させ、
Python側でカテゴリ名に変換する）。

出力先は output/ 配下に自動生成
（<入力ファイル名>_classified_batch_analysis_result_<タイムスタンプ>.csv）。

事前準備:
    pip install anthropic
    export ANTHROPIC_API_KEY=sk-ant-...   （このプロキシ用キーではなく、本物のAPIキーが必要）

使い方:
    python3 classify_queries_batch.py input.csv [--batch-size 30]

    1回のバッチジョブに含められるリクエスト数はAnthropic側の上限で
    100,000件まで。--batch-size 30 なら 300万クエリ分まで1ジョブで収まる
    （40万クエリなら約13,334リクエストで余裕）。念のため上限を超える場合は
    自動的に複数ジョブに分割して順に処理する。
"""

import argparse
import csv
import json
import sys
import time

import anthropic
from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
from anthropic.types.messages.batch_create_params import Request

from classification_common import (
    MODEL,
    SYSTEM_PROMPT,
    numbers_to_labels,
    parse_response_text,
)
from output_utils import make_output_path

MAX_REQUESTS_PER_JOB = 100_000
POLL_INTERVAL_SECONDS = 30
SUFFIX = "classified_batch_analysis_result"


def build_requests(queries: list[str], batch_size: int) -> list[tuple[int, int, Request]]:
    """queriesをbatch_size件ずつまとめ、(start, end, Request) のリストを作る。
    custom_id には start インデックスを埋め込み、結果を元の順序に戻すのに使う。"""
    requests = []
    n = len(queries)
    for start in range(0, n, batch_size):
        end = min(start + batch_size, n)
        chunk = queries[start:end]
        user_content = json.dumps(chunk, ensure_ascii=False)
        requests.append((
            start,
            end,
            Request(
                custom_id=f"batch-{start}",
                params=MessageCreateParamsNonStreaming(
                    model=MODEL,
                    max_tokens=4096,
                    temperature=0,
                    system=SYSTEM_PROMPT,
                    messages=[{"role": "user", "content": user_content}],
                ),
            ),
        ))
    return requests


def run_batch_job(client: anthropic.Anthropic, requests: list[Request]) -> dict:
    """1つのバッチジョブを送信し、完了までポーリングしてから結果を返す。
    戻り値は custom_id -> result.result のマッピング。"""
    job = client.messages.batches.create(requests=requests)
    print(f"バッチジョブ作成: {job.id}（{len(requests)}リクエスト）", file=sys.stderr)

    while True:
        job = client.messages.batches.retrieve(job.id)
        counts = job.request_counts
        print(
            f"  status={job.processing_status} "
            f"processing={counts.processing} succeeded={counts.succeeded} "
            f"errored={counts.errored} canceled={counts.canceled} expired={counts.expired}",
            file=sys.stderr,
        )
        if job.processing_status == "ended":
            break
        time.sleep(POLL_INTERVAL_SECONDS)

    results_by_id = {}
    for result in client.messages.batches.results(job.id):
        results_by_id[result.custom_id] = result.result
    return results_by_id


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_csv")
    parser.add_argument("--batch-size", type=int, default=30)
    args = parser.parse_args()

    output_path = make_output_path(args.input_csv, SUFFIX)

    with open(args.input_csv, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        if fieldnames is None or "query" not in fieldnames:
            raise ValueError('入力CSVに "query" 列が見つかりません')
        rows = list(reader)

    queries = [row.get("query", "") for row in rows]
    all_requests = build_requests(queries, args.batch_size)

    client = anthropic.Anthropic()  # ANTHROPIC_API_KEY 環境変数から読む

    labels: list[str] = ["others"] * len(queries)
    total_in = 0
    total_out = 0
    failed_ranges = 0

    t0 = time.time()

    # 100,000リクエスト/ジョブの上限に合わせてジョブを分割
    for job_start in range(0, len(all_requests), MAX_REQUESTS_PER_JOB):
        job_requests_meta = all_requests[job_start:job_start + MAX_REQUESTS_PER_JOB]
        job_requests = [r for _, _, r in job_requests_meta]

        results_by_id = run_batch_job(client, job_requests)

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
            text = "".join(
                b.text for b in content_blocks if b.type == "text"
            )
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


if __name__ == "__main__":
    main()
