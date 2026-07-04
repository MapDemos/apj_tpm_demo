# Geonator JS主導アーキテクチャ 処理フロー詳細

**作成日**: 2026-07-04

---

## フロー詳細テーブル

| ステップ | 担当 | 内容 | インプット（例） | アウトプット（例） | 使用クエリ | 使用評価ツール |
|---|---|---|---|---|---|---|
| **[1] ユーザー自由入力** | JS (UI) | テキストエリアで探索依頼を受け付ける | — | `"西大島駅近くのマンション、バス停が目の前、ローソンがすぐ隣"` | なし | なし |
| **[2] クエリ解析** | **LLM (L1)** | ユーザーテキスト → QuerySchema に変換 | `"西大島駅近くのマンション、バス停が目の前、ローソンがすぐ隣"` | QuerySchema JSON（下記参照） | なし | なし |
| **[3-A] 一次検索: proximity確定** | JS | QuerySchema.proximity.typeに応じてAPI呼び出し→bbox確定 | `{"type":"station","text":"西大島駅"}` | `{proximity:[139.826,35.689], bbox:[139.820,35.685,139.832,35.694]}` | Search Box API + Tilequery(streets-v8, transit_stop_label, radius=500) + compute_bbox_from_points | なし |
| **[3-A'] 一次検索: 曖昧さ解消** | JS + ユーザー | 複数locality候補をボタンUI表示 → ユーザーが選択（LLM不使用） | Search Boxから`["台東区入谷", "足立区入谷"]`が返った | ユーザーが選択した1件のbbox | なし | なし |
| **[3-B] Step1: 候補洗い出し** | JS | target + conditions[] をbbox内で並列クエリ実行 | QuerySchema + bbox | メイン候補リスト + 条件候補リスト（下記参照） | ・マンション: Tilequery(streets-v8, poi_label, グリッド) ・バス停(カテゴリ): Tilequery(streets-v8, transit_stop_label, mode=bus) ・ローソン: Search Box + Tilequery(streets-v8, poi_label) ・道路: Tilequery(streets-v8, road, class=primary/secondary) ・水域: Tilequery(streets-v8, water/waterway) | なし |
| **[3-C] Step1: 型確認** | **LLM (L2)** | メイン候補から探索対象に明らかに合わないIDを返す（ネガティブフィルタ） | `target="マンション"`, `candidates=[{id:1,name:"felice西大島"},{id:2,name:"春樹"},{id:3,name:"羅漢寺"},...]` | `{"exclude_ids":[2,3,7,12]}` | なし | なし |
| **[3-D] Step2: 候補評価** | JS | メイン候補(L2除外後) × 各条件をevaluate_distanceで並列評価。conditionTrackerでfull/partial決定 | メイン候補リスト + 条件候補リスト + 各levelパラメータ | `{full:["felice西大島","ハイツかわさか"], partial:["AXAS西大島Sta."]}` | なし | evaluate_distance(proximity_level, anchor, candidates) |
| **[4] 結果表示** | JS | 全一致/部分一致を地図表示。unsupportedがあれば固定テキスト。フィードバックボタン表示 | full/partial候補リスト + unsupportedリスト | 地図マーカー + 固定テキスト「〇件見つかりました」 | なし | なし |
| **[5] フィードバック受付** | JS + ユーザー | ボタン3種を表示してユーザー選択を待つ | — | `"done"` / `"continue"` / `"restart"` | なし | なし |
| **[6-1] 終了** | JS | 固定テキスト表示 → [1]の状態に戻す | `"done"` | `"ありがとうございました。またお気軽にご相談ください。"` | なし | なし |
| **[6-2a] 継続: 追加ヒント受付** | JS + ユーザー | 固定テキストで追加ヒントを要求。テキストエリア表示 | `"continue"` | 追加ヒントテキスト `"南口側です"` | なし | なし |
| **[6-2b] 継続: 新QuerySchema生成** | **LLM (L1再実行)** | （元クエリ + 追加ヒント）→ 新QuerySchema | `元: "西大島駅近くのマンション..."` + `追加: "南口側です"` | 新QuerySchema（proximity.subtype.exit等が更新される） | なし | なし |
| **[6-2c] 継続: [3-A]からやり直し** | JS | 新QuerySchemaで[3-A]以降を全て再実行 | 新QuerySchema | [3-A]〜[4]と同じ | [3-B]と同じクエリ | [3-D]と同じ |
| **[6-3] やり直し** | JS | 全状態リセット → [1]の状態に戻す | `"restart"` | 初期画面（[6-1]と同じ） | なし | なし |

---

## [2] QuerySchema出力例

```json
{
  "proximity": {
    "type": "station",
    "text": "西大島駅",
    "subtype": { "exit": null }
  },
  "target": {
    "type": "residential_building",
    "text": "マンション",
    "query_intent": "category_building"
  },
  "conditions": [
    {
      "type": "category_busstop",
      "text": "バス停",
      "query_intent": "category_busstop_location",
      "level": "adjacent"
    },
    {
      "type": "poi",
      "text": "ローソン",
      "query_intent": "specific",
      "level": "adjacent"
    }
  ],
  "unsupported": []
}
```

---

## [3-B] Step1 候補洗い出し アウトプット例

```json
{
  "main_candidates": [
    { "id": 1, "name": "felice西大島",        "lat": 35.6893, "lng": 139.8260 },
    { "id": 2, "name": "春樹（飲食店）",      "lat": 35.6891, "lng": 139.8261 },
    { "id": 3, "name": "羅漢寺",              "lat": 35.6889, "lng": 139.8258 },
    { "id": 4, "name": "AXAS西大島Sta.",      "lat": 35.6895, "lng": 139.8263 }
  ],
  "condition_candidates": {
    "バス停": [
      { "id": 10, "name": null, "lat": 35.6894, "lng": 139.8269 },
      { "id": 11, "name": null, "lat": 35.6887, "lng": 139.8265 }
    ],
    "ローソン": [
      { "id": 20, "name": "ローソン西大島駅前店",      "lat": 35.6896, "lng": 139.8261 },
      { "id": 21, "name": "ローソン大島四丁目明治通店", "lat": 35.6887, "lng": 139.8267 }
    ]
  }
}
```

---

## [3-D] Step2 評価の流れ（例）

```
evaluate_distance(
  proximity_level = "adjacent",   ← "バス停が目の前"
  anchor = felice西大島 の座標,
  candidates = バス停リスト
) → inside: [バス停id:10]

evaluate_distance(
  proximity_level = "adjacent",   ← "ローソンがすぐ隣"
  anchor = felice西大島 の座標,
  candidates = ローソンリスト
) → inside: [ローソンid:20]

→ conditionTracker: felice西大島 が2/2条件クリア → match_level = "full"
```

---

## [3-A] proximity確定の分岐

| proximity.type | API呼び出し | 出力 |
|---|---|---|
| `station`（出口なし） | Search Box → 駅座標 → Tilequery(transit_stop_label, radius=500) → compute_bbox_from_points(全出口) | bbox |
| `station`（出口あり） | Search Box → 駅座標 → Tilequery(transit_stop_label, radius=400) → 出口座標特定 | 出口座標 + radius_meters |
| `poi` | Search Box → 座標 | 座標 + radius_meters |
| `address` | Search Box → 座標 | 座標 + radius_meters |
| `locality` | Search Box → locality bbox | bbox（そのまま） |
| `route_between` | Search Box × 2 → get_midpoint_area(A, B) | bbox |
| `landmark_bearing` | Search Box → ランドマーク座標 → compute_area_from_landmark_bearing | bbox |

---

## L2型確認の適用範囲

| target.type | L2必要か | 理由 |
|---|---|---|
| `residential_building` | **必要** | Tilequeryが飲食店・寺・事務所等のノイズを大量に返す |
| `commercial_building` | **必要** | 同上 |
| `general_poi` | **必要** | Search Box + TilequeryはフィルタがL2なしでは不完全 |
| `category_busstop` | 不要 | transit_stop_labelのmode=busで既にバス停のみ |
| `category_busstop_name` | 不要 | バス停タイルセットはバス停のみ |
| 交差点 / 信号 / 水域 / 道路 | 不要 | API側でlayer/classフィルタが完全に機能 |
