# Geonator JS主導アーキテクチャ 概要設計書

**作成日**: 2026-07-04  
**バージョン**: 1.0 (概要設計フェーズ)

---

## 1. ツールの目的

Geonatorは、曖昧な自然言語の説明（「西大島駅近くのマンション、バス停が目の前、ローソンがすぐ隣」等）から位置を特定するAIエージェントツールである。緊急通報オペレーター支援デモとして使用される。

**優先事項**:
- 精度・網羅性（候補の見逃しは過検出より危険）
- 安定性・再現性（同じ入力には同じ結果）
- コスト効率（不要なLLM呼び出しを排除）

---

## 2. 設計思想

### 2-1. LLMとJSの役割分担

| 担当 | 役割 |
|---|---|
| **JS** | フロー制御、APIコール実行、計算処理、UI制御、固定テキスト表示 |
| **LLM** | 意味解釈のみ（3箇所のみ呼び出し） |

**LLMは以下の3箇所でのみ呼ばれる：**
- **L1**: ユーザー入力 → QuerySchema（構造化データ）への変換
- **L2**: Step1取得候補 → 探索対象に明らかに合わないIDの除外
- **L3**: 一次検索で複数候補（例：台東区入谷 vs 足立区入谷）→ 選択（ボタンUIで表示、ユーザーが選ぶ）

### 2-2. 設計原則

- **JSがフロー主導**: 現アーキテクチャと逆。LLMはJSから問いかけられたときのみ応答する
- **ユーザーインタラクションの制限**: 自由記入は探索依頼と追加ヒントのみ。その他はボタン選択
- **固定テキスト**: 対話パネルのシステムメッセージはJSが事前定義。LLM生成なし
- **スキーマ駆動**: ユーザー入力はあらかじめ定義されたQuerySchemaに当てはめる。対応外はunsupportedに格納
- **Step1で全候補を網羅**: 探索対象も条件POIも道路も水域も、すべてStep1でbbox内を検索する
- **Step2は純粋な距離評価**: evaluate_distanceのみ。get_facing_roadやscan_natural_featuresは不要

---

## 3. QuerySchema定義

LLMがユーザー入力を変換する構造化データ。JSはこれを元に処理を実行する。

```json
{
  "proximity": {
    "type": "station | poi | address | locality | route_between | landmark_bearing",
    "text": "西大島駅",
    "subtype": {
      "exit": null,
      "from": null,
      "to": null,
      "landmark": null,
      "side": null
    }
  },
  "target": {
    "type": "residential_building | commercial_building | general_poi",
    "text": "マンション",
    "query_intent": "category_building"
  },
  "conditions": [
    {
      "type": "poi | road | water | intersection | signal | transit_entrance",
      "text": "ローソン",
      "query_intent": "specific",
      "level": "adjacent | very_close | nearby | somewhat_nearby | far | same_building"
    },
    {
      "type": "water",
      "text": null,
      "query_intent": null,
      "level": "nearby"
    }
  ],
  "unsupported": []
}
```

### 3-1. proximity サブタイプ

| type | 意味 | bbox確定方法 |
|---|---|---|
| `station` | 駅名（出口あり/なし） | 出口あり→出口座標、出口なし→全出口からcompute_bbox_from_points |
| `poi` | 施設・ランドマーク等 | Search Box → 座標 + radius_meters |
| `address` | 丁目・番地レベル | Search Box → 座標 + radius_meters |
| `locality` | 地名・エリア（入谷等） | Search Box → bboxをそのまま使用 |
| `route_between` | AとBの間 | get_midpoint_area → bbox |
| `landmark_bearing` | ランドマークが左手/右手に見える | compute_area_from_landmark_bearing → bbox |

### 3-2. target の query_intent

| type | query_intent | 使用API |
|---|---|---|
| `residential_building` | `category_building` | Tilequeryグリッド (poi_label) |
| `commercial_building` | `category_building` | Tilequeryグリッド (poi_label) |
| `general_poi` | `specific` | Search Box + Tilequery (poi_label) |

### 3-3. conditions の type と level

**type:**
- `poi`: コンビニ・飲食店・バス停（名称）等
- `road`: 大通り・国道等（road layer）
- `water`: 川・海・湖等（water/waterway layer）
- `intersection`: 交差点（road layer, class=intersection）
- `signal`: 信号機（road layer, class=traffic_signals）
- `transit_entrance`: 駅出口（transit_stop_label, stop_type=entrance）
- `category_busstop`: バス停カテゴリ（transit_stop_label, mode=bus）

**level（evaluate_distanceに渡す）:**
- `same_building`: 同じビルの中（buildingレイヤーID一致）
- `adjacent`: 隣接・目の前・すぐ隣（~50m、turf.circle）
- `very_close`: すぐ近く・出てすぐ（~250m歩き、isochrone 3分）
- `nearby`: 近く・付近・そば（~700m歩き、isochrone 10分）
- `somewhat_nearby`: 少し歩く（~1.4km歩き、isochrone 20分）
- `far`: かなり歩く（距離条件として使わない）

### 3-4. unsupported

LLMがいずれのcondition typeにも当てはめられなかった条件を自由記述で格納する（事前定義なし）。

```json
"unsupported": ["建物の3階にある", "壁が赤い"]
```

JSはunsupportedが空でなければ固定テキストで「以下の条件は現在対応していませんが、他の情報で検索を進めます」と表示する。

---

## 4. 処理フロー

```
[1] ユーザー自由入力（探索依頼テキスト）
     │
     ▼
[2] L1: クエリ解析（LLM）
     テキスト → QuerySchema
     │
     ▼
[3] 一次検索（JS）
     ├─ proximity.type に応じたbbox確定
     ├─ L3: 複数locality候補 → ボタンUI → ユーザーが選択
     └─ bbox確定完了
     │
     ▼
[3] 二次検索: Step1 候補洗い出し（JS）
     ├─ target のクエリ実行 → メイン候補取得
     ├─ conditions[] の各クエリ実行（並列）→ 条件候補取得
     └─ L2: メイン候補をLLMに渡し、探索対象に合わないIDを除外
     │
     ▼
[3] 二次検索: Step2 候補評価（JS）
     ├─ conditions[] × メイン候補を並列でevaluate_distance実行
     ├─ conditionTrackerでfull/partial/除外を機械的に決定
     └─ 評価完了
     │
     ▼
[4] 結果表示（JS）
     ├─ add_candidate_markers（全一致/部分一致）
     ├─ unsupportedがあれば固定テキスト表示
     └─ フィードバックボタン表示
     │
     ▼
[5] ユーザーフィードバック（ボタン選択）
     ├─ 終了 → [6]-1
     ├─ 探索継続 → [6]-2
     └─ やり直し → [6]-3
     │
     ├─ [6]-1: 「ありがとうございました」→ [1]に戻る
     │
     ├─ [6]-2: 追加ヒント要求（固定テキスト）
     │           ↓ ユーザー入力
     │         L1: （元クエリ + 追加ヒント）→ 新QuerySchema
     │           ↓
     │         新しいproximitiが確定している場合、[3]一次検索からやり直し
     │         proximityが同じ場合、[3]二次検索からやり直し
     │         ※キャッシュは使わない（常にやり直し）
     │
     └─ [6]-3: 最初に戻る → [1]に戻る（[6]-1と同じ）
```

---

## 5. ユーザーインタラクション定義

### 5-1. 入力種別

| 入力種別 | タイミング | 形式 |
|---|---|---|
| 探索依頼 | [1] 初回 | 自由記入テキスト |
| 候補選択 | 一次検索で複数候補 | ボタン（最大4件） |
| フィードバック | [5] 結果表示後 | ボタン3種 |
| 追加ヒント | [6]-2 継続時 | 自由記入テキスト |

### 5-2. フィードバックボタン

| ボタン | アクション |
|---|---|
| ✅ これで確定 | [6]-1: 探索終了 |
| 🔄 続けて絞り込む | [6]-2: 追加ヒント入力 |
| 🔁 最初からやり直す | [6]-3: 全リセット |

### 5-3. 固定テキスト一覧

| タイミング | テキスト |
|---|---|
| 起動時 | 「探している場所を教えてください。近くの駅名、施設名、または住所と、条件（近くにあるお店や道路など）を一緒に伝えていただくと絞り込めます。」 |
| 一次検索・曖昧さ | 「〇〇はどちらをお探しですか？」+ ボタン |
| 候補洗い出し中 | 「候補を検索しています...」 |
| 対応不可ヒント | 「以下の条件は現在対応していませんが、他の情報で検索を進めます：〇〇」 |
| 候補表示 | 「〇件見つかりました（全一致：N件、部分一致：M件）」 |
| 0件 | 「条件に合う候補が見つかりませんでした。追加の情報や別の条件をお試しください。」 |
| 継続時 | 「さらに絞り込むための情報を教えてください。（例：出口番号、近くの交差点名、建物の特徴など）」 |
| 確定 | 「ありがとうございました。またお気軽にご相談ください。」 |

---

## 6. LLM呼び出し仕様

### L1: クエリ解析

**タイミング**: [2] ユーザー入力受信後、および [6]-2 追加ヒント受信後

**入力プロンプト（概要）**:
```
ユーザーの説明から以下のJSONを生成してください。
- proximity: だいたいどの辺か（駅・施設・住所・地名等、1つ）
- target: 探したいもの（1つ）
- conditions: 近くにあるもの（複数可）とそれぞれの距離感
- unsupported: 対応できない条件（建物の色等）

[スキーマ定義をここに挿入]

ユーザー入力: 「{入力テキスト}」
```

**出力**: QuerySchema JSON

**特徴**: コンテキスト不要。毎回独立した呼び出し。

---

### L2: 型確認（メイン候補の絞り込み）

**タイミング**: [3] Step1でメイン候補取得後

**入力プロンプト（概要）**:
```
探している対象: {target.text}（{target.type}）
以下の候補のうち、明らかに対象外のIDを列挙してください。
判断が曖昧なものは残してください（見逃しの方が過検出より危険）。

候補:
{id: 1, name: "春樹"}
{id: 2, name: "felice西大島"}
...
```

**出力**:
```json
{ "exclude_ids": [1, 5, 12] }
```

**特徴**:
- コンテキスト不要（候補リストと探索対象だけで判断）
- ネガティブフィルタのみ（ポジティブ選択しない）
- クエリ種別により使い分け：
  - 居住系建物・商業系建物・通常POI → L2を使う
  - バス停・交差点・信号・水域・道路 → L2不要（APIフィルタで十分）

---

### L3: 曖昧さ解消（複数locality候補）

**タイミング**: 一次検索でSearch Boxが複数のlocalityを返した場合のみ

**実装**: `ask_choice` ツールでボタンUIをレンダリング → **ユーザー**が選択 → LLMは不関与

**特徴**: L3は「LLM呼び出し」ではなく「ユーザーへのボタン提示」で解決する。LLMは使わない。

---

## 7. 一次検索詳細（proximityサブタイプ）

### 7-1. station（駅）

**出口指定あり**:
1. Search Box → 駅の代表座標取得
2. Tilequery(streets-v8, transit_stop_label, radius=400) → 出入口取得
3. stop_type="entrance" かつ name が一致 → 出口座標確定
4. 出口座標 + radius_meters → bbox

**出口指定なし**:
1. Search Box → 駅の代表座標取得
2. Tilequery(streets-v8, transit_stop_label, radius=500) → 全出入口取得
3. stop_type="entrance" の全座標 → compute_bbox_from_points → bbox

### 7-2. poi / address

1. Search Box → 座標取得
2. feature_type が place/region/country/district → 広すぎる → 追加情報要求
3. feature_type が locality → bboxをそのまま使用
4. それ以外 → 座標 + radius_meters → bbox

### 7-3. locality（地名・エリア）

1. Search Box → bboxを取得
2. 同名地名が複数 → ボタンUI（L3）→ ユーザー選択 → bboxを使用

### 7-4. route_between（AとBの間）

1. AとBそれぞれSearch Box → 座標取得
2. get_midpoint_area(A, B) → 中間bbox確定

### 7-5. landmark_bearing（ランドマーク方位）

1. Search Box → ランドマーク座標取得
2. compute_area_from_landmark_bearing(landmark, side) → bbox確定

---

## 8. 候補探索（クエリ種別）詳細

Step1でbbox内の全対象を取得する。LLM絞り込み（L2）が必要かどうかで2グループに分かれる。

### 8-1. クエリ種別一覧

| クエリ種別 | API | タイルセット | レイヤー/フィルタ | L2絞り込み |
|---|---|---|---|---|
| 居住系建物（マンション/アパート等） | Tilequery | streets-v8 | poi_label | 必要 |
| 商業系建物（ビル等） | Tilequery | streets-v8 | poi_label | 必要 |
| 通常POI（ホテル/飲食店/コンビニ等） | Search Box + Tilequery | — / streets-v8 | — / poi_label | 必要 |
| バス停（カテゴリ） | Tilequery | streets-v8 | transit_stop_label, mode=bus | 不要 |
| バス停（名称指定） | Tilequery | 10da032y.busstop_gov_0608 | — | 不要 |
| 交差点 | Tilequery | streets-v8 | road, class=intersection | 不要 |
| 信号 | Tilequery | streets-v8 | road, class=traffic_signals | 不要 |
| 駅出口 | Tilequery | streets-v8 | transit_stop_label, stop_type=entrance | 不要 |
| 道路（条件として） | Tilequery | streets-v8 | road, class=primary/secondary等 | 不要 |
| 水域・自然地物 | Tilequery | streets-v8 | water, waterway | 不要 |
| 建物ID確認 | Tilequery | streets-v8 | building | 不要 |

### 8-2. クエリ種別の決定フロー

JSはQuerySchemaの各フィールドを見てクエリ種別を決定する：

```
target.text / target.type → クエリ種別決定
conditions[].type → 各条件のクエリ種別決定
  - type="poi" かつ query_intent → specific/category_busstop等
  - type="road" → road layer
  - type="water" → water layer
  - type="intersection" → road layer, class=intersection
  - type="signal" → road layer, class=traffic_signals
  - type="transit_entrance" → transit_stop_label, stop_type=entrance
  - type="category_busstop" → transit_stop_label, mode=bus
```

---

## 9. 候補評価（ツール）詳細

### 9-1. 評価ツール一覧

Step2では **evaluate_distance のみ** を使う。他の評価ツールはStep1で取得した候補を渡すことで不要になった。

| ツール | 役割 |
|---|---|
| `evaluate_distance` | アンカー候補から探索対象候補が指定距離以内かを判定。proximity_levelに応じてturf.circle（≤50m）またはMapbox Isochrone API（>50m）を内部で使い分ける |

**廃止ツール（Step1でのTilequeryクエリに統合）**:
- `get_facing_road` → 道路をStep1でroadレイヤーから取得、evaluate_distanceで評価
- `scan_natural_features` → 水域をStep1でwaterレイヤーから取得、evaluate_distanceで評価
- `find_intersections` → Step1でroad layer(class=intersection)から取得
- `find_traffic_signals` → Step1でroad layer(class=traffic_signals)から取得

**bbox計算ツール（一次検索用・evaluate_distanceとは別）**:
- `compute_bbox_from_points` → 複数座標（駅出口等）からbboxを計算
- `get_midpoint_area` → AとBの中間bboxを計算
- `compute_area_from_landmark_bearing` → ランドマーク方位からbboxを計算
- これら3つは将来的に1つのbbox計算ツールに統合可能

### 9-2. evaluate_distance の proximity_level マッピング

| ユーザーの表現 | proximity_level | 内部実装 |
|---|---|---|
| 同じビルの中 | same_building | buildingレイヤーID比較 |
| 隣・目の前・すぐ隣 | adjacent | turf.circle(50m) |
| すぐ近く・出てすぐ | very_close | Isochrone 3分 |
| 近く・付近・そば | nearby | Isochrone 10分 |
| 少し歩く | somewhat_nearby | Isochrone 20分 |
| かなり歩く | far | 距離条件として使わない |

### 9-3. match_level の決定（JS機械処理）

```
全conditions[] に対してevaluate_distanceを実行
  ↓
conditionTracker: 各候補が何条件クリアしたかを記録
  ↓
全条件クリア → match_level = "full"
一部クリア → match_level = "partial"
0条件クリア → 除外（表示しない）
```

---

## 10. 未解決事項（ステップ②で確認）

- QuerySchemaのLLMプロンプト詳細設計
- L2型確認のプロンプト詳細設計
- クエリ種別の条件分岐コード設計（JSロジック）
- 既存MapboxMCPClientの流用範囲
- 新旧アーキテクチャの移行計画

---

*このドキュメントはステップ①概要設計の成果物です。ステップ②（実装不明点確認）に進む前に合意を取ること。*
