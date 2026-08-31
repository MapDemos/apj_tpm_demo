"""
main.py ai-collapse-sessions サブコマンドが使う、AIベースのセッションクリーニング
ロジック（lib/session_collapse.pyの文字列前方一致ベースの間引きの後段）。

lib/session_collapse.pyだけでは、IME変換途中（例: "いわきそう"→"いわき荘"）・
住所の桁の打ち直し（例: "領家3-10-1"→"領家3-10-13"）・全角半角等の表記ゆれ
（例: "民宿　やまと"と"民宿やまと"）で前方一致が崩れ、実質的に同じ検索意図の
重複が大量に残ることが実データ検証で判明した（project memory参照）。これらは
文字列の機械的な一致だけでは判定できないため、Haikuに判断させる。

コスト効率のため、lib/session_collapse.pyの間引き後もなお2行以上残っている
セッションだけをAI送信対象にする（実データでは全セッションの約37%のみが対象）。

バッチ処理・個別リトライの基盤はlib/ai_classify.pyの汎用ヘルパー
（_run_batches_concurrently/_call_claude_raw）をそのまま再利用する
（ai_classify_batch.pyのように独立実装を持たせるほどの規模ではないため）。
デコード失敗・個別リトライでも失敗したセッションは、そのセッションの全行を
残す方にフォールバックする（データを誤って失うことを避ける安全側デフォルト。
カテゴリ再判定フェーズの「据え置き」と同じ思想）。
"""

from lib import ai_classify
from lib import session_collapse
from lib.classification_common import (
    CLASSIFY_MODEL,
    SYSTEM_PROMPT_SESSION_COLLAPSE,
    build_session_collapse_user_content,
    decode_indexed_session_collapse_responses,
    new_usage_totals,
)


def call_claude_session_collapse(
    client, sessions_batch: list[list[str]], model: str,
) -> tuple[list[list[int] | None], dict]:
    user_content = build_session_collapse_user_content(sessions_batch)
    raw_items, usage = ai_classify._call_claude_raw(
        client, SYSTEM_PROMPT_SESSION_COLLAPSE, user_content, model,
    )
    records, _missing = decode_indexed_session_collapse_responses(raw_items, sessions_batch)
    return records, usage


def collapse_sessions_with_ai(
    sessions: list[list[str]],
    batch_size: int,
    max_workers: int,
    model: str = CLASSIFY_MODEL,
    api_key: str | None = None,
) -> tuple[list[list[int] | None], dict, set[int]]:
    """sessions（各要素がそのセッションの時系列順クエリ配列）について、それぞれ
    「残すべきクエリの0始まり位置番号のリスト」を返す。デコード失敗・個別リトライ
    でも失敗したセッションはNoneのまま返す（呼び出し元で「全件残す」と解釈させる
    ため。ai_classify._run_batches_concurrentyのunknown_valueにNoneを渡している）。"""
    # main.pyのensure_anthropic_venv_and_reexec()がvenvへの自動インストール後に
    # 再実行する前提のため、anthropicは関数内で遅延importする（ai_classify.py
    # classify_unique()と同じ理由。モジュール直下でimportすると、main.pyの
    # トップレベルimport連鎖に巻き込まれ、venv再実行より前にImportErrorで
    # 落ちてしまう）。
    import anthropic

    client = anthropic.Anthropic(api_key=api_key) if api_key else anthropic.Anthropic()

    def call_fn(batch: list[list[str]]):
        return call_claude_session_collapse(client, batch, model)

    records, totals, failed_indices = ai_classify._run_batches_concurrently(
        sessions, batch_size, max_workers, call_fn, None, "セッションクリーニング(AI)",
    )
    return records, totals, failed_indices


def clean_rows(
    rows: list[dict],
    session_column: str,
    query_column: str = "query",
    datetime_column: str | None = None,
    batch_size: int = 30,
    max_workers: int = 8,
    model: str = CLASSIFY_MODEL,
    api_key: str | None = None,
) -> tuple[list[dict], dict, int]:
    """まずlib.session_collapse.collapse_sessions()で文字列前方一致ベースの間引きを
    行い、それでもなお2行以上残っているセッションだけをAIクリーニング対象にする。
    戻り値は(最終的に残った行のリスト, usage集計辞書, AI送信したセッション数)。"""
    string_result = session_collapse.collapse_sessions(
        rows, session_column, query_column=query_column, datetime_column=datetime_column,
    )
    kept_rows = string_result.kept_rows

    # セッションごとに行インデックスをグルーピングする（session_collapseと同じ
    # 順序判定ロジック: datetime列があればそれで昇順、無ければ元の順序）。
    has_datetime = datetime_column is not None and any(
        (row.get(datetime_column) or "").strip() for row in kept_rows
    )
    groups: dict[str, list[int]] = {}
    for i, row in enumerate(kept_rows):
        sid = (row.get(session_column) or "").strip()
        if not sid:
            continue
        groups.setdefault(sid, []).append(i)

    multi_session_ids = [sid for sid, idxs in groups.items() if len(idxs) >= 2]
    if not multi_session_ids:
        return kept_rows, new_usage_totals(), 0

    ordered_groups: list[list[int]] = []
    for sid in multi_session_ids:
        idxs = groups[sid]
        if has_datetime:
            idxs = sorted(idxs, key=lambda i: (kept_rows[i].get(datetime_column) or ""))
        ordered_groups.append(idxs)

    sessions_for_ai = [[kept_rows[i][query_column] for i in idxs] for idxs in ordered_groups]

    keep_records, usage_totals, _failed_indices = collapse_sessions_with_ai(
        sessions_for_ai, batch_size=batch_size, max_workers=max_workers, model=model, api_key=api_key,
    )

    drop_indices: set[int] = set()
    for group_i, idxs in enumerate(ordered_groups):
        keep_positions = keep_records[group_i]
        if keep_positions is None:
            # AI判定に失敗したセッションは安全側に倒し、全件残す。
            continue
        keep_set = set(keep_positions)
        for pos, row_i in enumerate(idxs):
            if pos not in keep_set:
                drop_indices.add(row_i)

    final_rows = [row for i, row in enumerate(kept_rows) if i not in drop_indices]
    return final_rows, usage_totals, len(multi_session_ids)
