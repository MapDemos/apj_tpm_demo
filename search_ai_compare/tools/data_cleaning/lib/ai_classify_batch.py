"""
ai-classify/ai-retry の --batch-api 指定時に使うロジック（旧 classify_queries_batch.py、
旧 ai-classify-batch 独立サブコマンドは廃止・統合済み）。

Anthropic Message Batches API を使って query 配列を分類する。
- 通常の /v1/messages ではなく /v1/messages/batches を使う非同期バッチ処理
- トークン単価が通常の50%（Anthropic公式の割引）
- 送信から結果取得まで数分〜最大24時間かかる（目安は1時間以内）
- プロキシ経由では動かない可能性が高いため、本物の ANTHROPIC_API_KEY で
  Anthropic API に直接アクセスする

事前準備:
    export ANTHROPIC_API_KEY=sk-ant-...   （プロキシ用キーではなく、本物のAPIキーが必要）
    ※anthropicパッケージ自体はmain.pyのensure_batch_api_venv_and_reexec()が
      .venv/ を自動作成してインストールするので手動インストール不要

anthropicパッケージは本機能専用の依存なので、main.py側で遅延import
（--batch-api指定時のみimport）し、他のサブコマンドには影響しないようにしている。
"""

import json
import sys
import time

import anthropic
from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
from anthropic.types.messages.batch_create_params import Request

from lib.classification_common import numbers_to_labels, parse_response_text

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
        params: MessageCreateParamsNonStreaming = {
            "model": model,
            "max_tokens": 4096,
            "system": system_prompt,
            "messages": [{"role": "user", "content": user_content}],
        }
        # temperatureはSonnet 5では非推奨パラメータで、指定すると invalid_request_error
        # になる（ai_classify.pyのcall_claudeと同じ理由）。haiku指定時のみ付与する。
        if "haiku" in model:
            params["temperature"] = 0
        requests.append((
            start,
            end,
            Request(
                custom_id=f"batch-{start}",
                params=params,
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


def classify_unique(
    queries: list[str],
    batch_size: int,
    model: str,
    system_prompt: str,
    api_key: str | None = None,
) -> tuple[dict[str, str], int, int, int]:
    """queriesからユニークな値だけを抽出し、Batches APIで分類する。
    {query文字列: label} の辞書・input/outputトークン合計・失敗レンジ数を返す。
    ai_classify.classify_unique（プロキシ版）と同様、重複クエリをまとめて
    送ることでコストと不整合を抑える。

    api_key を渡すと ANTHROPIC_API_KEY 環境変数の代わりにそれを使う。"""
    unique_queries = list(dict.fromkeys(queries))
    all_requests = build_requests(unique_queries, batch_size, model, system_prompt)

    client = anthropic.Anthropic(api_key=api_key) if api_key else anthropic.Anthropic()

    labels: list[str] = ["others"] * len(unique_queries)
    total_in = 0
    total_out = 0
    failed_ranges = 0

    # 100,000リクエスト/ジョブの上限に合わせてジョブを分割
    for job_start in range(0, len(all_requests), MAX_REQUESTS_PER_JOB):
        job_requests_meta = all_requests[job_start:job_start + MAX_REQUESTS_PER_JOB]
        job_requests = [r for _, _, r in job_requests_meta]

        results_by_id = run_batch_job(client, job_requests)

        for start, end, req in job_requests_meta:
            custom_id = req["custom_id"]
            result = results_by_id.get(custom_id)
            chunk_len = end - start

            if result is None:
                print(f"  警告: {custom_id} の結果が見つかりません（othersで埋めます）", file=sys.stderr)
                failed_ranges += 1
                continue

            if result.type != "succeeded":
                detail = ""
                if result.type == "errored":
                    detail = f": {result.error.error.type} - {result.error.error.message}"
                print(f"  警告: {custom_id} は {result.type}{detail}（othersで埋めます）", file=sys.stderr)
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
                print(f"  警告: {custom_id} のパースに失敗（othersで埋めます）: {e}", file=sys.stderr)
                failed_ranges += 1
                continue

            for i, label in enumerate(chunk_labels):
                labels[start + i] = label

            usage = message.usage
            total_in += usage.input_tokens or 0
            total_out += usage.output_tokens or 0

    mapping = dict(zip(unique_queries, labels))
    return mapping, total_in, total_out, failed_ranges
