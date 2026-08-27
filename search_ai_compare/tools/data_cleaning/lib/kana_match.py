"""
カタカナ/ひらがな/ローマ字という表記体系をまたいだ部分一致判定のためのユーティリティ。

背景: BRAND_CATEGORY_MAP（ブランド名→taxonomyリーフ）に対してクエリを機械的に
部分一致させたい（brand-poi判定のためHaikuに渡す候補を絞り込む用途、
project memory参照）。しかし「アパホテル」というブランドに対して、クエリ側は
「アパ」「あぱ」「apa」のように表記体系が変わって出現することがある。これは
不規則な略称（スタバ→スターバックス等、機械的には拾えない）ではなく、多くの場合
ブランド名の先頭部分（プレフィックス）がそのまま別の表記体系で書かれているだけ
なので、カタカナ/ひらがな/ローマ字の3体系に変換してから部分一致を取れば機械的に
拾える。

対応範囲: カタカナのみで構成された文字列（loanword系のブランド名で多い）を対象に、
ひらがな化・ローマ字化を行う。漢字を含む文字列は読みが一意に決まらないため
（吉野家→よしのや、等は辞書が無いと導出できない）、ローマ字化・ひらがな化は
スキップし、原文の文字列一致にのみ頼る（find_variant_matchesが自動でこの判定を行う）。
"""

import re
import unicodedata

# 全角カタカナ(ァ-ヶ, U+30A1-30F6)⇔ひらがな(ぁ-ゖ, U+3041-3096)は
# Unicode上0x60の固定オフセットで対応している。
_KATA_START, _KATA_END = 0x30A1, 0x30F6
_KATA_TO_HIRA_OFFSET = 0x60


def to_hiragana(s: str) -> str:
    """カタカナをひらがなに変換する（他の文字はそのまま）。"""
    out = []
    for ch in s:
        code = ord(ch)
        if _KATA_START <= code <= _KATA_END:
            out.append(chr(code - _KATA_TO_HIRA_OFFSET))
        else:
            out.append(ch)
    return "".join(out)


def to_katakana(s: str) -> str:
    """ひらがなをカタカナに変換する（他の文字はそのまま）。"""
    out = []
    for ch in s:
        code = ord(ch)
        if _KATA_START - _KATA_TO_HIRA_OFFSET <= code <= _KATA_END - _KATA_TO_HIRA_OFFSET:
            out.append(chr(code + _KATA_TO_HIRA_OFFSET))
        else:
            out.append(ch)
    return "".join(out)


_KANJI_RE = re.compile(r"[一-鿿]")


def has_kanji(s: str) -> bool:
    return bool(_KANJI_RE.search(s))


# ひらがな→ローマ字（ヘボン式に近い簡易テーブル）。
# 2文字の拗音(きゃ等)を先にマッチさせる必要があるため、キーを長い順に並べてから
# 正規表現化する。ローマ字化はカタカナ語ブランド名を主対象にしているため、
# 拗音・長母音・撥音(ん)・促音(っ)・外来語特有の拡張拍(ふぁ/てぃ等)を含めた
# 実用範囲を優先し、歴史的仮名遣い等の網羅性は求めない。
_MORA_TABLE = {
    # 拗音（2文字, 濁音含む）
    "きゃ": "kya", "きゅ": "kyu", "きょ": "kyo",
    "しゃ": "sha", "しゅ": "shu", "しょ": "sho",
    "ちゃ": "cha", "ちゅ": "chu", "ちょ": "cho",
    "にゃ": "nya", "にゅ": "nyu", "にょ": "nyo",
    "ひゃ": "hya", "ひゅ": "hyu", "ひょ": "hyo",
    "みゃ": "mya", "みゅ": "myu", "みょ": "myo",
    "りゃ": "rya", "りゅ": "ryu", "りょ": "ryo",
    "ぎゃ": "gya", "ぎゅ": "gyu", "ぎょ": "gyo",
    "じゃ": "ja", "じゅ": "ju", "じょ": "jo",
    "びゃ": "bya", "びゅ": "byu", "びょ": "byo",
    "ぴゃ": "pya", "ぴゅ": "pyu", "ぴょ": "pyo",
    # 外来語特有の拡張拍
    "ふぁ": "fa", "ふぃ": "fi", "ふぇ": "fe", "ふぉ": "fo",
    "てぃ": "ti", "でぃ": "di", "とぅ": "tu", "どぅ": "du",
    "うぃ": "wi", "うぇ": "we", "うぉ": "wo",
    "ゔぁ": "va", "ゔぃ": "vi", "ゔ": "vu", "ゔぇ": "ve", "ゔぉ": "vo",
    "つぁ": "tsa", "つぃ": "tsi", "つぇ": "tse", "つぉ": "tso",
    "しぇ": "she", "じぇ": "je", "ちぇ": "che",
    # 基本音（濁音・半濁音含む）
    "あ": "a", "い": "i", "う": "u", "え": "e", "お": "o",
    "か": "ka", "き": "ki", "く": "ku", "け": "ke", "こ": "ko",
    "さ": "sa", "し": "shi", "す": "su", "せ": "se", "そ": "so",
    "た": "ta", "ち": "chi", "つ": "tsu", "て": "te", "と": "to",
    "な": "na", "に": "ni", "ぬ": "nu", "ね": "ne", "の": "no",
    "は": "ha", "ひ": "hi", "ふ": "fu", "へ": "he", "ほ": "ho",
    "ま": "ma", "み": "mi", "む": "mu", "め": "me", "も": "mo",
    "や": "ya", "ゆ": "yu", "よ": "yo",
    "ら": "ra", "り": "ri", "る": "ru", "れ": "re", "ろ": "ro",
    "わ": "wa", "ゐ": "i", "ゑ": "e", "を": "o", "ん": "n",
    "が": "ga", "ぎ": "gi", "ぐ": "gu", "げ": "ge", "ご": "go",
    "ざ": "za", "じ": "ji", "ず": "zu", "ぜ": "ze", "ぞ": "zo",
    "だ": "da", "ぢ": "ji", "づ": "zu", "で": "de", "ど": "do",
    "ば": "ba", "び": "bi", "ぶ": "bu", "べ": "be", "ぼ": "bo",
    "ぱ": "pa", "ぴ": "pi", "ぷ": "pu", "ぺ": "pe", "ぽ": "po",
    # 小書き文字単独（通常は促音・拗音の一部として処理されるが、単独出現の保険）
    "ぁ": "a", "ぃ": "i", "ぅ": "u", "ぇ": "e", "ぉ": "o",
    "ゃ": "ya", "ゅ": "yu", "ょ": "yo",
}
# 長いキー（拗音・拡張拍）を先に試すため、キー長の降順でソートしてから正規表現化する。
_MORA_RE = re.compile("|".join(sorted(_MORA_TABLE, key=len, reverse=True)))


def hiragana_to_romaji(s: str) -> str:
    """ひらがな文字列をローマ字（簡易ヘボン式）に変換する。
    促音(っ)は次の子音を重ねる。長音符(ー)は直前の母音を伸ばす代わりに
    そのまま母音を1つ追加する（'aa'のように長母音として表現し、部分一致の
    判定には支障がない簡易処理にとどめる）。カタカナ→ひらがな変換は
    to_hiragana()で事前に済ませてから渡すこと。"""
    out = []
    i = 0
    n = len(s)
    while i < n:
        ch = s[i]
        if ch == "っ" and i + 1 < n:
            # 促音: 次の拍のローマ字表記の最初の子音を重ねる
            m = _MORA_RE.match(s, i + 1)
            if m:
                next_romaji = _MORA_TABLE[m.group()]
                first_char = next_romaji[0]
                if first_char != "a" and first_char not in "aeiou":
                    out.append(first_char)
                i += 1
                continue
            i += 1
            continue
        if ch == "ー":
            # 長音符: 直前の母音を継続する（簡易的に直前の母音字を1つ追加）
            if out and out[-1]:
                out.append(out[-1][-1])
            i += 1
            continue
        m = _MORA_RE.match(s, i)
        if m:
            out.append(_MORA_TABLE[m.group()])
            i += len(m.group())
            continue
        # テーブルに無い文字（漢字・英数字・記号等）はそのまま残す
        out.append(ch.lower())
        i += 1
    return "".join(out)


def normalize_variants(s: str) -> set[str]:
    """文字列を{原文(NFKC小文字), ひらがな形, カタカナ形, ローマ字形}の集合に変換する。
    漢字を含む場合はひらがな化・ローマ字化ができない（読みが一意に決まらない）ため、
    原文のみを返す。"""
    if not s:
        return set()
    raw = unicodedata.normalize("NFKC", s).lower()
    if has_kanji(raw):
        return {raw}
    hira = to_hiragana(raw)
    kata = to_katakana(raw)
    romaji = hiragana_to_romaji(hira)
    return {v for v in {raw, hira, kata, romaji} if v}


def variant_contains(a: str, b: str, min_len: int = 2) -> bool:
    """aとbのいずれかの表記体系の変換形どうしで、部分文字列関係（どちらかが
    どちらかを含む）が成立するかを判定する。min_len未満の短い文字列同士は
    誤検出（無関係な文字列への偶然の部分一致）が多発するため対象外にする。"""
    if len(a) < min_len or len(b) < min_len:
        return False
    va, vb = normalize_variants(a), normalize_variants(b)
    for x in va:
        if len(x) < min_len:
            continue
        for y in vb:
            if len(y) < min_len:
                continue
            if x in y or y in x:
                return True
    return False
