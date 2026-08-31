"""
main.py collapse-sessions サブコマンドが使う「セッション内タイピング途中断片の間引き」ロジック。

背景（project memory参照）: このクエリログはリアルタイム検索候補(suggest)APIの
生ログであり、同じsession_token内に「1文字打つごとの状態」が別々の行として
大量に記録されている（実データで実証済み。例: "あ"→"あそ"→"あそべ"→...→
"あそべの森 いわき荘"）。これらを別々の「ユニークなquery」としてAI分類・
analyze集計に流すと、コストの無駄・レポートの歪みの両方につながる。

間引きの規則: 同一セッション内で、自分より後ろの行に「自分自身の文字列を先頭に
含み、かつ同じ長さ以上の」queryが存在する行は、入力途中で確定前の断片だった
とみなして削除する（例: "あそ"は後で"あそべの森 いわき荘"が出てくるので削除）。
「もっと長い文字列を残す」という単純な規則ではなく、あくまで「後続かどうか」＋
「先頭一致するかどうか」を基準にしている点に注意（project memory参照）:
- IME変換は文字数を減らす方向にも働く（例: "いわきそう"→"いわき荘"）ため、
  単純に最長の文字列を残す方式では変換前の未確定状態を誤って残してしまう。
- 1つのsession_token内で、ユーザーが検索を諦めて別の目的地を検索し直す
  ケースがある（例: "茅ヶ崎"を検索した後に諦めて"ソウル特別市"を検索）。
  この場合は先頭一致しないため、どちらも独立した検索意図として残る
  （session_token単位で1行に潰す方式だと、この片方が失われてしまう）。

実装は各セッションを後ろから前へ走査し、「これまでに残すと決めた文字列」の
集合に対して先頭一致するかどうかだけを見る。転置律（Aの後にB、Bの後にCが
先頭一致で続く場合、AはCに対しても間接的に先頭一致する）が成り立つため、
「削除された行」ではなく「残すと決めた行」の集合とだけ比較すればよく、
O(セッション内行数 × 残った行数)で計算できる。

【フォールバック疑似セッション（2026-08-31、project memory参照）】
LUUP由来のログ実データで、session_token列が「1文字打つごとに毎回新規発行」
されており、同一タイピングセッションのはずの行群がすべて別々のsession_token
（＝上記の間引きロジックが一切効かない、比較対象がいないため）になっている
ケースが実測で確認された（あるファイルではsuggest行の89.6%がsession_token
単独行）。

これを救うため、session_token単独行（＝真のグループサイズが1の行）に限り、
proximity列（unquote後の文字列で完全一致）＋タイムスタンプの近さ（デフォルト
30秒以内が連続していれば同一クラスタ、それ以上開けば別クラスタに分割）で
疑似セッションを再構成し、上記と同じ前方一致ロジックに乗せる。

閾値の根拠（実データ分析）:
- proximityは完全一致 or 大きくジャンプ(≧0.01度=1km超の実移動)の二極化で、
  中間の「揺らぎ」はほぼ存在しない（隣接ペア6,765件中98.8%が完全一致、
  0.0001〜0.001度のズレはわずか0.03%）。LUUPアプリは現在地でなく地図描画
  範囲の中央をproximityにしているらしく、GPS由来の揺らぎが出ないため
  （ユーザー確認済み）。よって小数点以下を丸めての緩い一致は不要かつ、
  無関係な別ユーザーを誤って同一視するリスクを増やすだけなので採用しない。
- 一方、1つのproximity値に137個もの異なるsession_tokenがぶら下がる
  ケースがあり（駅前のLUUPポート等、固定地点に丸められた座標とみられる）、
  proximity完全一致だけでは別人同士を誤結合しかねない。時間窓は実測の
  セッション内リクエスト間隔（99%ileが14秒）から30秒とし、かつ実際の
  行削除判定は依然として前方一致ロジックに委ねる（疑似クラスタ内に無関係な
  別人のクエリが紛れ込んでも、前方一致しない限り削除されないため実害は
  ほぼ出ない設計）。
- datetime列が無い、またはproximityが空の行はフォールバック対象外
  （時間窓判定ができないため）。
"""

import csv
import urllib.parse
from dataclasses import dataclass
from datetime import datetime

# 列名の自動検出候補（gui_app.pyのQUERY_COLUMN_CANDIDATESと同じ発想。
# 大文字小文字を無視して照合する）。
SESSION_COLUMN_CANDIDATES = [
    "session_token", "session_id", "sessionid", "session",
    "セッション", "セッションid", "セッショントークン",
]

# proximityはMapbox Search Box/Geocoding APIの決まったパラメータ名なので、
# session列ほど表記ゆれを想定していない（case-insensitiveのみ吸収する）。
PROXIMITY_COLUMN_CANDIDATES = ["proximity"]

# フォールバック疑似セッションの時間窓（秒）。上記docstring参照。
DEFAULT_FALLBACK_TIME_WINDOW_SECONDS = 30


def detect_session_column(fieldnames: list[str]) -> str | None:
    """fieldnamesの中からセッションID列らしきものを検出する（大文字小文字を無視。
    候補の中で最初に一致したものを返す。見つからなければNone）。"""
    lowered = {name.lower(): name for name in fieldnames}
    for candidate in SESSION_COLUMN_CANDIDATES:
        if candidate.lower() in lowered:
            return lowered[candidate.lower()]
    return None


def detect_proximity_column(fieldnames: list[str]) -> str | None:
    """fieldnamesの中からproximity列を検出する（大文字小文字を無視）。
    見つからなければNone（フォールバック疑似セッションはスキップされる）。"""
    lowered = {name.lower(): name for name in fieldnames}
    for candidate in PROXIMITY_COLUMN_CANDIDATES:
        if candidate.lower() in lowered:
            return lowered[candidate.lower()]
    return None


def _parse_datetime(raw: str) -> datetime | None:
    """"2026-08-25 23:59:49 UTC" 形式をパースする。失敗時はNone。"""
    s = (raw or "").strip()
    if s.endswith(" UTC"):
        s = s[: -len(" UTC")]
    try:
        return datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def _build_fallback_pseudo_sessions(
    rows: list[dict],
    candidate_indices: list[int],
    proximity_column: str,
    datetime_column: str,
    time_window_seconds: int,
) -> list[list[int]]:
    """session_token単独行（candidate_indices）を、proximity完全一致＋時間窓で
    疑似セッションにクラスタリングする。2行以上になったクラスタのみ返す
    （1行だけのクラスタは間引きようがないので不要）。"""
    by_proximity: dict[str, list[int]] = {}
    for i in candidate_indices:
        raw = rows[i].get(proximity_column, "")
        prox = urllib.parse.unquote(raw or "").strip()
        if not prox:
            continue
        dt = _parse_datetime(rows[i].get(datetime_column, ""))
        if dt is None:
            continue
        by_proximity.setdefault(prox, []).append(i)

    clusters: list[list[int]] = []
    for indices in by_proximity.values():
        ordered = sorted(indices, key=lambda i: _parse_datetime(rows[i].get(datetime_column, "")))
        current: list[int] = [ordered[0]]
        prev_dt = _parse_datetime(rows[ordered[0]].get(datetime_column, ""))
        for i in ordered[1:]:
            dt = _parse_datetime(rows[i].get(datetime_column, ""))
            gap = (dt - prev_dt).total_seconds()
            if gap <= time_window_seconds:
                current.append(i)
            else:
                if len(current) >= 2:
                    clusters.append(current)
                current = [i]
            prev_dt = dt
        if len(current) >= 2:
            clusters.append(current)

    return clusters


@dataclass
class CollapseResult:
    kept_rows: list[dict]
    dropped_count: int
    fallback_session_count: int = 0


def collapse_sessions(
    rows: list[dict],
    session_column: str,
    query_column: str = "query",
    datetime_column: str | None = "datetime",
    proximity_column: str | None = None,
    fallback_time_window_seconds: int = DEFAULT_FALLBACK_TIME_WINDOW_SECONDS,
) -> CollapseResult:
    """セッションごとにタイピング途中の断片を間引く。rowsは元の行順のまま
    （csv.DictReaderの出現順）を前提とする。datetime_column（存在する場合）で
    セッション内を昇順ソートしてから判定する（実データ検証で、この列が正しい
    タイピング順を再現できることを確認済み。project memory参照）。同時刻は
    元のファイル順でタイブレークする。datetime_columnが存在しない・値が空の
    行が混在する場合は元のファイル順を使う。

    session_column の値が空文字列の行は、グルーピング対象外として無条件で残す
    （判定不能なため）。

    proximity_columnを指定すると、session_column単独行（真のグループサイズが1）
    に限りフォールバック疑似セッションを追加で構成する（モジュールdocstring
    参照。LUUP実データでsession_tokenが1リクエストごとに使い捨てにされている
    ケースへの対策）。datetime_columnが無い場合はフォールバックは効かない。"""
    n = len(rows)
    # (session値, 元のインデックス, ソートキー) の3つ組でグルーピングする。
    groups: dict[str, list[int]] = {}
    for i, row in enumerate(rows):
        session_value = (row.get(session_column) or "").strip()
        if not session_value:
            continue
        groups.setdefault(session_value, []).append(i)

    has_datetime = datetime_column is not None and any(
        (row.get(datetime_column) or "").strip() for row in rows
    )

    fallback_clusters: list[list[int]] = []
    if proximity_column is not None and has_datetime:
        singleton_indices = [indices[0] for indices in groups.values() if len(indices) == 1]
        fallback_clusters = _build_fallback_pseudo_sessions(
            rows, singleton_indices, proximity_column, datetime_column, fallback_time_window_seconds,
        )

    dropped = [False] * n
    for indices in list(groups.values()) + fallback_clusters:
        if len(indices) < 2:
            continue
        if has_datetime:
            # 2026-08-31、同一秒に丸められて時刻が同着になるケースのタイブレークを
            # 修正した（project memory参照）。実データの"岐阜"→"岐阜県"→"岐阜県関"の
            # 3件が全て同一秒で記録されているセッションで、間引きが機能しないバグが
            # 見つかった。元の実装は安定ソートで元のファイル順をそのまま維持していたが、
            # このCSVはファイル全体が新しい→古いの順で並んでいる（実データ検証済み）
            # ため、同着グループ内も「ファイルで先に出てきた方が実は時系列的に新しい」
            # という前提に合わせる必要がある。タイブレークを元のインデックスの降順に
            # することで、ファイルで先に出てきた行（＝真の時系列では新しい）を昇順の
            # 最後に持ってくる。
            #
            # 一時期「同一秒内は前後関係を仮定せず双方向でチェックする」方式も試したが、
            # 「A(短い)→ABC(打ちすぎ)→AB(打ち直して正解)」のように、時系列の後半で
            # 短く訂正されるケースで正しいABの方を誤って消してしまう問題が判明し撤回した
            # （双方向だと「長い方が常に正しい」という扱いになってしまうため）。時系列を
            # 信用する一方向方式なら、この訂正パターンではAB・ABC両方が残る（ABはABCより
            # 新しいため誰にも吸収されず、ABCもAB(短すぎて追い越せない)には吸収されない）。
            # トレードオフとして、「伸ばしてから検索欄を空に近い状態までクリアした」場合に
            # 残る意味の無い短い断片（例: "岐"）を積極的には除去できなくなるが、これは
            # ai-classify側（BOUNDARY_GUIDANCE、断片は4(unknown)にしてよいという
            # ガイダンス）で拾う方針にした。project memory参照。
            ordered = sorted(indices, key=lambda i: (rows[i].get(datetime_column) or "", -i))
        else:
            ordered = indices

        kept_queries: list[str] = []
        for i in reversed(ordered):
            q = rows[i].get(query_column, "")
            superseded = any(
                len(kept) >= len(q) and kept.startswith(q) for kept in kept_queries
            )
            if superseded:
                dropped[i] = True
            else:
                kept_queries.append(q)

    # 2026-08-31、空文字列のqueryは前方一致判定を待たず無条件で削除するように
    # 追加した（project memory参照）。空文字列は「検索欄をクリアした」ことを
    # 示すだけで検索意図としての情報を一切持たない。前方一致ルールは「自分より
    # 後ろの行」だけを見るため、セッションの最後の行がたまたま空文字列だと
    # （クリア操作がそのセッションの最終イベントだった場合）誰にも吸収されず
    # 残ってしまう問題が実データで見つかった（実データの多重残存セッションの
    # 62.8%がこのパターンだった）。
    for i, row in enumerate(rows):
        if dropped[i]:
            continue
        if not (row.get(query_column) or "").strip():
            dropped[i] = True

    kept_rows = [row for i, row in enumerate(rows) if not dropped[i]]
    return CollapseResult(
        kept_rows=kept_rows,
        dropped_count=n - len(kept_rows),
        fallback_session_count=len(fallback_clusters),
    )


def read_rows(input_path: str) -> tuple[list[str], list[dict]]:
    with open(input_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None or "query" not in reader.fieldnames:
            raise ValueError('入力CSVに "query" 列が見つかりません')
        fieldnames = list(reader.fieldnames)
        rows = list(reader)
    return fieldnames, rows


def write_rows(output_path: str, fieldnames: list[str], rows: list[dict]) -> None:
    # Excel等での文字化け対策としてBOM付きUTF-8で出力する（project memory参照）。
    with open(output_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
