"""
クエリとブランド名(BRAND_CATEGORY_MAP)・その別名(BRAND_SYNONYMS)を、表記体系
(カタカナ/ひらがな/ローマ字。kana_match.normalize_variants参照)をまたいで
部分一致で機械的に候補生成するためのインデックス。

設計方針（project memory: search_ai_compareのbrand判定精度改善の議論参照）:
クエリ数(数万件)×ブランド数(1573件)×別名(3445件)を毎回総当たりで
kana_match.variant_contains()にかけると計算量が爆発する
（O(クエリ数 × ブランド数 × 表記体系の組み合わせ数)）。そこで、ブランド側は
事前に1回だけインデックス化しておき、クエリ側の処理量だけで済むようにする:

1. whole_forms: ブランド/別名の表記体系変換形（丸ごと1つの文字列）→そのブランド名。
   「クエリの中にブランド名がそのまま/変換形として埋め込まれている」ケース
   （例: クエリ"アパホテル渋谷駅前"の中に"アパホテル"を含む）を検出するために使う。
   クエリ側で全部分文字列を生成し、この辞書とO(1)照合する。
2. substring_index: ブランド/別名の表記体系変換形の、あらゆる部分文字列
   （長さmin_len以上）→そのブランド名。「クエリ自体がブランド名の一部分
   （プレフィックス等）だけを短く言ったもの」のケース（例: クエリ"アパ"が
   ブランド"アパホテル"の一部）を検出するために使う。クエリ側は変換形を
   そのままこの辞書とO(1)照合するだけでよい（クエリ側で部分文字列展開は不要）。

この2つを組み合わせることで、クエリ側の計算量はO(クエリ文字数の2乗)のみになり、
ブランド数(1573件)に依存しなくなる（インデックス構築自体はブランド側データに
対して最初に1回だけ行う、O(ブランド側文字列の総文字数の2乗)の前処理）。

2026-08-29、substring_index（方向2、「クエリ自体がブランド名の一部分」用）に
間引き処理を追加した。実データで検証したところ、"ホテル"（98ブランドにヒット）・
"銀行"（104ブランドにヒット）のような一般名詞1語のクエリが、たまたま多数の
ブランド名の部分文字列になっているというだけで大量の（無意味な）候補を
生成してしまうケースが見つかった（AIへの送信トークン増加・候補ノイズによる
判定精度への悪影響の両面で問題）。「1つの部分文字列が何十件ものブランドに
ヒットする＝そのクエリ単体では実質的に絞り込みになっていない」という事実を
そのまま閾値として使い、build_index()構築後にヒット件数がmax_substring_matches
を超えるキーをsubstring_indexから間引く。実データでの検証（実行ログ・
project memory参照）:
- 閾値3でも、ランダムサンプリングした実ブランド名+支店名のクエリ300件は
  1件も候補から消失しなかった（正常系は無傷）。これは、"アパ"→"アパホテル"の
  ような**登録済みの略称**はBRAND_SYNONYMSの中で完全一致するためwhole_forms
  （方向1）経由でヒットし、substring_indexの間引きの影響を受けないため。
  影響を受けるのは「たまたま偶然一致しただけの、識別力のない断片」だけ。
- whole_forms（方向1）は間引かない。ブランドの公式名・別名として登録された
  完全一致なので、この種の「一般名詞が大量ヒット」問題自体が原理的に起きない。
"""

from dataclasses import dataclass, field

from lib import brand_data
from lib.jp_prefectures import PREFECTURES
from lib.kana_match import normalize_variants

# substring_index（方向2）のキーがヒットするブランド数の上限。これを超えるキーは
# 「一般名詞が偶然たくさんのブランド名に含まれているだけ」とみなして間引く
# （build_index()のモジュールdocstring参照。2026-08-29実データ検証で3を採用）。
DEFAULT_MAX_SUBSTRING_MATCHES = 3

# クエリ全体が都道府県名(正式名称またはサフィックス省略形)と完全一致する場合、
# substring_index（方向2、「クエリ自体がブランド名の一部分」）の参照をスキップする
# （2026-08-30、project memory参照）。
#
# 背景: 「富山」「山形」のような都道府県名の省略形クエリが、「富山銀行」
# 「山形銀行」のような無関係な地方銀行ブランド名の部分文字列にたまたま一致し、
# brand_poiへ誤誘導される実データ上のバグが見つかった。地方銀行ブランド自体は
# データから削除した（BRAND_CATEGORY_MAP参照）が、都道府県名を含むブランドは
# 銀行以外にも存在する(例: "東京電力"に対する"東京"、"大阪王将"に対する"大阪")。
# 都道府県は47件の閉じた集合なので、機械的に確実に除外できる。
#
# 方向1(whole_forms、ブランド名がまるごとクエリに埋め込まれているケース)は
# この除外の対象外: 都道府県名自体が正式なブランド名・別名として登録されている
# ような場合（例: "北海道"がBRAND_CATEGORY_MAPのキーそのもの）は、これまで通り
# 拾える。影響を受けるのは「クエリが地名の断片に過ぎず、ブランド名の前方一致に
# 偶然引っかかっただけ」というケースだけ。
def _build_administrative_place_names() -> frozenset[str]:
    names = set()
    for full_name, _lat, _lon, _romaji in PREFECTURES:
        names.add(full_name)
        if full_name != "北海道":
            names.add(full_name[:-1])  # 都/府/県を1文字落とした省略形
    return frozenset(names)


ADMINISTRATIVE_PLACE_NAMES: frozenset[str] = _build_administrative_place_names()


@dataclass
class BrandMatchIndex:
    min_len: int
    whole_forms: dict[str, set[str]] = field(default_factory=dict)
    substring_index: dict[str, set[str]] = field(default_factory=dict)


def _all_substrings(s: str, min_len: int):
    n = len(s)
    for start in range(n):
        for end in range(start + min_len, n + 1):
            yield s[start:end]


def build_index(
    brand_map: dict[str, list[str]] | None = None,
    synonyms: dict[str, list[str]] | None = None,
    min_len: int = 2,
    max_substring_matches: int = DEFAULT_MAX_SUBSTRING_MATCHES,
) -> BrandMatchIndex:
    """BRAND_CATEGORY_MAP（既定）とBRAND_SYNONYMS（既定）からインデックスを構築する。
    引数を渡せばテスト用の別データセットでも構築できる。

    max_substring_matches: substring_index（方向2）の1キーがヒットしてよい
    ブランド数の上限。これを超えるキーは間引く（モジュールdocstring参照。
    "ホテル"/"銀行"のような一般名詞1語が大量の無関係なブランドにヒットする
    問題への対策）。Noneを渡すと間引きを無効化する（テスト・検証用）。"""
    if brand_map is None:
        brand_map = brand_data.BRAND_CATEGORY_MAP
    if synonyms is None:
        synonyms = brand_data.BRAND_SYNONYMS

    idx = BrandMatchIndex(min_len=min_len)
    for canonical in brand_map:
        source_strings = [canonical] + synonyms.get(canonical, [])
        for s in source_strings:
            if len(s) < min_len:
                continue
            for form in normalize_variants(s):
                if len(form) < min_len:
                    continue
                idx.whole_forms.setdefault(form, set()).add(canonical)
                for sub in _all_substrings(form, min_len):
                    idx.substring_index.setdefault(sub, set()).add(canonical)

    if max_substring_matches is not None:
        for key in [k for k, v in idx.substring_index.items() if len(v) > max_substring_matches]:
            del idx.substring_index[key]

    return idx


def find_candidates(query: str, idx: BrandMatchIndex) -> set[str]:
    """クエリに対して機械的にマッチするブランド名（BRAND_CATEGORY_MAPのキー）の
    集合を返す（順不同・recall優先で広めに拾う。最終判断はLLMの検証に委ねる想定）。"""
    if not query or len(query) < idx.min_len:
        return set()

    candidates: set[str] = set()
    query_forms = normalize_variants(query)
    is_bare_place_name = query.strip() in ADMINISTRATIVE_PLACE_NAMES

    for qform in query_forms:
        if len(qform) < idx.min_len:
            continue
        # 方向2: クエリ自体がブランド名の一部分（プレフィックス等）→ O(1)照合
        # ただし、クエリ全体が都道府県名と完全一致する場合はスキップする
        # （ADMINISTRATIVE_PLACE_NAMES参照。地名の断片がたまたま無関係な
        # ブランド名の部分文字列に一致するノイズを構造的に防ぐ）。
        if not is_bare_place_name:
            hit = idx.substring_index.get(qform)
            if hit:
                candidates.update(hit)
        # 方向1: クエリの中にブランド名の変換形がまるごと埋め込まれている
        # → クエリ側の部分文字列を生成してO(1)照合
        for sub in _all_substrings(qform, idx.min_len):
            hit = idx.whole_forms.get(sub)
            if hit:
                candidates.update(hit)

    return candidates
