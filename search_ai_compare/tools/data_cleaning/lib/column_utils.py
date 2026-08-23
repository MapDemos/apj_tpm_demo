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
