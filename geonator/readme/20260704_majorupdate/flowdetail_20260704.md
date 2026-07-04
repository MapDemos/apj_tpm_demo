# Geonator JS主導アーキテクチャ 処理フロー詳細

**作成日**: 2026-07-04
**バージョン**: 2.0
**位置づけ**: `systemdesign_20260704.md` のステップ別詳細。担当（JS/LLM）・入出力・使用APIを1行ずつ確定させる。用語・数値の正は systemdesign を参照。

---

## フロー詳細テーブル

| ステップ | 担当 | 内容 | インプット（例） | アウトプット（例） | 使用API/クエリ | 使用評価ツール |
|---|---|---|---|---|---|---|
| **[1] 自由入力** | JS(UI) | テキストエリアで探索依頼を受付 | — | `"西大島駅近くのマンション、バス停が目の前、ローソンがすぐ隣"` | なし | なし |
| **[2] L1 クエリ解析** | **LLM** | テキスト→QuerySchema（＋QE＋specificity＋method振り分け） | 上記テキスト | QuerySchema JSON（下記） | なし | なし |
| **[2'] schema検証(A)** | JS | 構造検証（target個数・必須・enum・distance整合）。不備→明確化 | QuerySchema | OK / 明確化イベント | なし | なし |
| **[2''] L1出力バリデート(II)** | JS | enum/必須/型チェック。失敗→L1を1回リトライ→固定文 | QuerySchema | 検証済みschema | なし | なし |
| **[3-A] 一次: proximity解決** | JS | anchors[]を解決しbase bbox確定（1点→中心+radius / N≥2→span） | `anchors:[{type:"station",text:"西大島駅"}]` | `bbox:[139.820,35.685,139.832,35.694]` | Search Box + Tilequery(transit_stop_label,entrance) + resolveBBox | なし |
| **[3-A1] B1 generic足切り** | JS | 唯一のアンカーがgeneric→明確化(Mode2) | `specificity:"generic"` かつ他に一意アンカーなし | 明確化イベント | なし（API前） | なし |
| **[3-A2] B2 同名解決(L3)** | JS+ユーザー | Search Boxが複数localityを返す→context差で判別→ボタン | `["台東区入谷","足立区入谷"]` | 選択1件のbbox | Search Box | なし |
| **[3-A3] 方角カット** | JS | bearing_filterがあればbaseбboxを半分カット | `bearing_filter:"north"` | 北半分のbbox | なし | なし |
| **[3-A4] 二重bbox確定** | JS | target収集bbox=③ / condition収集bbox=③+max(距離) | base bbox + conditions[] | `{targetBbox, conditionBbox}` | なし | なし |
| **[3-B] Step1 候補洗い出し** | JS | targetを③で、conditionsを④で並列収集 | schema + 2つのbbox | メイン候補 + 条件候補（下記） | §8-3のクエリ種別ごとAPI | なし |
| **[3-B1] ノイズ除去** | JS+**LLM** | 前方一致→L2ネガティブフィルタ→dedup（全候補一律・B） | `candidates=[{id,name}...]` | `exclude_ids:[...]` 反映後の候補 | なし | なし |
| **[3-C] Step2 距離評価** | JS | メイン候補×各conditionをevaluate_distance。isochroneはアンカー×level単位で1回(FF) | メイン候補 + 条件候補 + distance | `{full:[...],partial:[...],none:[...]}` | Isochrone API（isochrone時） | evaluate_distance |
| **[3-C1] 条件0件注記(S)** | JS | エリア内に0件のconditionを注記 | 条件候補が空 | 「〇〇はエリア内に見つからず」 | なし | なし |
| **[4] 結果表示** | JS | 全マッチ/部分マッチ/参考を全て地図表示（上限なし）。条件一致内訳＋unsupported固定文 | 3分類候補 + unsupported | マーカー + 固定文「〇件見つかりました…」 | なし | なし |
| **[4-L] 0件分岐** | JS | メイン0件→場所を聞く / メインあり条件0→参考表示（L） | 分類結果 | 固定文＋導線 | なし | なし |
| **[5] フィードバック** | JS+ユーザー | ボタン3種 | — | `done`/`continue`/`restart` | なし | なし |
| **[6-1] 確定** | JS | 固定文→[1]へ | `done` | 「ありがとうございました…」 | なし | なし |
| **[6-2a] 継続:ヒント受付** | JS+ユーザー | 固定文でヒント要求 | `continue` | 追加テキスト`"南口側です"` | なし | なし |
| **[6-2b] L1再実行** | **LLM** | （元クエリ＋追加ヒント）を全文再翻訳→新schema | `元 + "南口側です"` | 新QuerySchema | なし | なし |
| **[6-2c] キャッシュ差分破棄(K)** | JS | 変更箇所の依存先だけ破棄し該当ステップから再実行 | 新旧schema差分 | 再実行範囲の決定 | 再実行分のみ | 再実行分のみ |
| **[6-3] やり直し** | JS | 全状態リセット→[1]へ | `restart` | 初期画面 | なし | なし |

---

## [2] QuerySchema 出力例

```json
{
  "proximity": {
    "anchors": [
      { "type": "station", "text": "西大島駅", "specificity": "specific", "subtype": { "exit": null } }
    ],
    "bearing_filter": null
  },
  "target": {
    "type": "residential_building",
    "text": "マンション",
    "query_intent": "category_building"
  },
  "conditions": [
    {
      "type": "category_busstop", "text": "バス停", "query_intent": "specific",
      "distance": { "method": "radius", "level": "adjacent", "profile": null, "minutes": null, "meters": null }
    },
    {
      "type": "poi", "text": "ローソン", "query_intent": "specific",
      "distance": { "method": "radius", "level": "adjacent", "profile": null, "minutes": null, "meters": null }
    }
  ],
  "unsupported": []
}
```

**method振り分けの例:**
- 「バス停が目の前」→ `method:"radius", level:"adjacent"`（50m circle）
- 「駅から歩いて10分のコンビニ」→ `method:"isochrone", profile:"walking", minutes:10`
- 「車で5分のホテル」→ `method:"isochrone", profile:"driving", minutes:5`
- 「500m以内の公園」→ `method:"radius", meters:500`
- 「近くにセブン」（距離語なし）→ JSが `level:"very_close"` で補完

---

## [3-B] Step1 候補洗い出し 出力例

```json
{
  "main_candidates": [
    { "id": 1, "name": "felice西大島", "lat": 35.6893, "lng": 139.8260 },
    { "id": 2, "name": "春樹（飲食店）", "lat": 35.6891, "lng": 139.8261 },
    { "id": 4, "name": "AXAS西大島Sta.", "lat": 35.6895, "lng": 139.8263 }
  ],
  "condition_candidates": {
    "バス停": [
      { "id": 10, "name": null, "lat": 35.6894, "lng": 139.8269 }
    ],
    "ローソン": [
      { "id": 20, "name": "ローソン西大島駅前店", "lat": 35.6896, "lng": 139.8261 }
    ]
  }
}
```

- メイン候補はL2で「明らかに対象外」（春樹＝飲食店等）を保守的に除外。
- 条件候補「ローソン」は前方一致で「ローソン〜」以外を除去済み。

---

## [3-C] Step2 評価の流れ（例）

```
# アンカー×level単位で isochrone/circle を1回計算し使い回す(FF)

evaluate_distance(distance={method:"radius",level:"adjacent"},  ← "バス停が目の前"
  anchor = felice西大島, candidates = バス停リスト) → inside:[10]

evaluate_distance(distance={method:"radius",level:"adjacent"},  ← "ローソンがすぐ隣"
  anchor = felice西大島, candidates = ローソンリスト) → inside:[20]

→ conditionTracker: felice西大島 = 2/2 → full
→ AXAS西大島Sta. = 0/2 → none（参考として表示・O）
```

---

## [3-A] proximity解決の分岐（AA・C-2）

| 状況 | API/処理 | 出力 |
|---|---|---|
| anchors=1・station（出口なし） | Search Box→駅座標→Tilequery(entrance全出口)→resolveBBox(span) | bbox |
| anchors=1・station（出口あり） | 上記→名称一致出口を特定→座標+radius | bbox |
| anchors=1・poi/address | Search Box→座標+radius（§6距離） | bbox |
| anchors=1・locality | Search Box→localityбbox（同名複数→B2ボタン） | bbox |
| anchors≥2（旧route_between含む） | 各anchorをSearch Box→resolveBBox(span, N点) | bbox（上限超過→pushback） |
| bearing_filter付き | 上記bbox→方角カット | 半分bbox |

---

## L2ネガティブフィルタの適用範囲（B・改訂）

| 候補種別 | L2 | 備考 |
|---|---|---|
| residential_building / commercial_building / general_poi | **適用（実質的に必要）** | Tilequery/Search Boxがノイズを大量に返す |
| category_busstop / 交差点 / 信号 / 水域 / 道路 | **一律適用（空振り可）** | API側フィルタで既に均質だが、実装単純化のため全候補一律でLLMに並行チェックさせる |

※旧v1.0の「バス停・交差点等はL2不要」テーブルは破棄。ノイズ除去は全クエリ結果に一律（前方一致＋L2＋dedup）。
