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
"""

from dataclasses import dataclass, field

from lib import brand_data
from lib.kana_match import normalize_variants


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
) -> BrandMatchIndex:
    """BRAND_CATEGORY_MAP（既定）とBRAND_SYNONYMS（既定）からインデックスを構築する。
    引数を渡せばテスト用の別データセットでも構築できる。"""
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
    return idx


def find_candidates(query: str, idx: BrandMatchIndex) -> set[str]:
    """クエリに対して機械的にマッチするブランド名（BRAND_CATEGORY_MAPのキー）の
    集合を返す（順不同・recall優先で広めに拾う。最終判断はLLMの検証に委ねる想定）。"""
    if not query or len(query) < idx.min_len:
        return set()

    candidates: set[str] = set()
    query_forms = normalize_variants(query)

    for qform in query_forms:
        if len(qform) < idx.min_len:
            continue
        # 方向2: クエリ自体がブランド名の一部分（プレフィックス等）→ O(1)照合
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
