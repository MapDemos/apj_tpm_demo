"""
main.py ai-classify-batch サブコマンドが使うロジック（旧 classify_queries_batch.py）。

Anthropic Message Batches API を使って query 配列を分類する。
- 通常の /v1/messages ではなく /v1/messages/batches を使う非同期バッチ処理
- トークン単価が通常の50%（Anthropic公式の割引）
- 送信から結果取得まで数分〜最大24時間かかる（目安は1時間以内）
- プロキシ経由では動かない可能性が高いため、本物の ANTHROPIC_API_KEY で
  Anthropic API に直接アクセスする

事前準備:
    pip install anthropic
    export ANTHROPIC_API_KEY=sk-ant-...   （プロキシ用キーではなく、本物のAPIキーが必要）

anthropicパッケージは本サブコマンド専用の依存なので、main.py側で遅延import
（ai-classify-batch実行時のみimport）し、他のサブコマンドには影響しないようにしている。
"""

import sys
import time

import anthropic
from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
from anthropic.types.messages.batch_create_params import Request

MAX_REQUESTS_PER_JOB = 100_000
POLL_INTERVAL_SECONDS = 30


def build_requests(queries: list[str], batch_size: int, model: str, system_prompt: str) -> list[tuple[int, int, Request]]:
    """queriesをbatch_size件ずつまとめ、(start, end, Request) のリストを作る。
    custom_id には start インデックスを埋め込み、結果を元の順序に戻すのに使う。"""
    import json

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
                    model=model,
                    max_tokens=4096,
                    temperature=0,
                    system=system_prompt,
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
