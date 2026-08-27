"""
列追加系のサブコマンド（dedup/add-query-count の "same_query_count"、
ai-classify の "ai_classification"）が共有する、列名の衝突回避ロジック。

既にAI分類済み・カウント済みのCSVを誤って同じサブコマンドにもう一度通した場合、
入力に同名の列が既に存在していることがある。その場合に上書きしたり
DictWriterで列名が重複してエラーになったりしないよう、_2, _3 ... と
連番を振ってユニークな列名を作る。
"""


def unique_column_name(fieldnames: list[str], base_name: str) -> str:
    """fieldnames に base_name が無ければそのまま返す。既にあれば
    base_name_2, base_name_3, ... の中から衝突しない最初の名前を返す。"""
    if base_name not in fieldnames:
        return base_name
    n = 2
    while f"{base_name}_{n}" in fieldnames:
        n += 1
    return f"{base_name}_{n}"


def unique_column_names(fieldnames: list[str], base_names: list[str]) -> list[str]:
    """ai_classify系が使う。ai_classification/_2/_3のように、名前自体に既に
    "_2","_3"という連番が含まれる複数列をまとめて衝突回避するための版。

    unique_column_name()を3列それぞれに個別適用すると、"ai_classification_2"
    "ai_classification_3"という正規の列名自体が「_2 = 2回目の衝突回避」だと
    誤認識され、無関係な列(ai_classification)まで"ai_classification_4"に
    リネームされてしまう。これを避けるため、base_names全体をまとめて1つの
    グループとして扱い、いずれか1つでも衝突していれば全員に同じ連番接尾辞
    (base_names[i] + f"_{n}") を付けて返す。衝突が無ければbase_namesをそのまま返す。"""
    if not any(name in fieldnames for name in base_names):
        return list(base_names)
    n = 2
    while any(f"{name}_{n}" in fieldnames for name in base_names):
        n += 1
    return [f"{name}_{n}" for name in base_names]
