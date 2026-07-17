# Geonator — 自然言語ロケーション探索デモ

> 本READMEは **現在のソースコードのみ** を根拠に記述しています（外部情報は参照していません）。設計検討の経緯を記した `doc/` はローカル専用（gitignore対象）のため、このリポジトリには含まれません。

---

## 1. 概要（目的）

Geonator は、**曖昧な自然言語の位置説明**（例：「徳島駅から徒歩5〜10分で、線路沿いのホテル」）を受け取り、Mapbox のデータから **地図上の候補地点を特定してランク表示** するブラウザ完結型のデモです。

- 入力：自由記入の探索依頼（日本語 / 英語）
- 出力：候補地点のリスト＋地図ピン（ティア＝確信度で色分け）、および候補が満たした理由
- 対話：結果に対して「終了 / 更に絞り込む / 条件を足して探し直す」でループ

想定ユースケースは「通報・ヒアリングで得た断片的な場所情報から、実際の座標を絞り込む」ような位置特定支援。

---

## 2. 設計思想 — JS主導型オーケストレーター

このデモの核となる思想は **「JSがオーケストレーター、LLMは意味解釈だけ」** です。

| 担当 | 役割 |
|---|---|
| **JS（`query-engine.js`）** | フロー制御・分岐・数値計算・距離判定・スコアリング・キャッシュ・API呼び出し・UI制御。**すべての数値と文言はJS側が持つ**。 |
| **LLM（Claude）** | 意味解釈のみ。自然言語 → 構造化スキーマ（L1）、候補の妥当性/関連性判定（L2）、確認文（L1-1）、絞り込み目印の提案（L3）。 |
| **外部API（Mapbox / Turf）** | 地理データ取得（Mapbox）と幾何計算（Turf.js）。 |

原則：

- **LLMに数値を計算させない。** 距離のメートル数・分数・スコア・ティア判定はすべてJS（`distance-table.js` / `query-engine.js`）。LLMは「すぐ近く」「徒歩5分」等の *言葉* をスキーマの *ラベル* に変換するだけ。
- **対話パネルのテキストはJS事前定義**（`MESSAGES` in `query-engine.js`、`LANG` in `index.js`）。LLMが日本語UI文言を生成することはない（確認文 L1-1 を除く）。
- **ユーザー入力は事前定義スキーマ（QuerySchema）に当てはめる。** LLMの出力は必ず `validateQuerySchema` で検証し、`fillSchemaDefaults` で既定補完してからJSが解釈する。
- LLMは **L1（解析）と L2（フィルタ）の2箇所が主**。L1-1（確認文）・L3（目印提案）は補助。

---

## 3. アーキテクチャと使用API（何を何に使っているか）

### 3.1 Mapbox API

| API | 用途 | 主な呼び出し元 |
|---|---|---|
| **Search Box API**（`/search/searchbox/v1/forward`） | 固有名・一般POI・地名の前方検索。proximityアンカーの解決、target/条件POIの収集 | `_searchBoxRequest`, `searchBox`, `collectTarget`, `collectCondition` |
| **Tilequery API**（`mapbox.mapbox-streets-v8`） | ベクタタイルへの点問い合わせ。レイヤー別に使い分け（下表） | `_gridTilequeryPOI`, `roadNear`, `railNear`, `waterNear`, `_getBuildingFloors`, `_findIntersections`, `_findTrafficSignals`, `tilequeryTransitEntrances` ほか |
| **Isochrone API**（`/isochrone/v1/mapbox/{profile}`） | 徒歩/自転車/車の n分到達ポリゴン。時間ベースの近接評価、`within`、「n分以上〜n分以内」のドーナツ収集 | `getIsochronePolygon`, `isochroneReach`, `computeWithinReach`, `_filterByIsochrone` |
| **Static Images API**（`/styles/v1/.../static/...`） | 地図OFF時に候補パネルへ差し込む静的地図サムネイル（上位5件をティア色ピン） | `_buildStaticMapUrl`（`index.js`） |
| **Mapbox GL JS**（CDN） | 対話的な地図描画（候補ピン・bbox枠・isochrone到達圏・確定マーカー） | `index.js` 各 `draw*` / マーカー処理 |

> Directions API は現行の JS主導フローでは使用していません（コード上に実装は残るが `query-engine.js` からは未使用）。

#### Tilequery で使う streets-v8 レイヤー

| レイヤー | 何に使うか |
|---|---|
| `poi_label` | POI・建物名の収集（target のグリッド収集、poi条件、L3目印グリッド `buildPoiLabelGrid`） |
| `building` | 建物ポリゴン。`same_building` 判定（`_getBuildingId` / `_checkSameBuilding` / `filterSameBuilding`）、`height` から階数推定（`_getBuildingFloors` ＝ height ÷ 3m） |
| `road` | 道路・線路。`class` で振り分け。road条件（`roadNear`）、rail条件（`railNear`＝`class` に `rail` を含むもの）、`NON_ROAD_CLASSES` で相互除外 |
| `water` / `waterway` | 水域。water条件（`waterNear`。川/海/湖の区別はデータ上つかず有無＋距離のみ） |
| `transit_stop_label` | 駅出口・改札・バス停（`tilequeryTransitEntrances`、バス停探索） |

### 3.2 Turf.js（幾何計算・ブラウザ）

`modules/spatial-utils.js`（`SpatialUtils`）ほかで使用：

- **「AとBの間」エリア**：`turf.midpoint` / `turf.lineString` → `turf.buffer` → `turf.bbox`
- **点-線距離**：`turf.pointToLineDistance`（道路沿い判定の補助等）
- **点-多角形の内外判定**：isochrone到達圏でのフィルタ（`filterInsidePolygons`）

### 3.3 Claude API（Lambda プロキシ経由）

`config.js` の `CLAUDE_API_PROXY`（Anthropicへのパススルー Lambda）経由。役割ごとにモデルを分離（`config.js`、設定モーダルで変更可）：

| 役割 | 既定モデル | 内容 | 呼び出し |
|---|---|---|---|
| **L0（会話）** | Haiku/Sonnet | 対話パネルの入口。雑談/ミッション外の即時応答(`converse`)、schema確定後の自然文復唱(`confirmSchema`)、結果の確度コメント(`describeResults`)。意味解釈や数値判断はしない（決定性はL1-2/L2側が担保） | `converse` / `confirmSchema` / `describeResults` / `PROMPT_L0` |
| **L1-1（確認）** | Haiku | 「〜を探しますね」を真っ先に一文で復唱（L1本体と並行実行） | `confirmInput` / `PROMPT_CONFIRM` |
| **L1-2（解析）** | Sonnet | 自然言語 → QuerySchema JSON。最も推論が重い | `parseQuery` / `PROMPT_L1` |
| **L1-refine（差分）** | Sonnet | 「更に絞り込む/探し直す」の追加入力を差分(delta)として解釈 | `parseRefinement` / `PROMPT_L1_REFINE` |
| **L2-1（カテゴリ）** | Sonnet | 収集候補の poi_category / class が意図に合うか（名前を見ずカテゴリで妥当性判定） | `filterCategories` / `PROMPT_L2_1` |
| **L2-2（関連性）** | Sonnet | 候補名が意図の実体か 4段階判定（絶対そう/多分そう/わからない/違う） | `rateCandidates` / `PROMPT_L2_2` |
| **L3（目印提案）** | Haiku | 絞り込み時、近傍ランドマークから区別に使える目印を提案 | `suggestLandmarks` / `PROMPT_L3` |

- **プロンプトキャッシュ**：L1/L2-1/L2-2 の system は不変なので `cache_control:{ephemeral}` を付与（`_callClaude` の `opts.cacheSystem`）。2回目以降 system が約0.1倍で読込。効果はテレメトリの `💾r/w` で可視化。
- LLM出力はすべて JSON。`_extractJSON` で抽出し、L1は `validateQuerySchema` で検証、失敗時は最大 `L1_MAX_RETRY` 回リトライ。打ち切り（`stop_reason=max_tokens`）は検知して即エラー化。

---

## 4. ファイル構成

```
geonator/
├── index.html            画面（地図＋対話パネル）・スクリプト読込順・入力例チップ
├── index.js              UIコントローラ（DOM/地図/対話/テレメトリ）+ LANG(i18n) + アプリ起動
├── config.js             設定（APIキー、モデル、距離既定、スコア重み、上限、APP_VERSION 等）
├── config.local.js       ローカル専用の設定上書き（gitignore対象。個人用tokenの使い分け等）
├── modules/
│   ├── query-engine.js   ★JS主導オーケストレーター（フロー/評価/スコア/対話/MESSAGES）
│   ├── llm-client.js     Claude 呼び出し（役割別モデル・キャッシュ・stats・リトライ/タイムアウト）
│   ├── mapbox-mcp.js     Mapbox API 層（Search Box / Tilequery / Isochrone / 収集・判定）
│   ├── query-schema.js   QuerySchema の検証・既定補完・構造チェック・自然物判定
│   ├── distance-table.js 距離レベル→半径m/分の単一ソース、resolveDistanceParams
│   └── spatial-utils.js  Turf.js による幾何計算（中点/バッファ/点-線距離 等）
├── prompts/
│   ├── prompt-l0.js      L0（会話エージェント）ペルソナ(PROMPT_L0)：converse/confirmSchema/describeResults共通
│   ├── prompt-l1.js      L1(PROMPT_L1) / L1-refine / L3 / 確認(PROMPT_CONFIRM)
│   └── prompt-l2.js      L2-1(PROMPT_L2_1) / L2-2(PROMPT_L2_2)
├── data/
│   ├── poi-blocklist.js       POI名ブロックリスト（ノイズ除去）
│   ├── category-taxonomy.js   Search Box poi_category の正規カテゴリ一覧（285件）
│   └── category-synonyms.js  カテゴリ表記ゆれ→canonical_idのJS決定的辞書（ミス時のみLLMフォールバック）
├── styles/main.css       スタイル（チャット壁紙・候補パネル・ティア色・レスポンシブ）
├── images/               チャット背景画像
├── doc/                  設計・検討ドキュメント（ローカル専用・gitignore対象。リポジトリには含まれない）
└── .githooks/pre-commit  コミット毎に config.js の APP_VERSION を時刻スタンプ（core.hooksPath）
```

---

## 5. データモデル：QuerySchema

L1 が自然言語から生成する構造（`prompts/prompt-l1.js` の定義、`modules/query-schema.js` の enum/既定）。

```jsonc
{
  "proximity": {                    // だいたいどこ（探索の基準点。常に1つ）
    "anchors": [                    // 通常1件。「AとBの間」だけ2件
      { "type": "station|poi|address|locality|intersection",
        "text": "…", "specificity": "specific|generic",
        "subtype": { "exit": null } }
    ],
    "scope": null,                  // 同名施設の絞り込み用の行政区域（例:鎌倉市）
    "bearing_filter": null,         // 方角カット north|south|east|west（4方位に丸め）
    "within": null                  // 基準点からの到達範囲（下記）
  },
  "target": {                       // 探しているもの（常に1つ）
    "text": "…",
    "query_intent": "category_mansion|category_apartment|category_building|specific",
    "queries": ["検索語展開(QE)"],  // 一般POI/固有POIのみ展開、建物カテゴリ等は[text]
    "floors": null                  // 階数条件 {value|min|max, negate?}
  },
  "conditions": [                   // 近接条件（OR評価・複数可・重要順）
    { "type": "poi|road|water|rail|intersection|signal|transit_entrance|category_busstop",
      "text": "…", "query_intent": "…", "queries": ["…"],
      "direction": null,            // その条件物の方角 north|south|east|west
      "negate": false,              // 反転（無い/入っていない/避けたい/離れている）
      "distance": { "method": "radius|isochrone",
                    "level": "same_building|adjacent|roadside|very_close|nearby|somewhat_nearby|far|null",
                    "profile": "walking|cycling|driving|null",
                    "minutes": null, "meters": null } }
  ],
  "confirmation": "確認文",          // ユーザー向け（超過条件・非対応特徴には触れない）
  "unsupported_features": [],       // 数値化・地図化できない非地理的特徴（壁が赤い等）
  "result_area": false              // ピンポイントでなく大体のエリアを知りたい意図
}
```

### `proximity.within`（基準点からの到達範囲）
- 時間（isochrone・profile必須）：`{profile,maxMinutes}` / `{profile,minMinutes}` / `{profile,minMinutes,maxMinutes}`（=ドーナツ）
- 距離：`{maxMeters}`
- 近接度：`{level:"adjacent"}`（目の前）/`{level:"very_close"}`（すぐ隣）
- 「近く/付近/駅前/○○前」等の曖昧語は `null`（既定範囲で探索）

---

## 6. 詳細フロー（LLM / JS / 外部API を明記）

凡例：**[LLM]** = Claude / **[JS]** = ローカルJS計算・制御 / **[Mapbox]** = Mapbox API / **[Turf]** = Turf.js幾何 / **[UI]** = DOM/地図描画

対話パネル入力は L0（会話エージェント）を経由し、地図パネル右上の**検索ボックス**は
`run(text, { skipL0: true })` で L0 を完全にスキップして L1-2 へ直行する（L0向けAPI呼び出し
ゼロ。対話パネルとは入力欄が相互排他ロックされ同時使用不可）。以下は対話パネル経由の場合：

```
ユーザー入力
  │
  ├─[JS] run() 開始：世代管理・キャッシュ全リセット・stats/APIカウンタ初期化   (query-engine.js)
  │
  ├─[LLM] L0 intent分類(`converse`)をL1-2と【並行】発行：chatter/off_missionのみ即時表示
  │
  ├─[LLM] L1-1 確認文（Haiku）を L1本体と【並行】発行 → 先着を表示            (confirmInput)
  │
  ├─[LLM] L1-2 解析（Sonnet）：自然言語 → QuerySchema JSON（systemはキャッシュ）(parseQuery)
  │        └─[JS] _extractJSON → validateQuerySchema → fillSchemaDefaults
  │               （既定補完：road/rail「沿い」の既定を建物=roadside100m/自然物=very_close150m 等）
  │
  ├─[JS] 構造チェック structuralChecks → 不足/曖昧なら【明確化モード】
  │        └─[UI] 場所欠落→入力を促す / 複数該当→選択肢（最大 MAX_CLARIFY_TURNS 回）
  │
  ├─[JS] ⓪ QuerySchema 表示（デバッグ）
  │
  ├─[LLM] L0 confirmSchema：確定したschemaの事実だけを自然文で復唱（検索処理はブロックしない非同期発火）
  │
  ├─ _executeSearch():
  │   ├─[JS] キャッシュ無効化判定（bbox/collect/schema の3+1粒度）
  │   ├─① proximity 解決 → bbox
  │   │   ├─[Mapbox] Search Box でアンカー座標を解決（駅/地名/施設）
  │   │   ├─[Turf] 「AとBの間」は2点の中点+バッファでエリア化（spatial-utils）
  │   │   └─[JS] target厳守bbox / condition広めbbox の二重bbox、方角カット、within反映
  │   │       └─[Mapbox] within が時間指定なら Isochrone 到達圏を計算
  │   │
  │   ├─② Step1 候補収集
  │   │   ├─[Mapbox] target 収集：Search Box + Tilequery poi_label グリッド (collectTarget)
  │   │   │        └─[JS] 名前/クラス不一致・ブロックリスト・150cap で一次除外
  │   │   │        └─[Mapbox] Category Search API（poi_category）を並行併用：JS辞書
  │   │   │               (`category-synonyms.js`→`category-taxonomy.js`)がヒットすれば
  │   │   │               ゼロコスト、ミス時のみLLMフォールバック(Haiku)で他リクエストと並行実行
  │   │   ├─[Mapbox] 各 condition 収集：poi/バス停/交差点/信号/出口＝点収集
  │   │   │        （road/water/rail は収集せず後段で候補ごとに評価）
  │   │   │
  │   │   ├─[LLM] L2-1 カテゴリ妥当性（Sonnet・キャッシュ）：class/poi_category で意図外を除外
  │   │   └─[LLM] L2-2 関連性（Sonnet・キャッシュ）：候補名を4段階判定（バッチ並列）
  │   │
  │   ├─ ハード除外（採点前）
  │   │   ├─[Mapbox] same_building：建物IDが一致するか (_getBuildingId/filterSameBuilding)
  │   │   └─[Mapbox] floors：建物 height→階数、条件を満たさなければ除外 (_getBuildingFloors)
  │   │
  │   ├─③ Step2 距離評価＋スコア/ティア
  │   │   ├─[Mapbox] 各条件との近さ：円（radius）＝距離、時間（isochrone）＝到達圏
  │   │   │        line条件(road/rail/water)は候補ごとに roadNear/railNear/waterNear
  │   │   ├─[Turf] isochrone到達圏の点-多角形内外判定 (filterInsidePolygons)
  │   │   └─[JS] スコア = 重み付き和(relevance×条件距離×アンカー距離[+floors])
  │   │           → 絶対ゲート(GOLD_MIN_SCORE)＋1位2位マージンでティア決定
  │   │
  │   └─[UI] 候補パネル表示（サマリ＋理由＋ティア色ピン。地図OFF時は Static Images 差込）
  │        ├─[JS] 除外事項の透明化：上限超過の地理条件＋非対応特徴を注記、rail は地下鉄申し送り
  │        └─[LLM] L0 describeResults：tier分布から決定的に出した確度ラベル(decisive/ambiguous/
  │               tentative/none)＋上位5件をL0が自然文にまとめる（表示専用・非同期発火）
  │
  └─[JS] フィードバック _handleFeedback：
      ├─ 終了：確定・キャッシュ解放
      ├─ 更に絞り込む：現候補プール内で絞る
      │    ├─[LLM] L3 目印提案（Haiku）＋[JS] 目印の無い候補は一意な階数でサジェスト
      │    └─[Mapbox] 追加条件のみ収集して固定プールを再評価
      └─ 探し直す：[LLM] L1-refine 差分適用 →[Mapbox] proximity周辺で再検索
```

---

## 7. 主要関数（モジュール別）

### `modules/query-engine.js`（オーケストレーター）
- `run(userText)` — 入力受付・世代管理・L1-1並行発行・L1解析・明確化・`_executeSearch` 起動
- `_parseAndValidate` — L1呼び出し＋検証＋既定補完＋floors推論＋構造チェック
- `_executeSearch` — キャッシュ判定→proximity解決→二重bbox→収集→L2→ハード除外→評価→表示→フィードバック
- `_evaluate` — 3要素スコア（関連性/条件距離/アンカー距離、+floors）＋ティア決定、floors/same_buildingハード除外
- `_computeSuggestions` — L3目印提案（幾何的に区別できる近傍ランドマークをL3に選ばせる、candId付与）
- `_computeFloorSuggestions` — 目印の無い候補に一意な階数のサジェストを併用
- `_narrowWithin` / `_narrowByFloors` / `_refineWithHint` — 絞り込み/階数絞り/探し直し
- `_showResults` / `_exclusionNote` — 結果提示＋除外事項(A:上限超過/B:非対応/C:rail地下鉄)の注記
- `_roadOpts` / `isLineCond` — 道路名/幹線判定、line型(road/water/rail)判定
- `MESSAGES` — 対話文言（ja/en、JS事前定義）

### `modules/llm-client.js`（Claude層）
- `parseQuery` / `parseRefinement` / `confirmInput` / `filterCategories` / `rateCandidates` / `suggestLandmarks`
- `_callClaude` — fetch本体。`opts`：`returnMeta`(stop_reason)/`timeoutMs`(L1長め)/`cacheSystem`(キャッシュ)。stats集計（in/out/cacheRead/cacheWrite）
- `resetStats` — 役割別テレメトリ初期化

### `modules/mapbox-mcp.js`（Mapbox層）
- 収集：`collectTarget` / `collectCondition` / `_searchNearbyPOI` / `_gridTilequeryPOI` / `buildPoiLabelGrid`
- 線/面判定：`roadNear` / `railNear` / `waterNear` / `_findIntersections` / `_findTrafficSignals` / `tilequeryTransitEntrances`
- 建物：`_getBuildingId` / `_getBuildingFloors`（height÷3）/ `_checkSameBuilding` / `filterSameBuilding`
- 到達圏：`getIsochronePolygon` / `isochroneReach` / `computeWithinReach` / `_filterByIsochrone` / `filterInsidePolygons`
- bbox：`resolveBBox` / `expandBBox` / `_capBBox` / `_bboxToRadius`
- キャッシュ/上限：`_fetchTilequeryWithCache`（座標スナップでTQ重複削減）、`resetRequestCounts`、per-query API cap

### `modules/query-schema.js`
- `validateQuerySchema` — enum/必須の検証
- `fillSchemaDefaults` — 既定補完。条件距離の既定、road/rail「沿い」の建物100m/自然物150m振り分け、緩いレベル(nearby等)の締め、`droppedConditionTexts`（上限超過）、`unsupported_features` 正規化
- `isNaturalTarget` — 自然物ターゲット判定（公園/川/海/山 等のキーワード）
- `structuralChecks` — proximity欠落/target欠落/far距離のプッシュバック

### `modules/distance-table.js`
- `DISTANCE_TABLE` — レベル→半径m/等時間分（単一ソース）
- `resolveDistanceParams` — 明示m/分を優先、無ければテーブル値

---

## 8. スコアリングとティア（`config.js` / `query-engine.js`）

スコア（利用可能な要素だけで重み正規化した重み付き和）：

```
score = w_rel×relScore + w_cond×condScore + w_anchor×anchorScore  (+ floors)
```

| 要素 | 既定重み | 内容 |
|---|---|---|
| relScore（関連性） | 0.30 | L2-2 の4段階：絶対そう=1.0 / 多分そう=0.7 / わからない=0.4（「違う」は除外） |
| condScore（条件距離） | 0.50 | 各条件との近さ平均（0..1、非ヒット=0） |
| anchorScore（アンカー距離） | 0.20 | proximityアンカーからの近さ = 1 − 距離/参照半径 |
| floors | 0.4 | `FLOORS_MODE='soft'` 時のみ加算 |

ティア決定：`GOLD_MIN_SCORE=0.5` の絶対ゲート＋1位と2位のマージン（`SCORE_DECISIVENESS` で僅差の扱いを調整）。表示は 🥇gold / 🥈silver / 🥉bronze / 🟢full / 🔸partial / ⚪参考(none)。判定方式は既定ハード（`SAME_BUILDING_MODE` / `FLOORS_MODE` = 'hard'：採点前に除外）。

### 距離テーブル（`distance-table.js`）

| level | 半径 | 等時間 | 用途 |
|---|---|---|---|
| same_building | — | — | 同一建物（building ID） |
| adjacent | 50m | — | 目の前・すぐ隣（常に円） |
| roadside | 100m | 1分 | road/rail「沿い」建物向け（JSが付与） |
| very_close | 150m | 2分 | すぐ近く／沿いの自然物向け（既定 DEFAULT_LEVEL） |
| nearby | 400m | 5分 | 近く・付近 |
| somewhat_nearby | 800m | 10分 | 少し歩く |
| far | — | — | 遠すぎ→プッシュバック（条件にしない） |

---

## 9. 対応できる質問 / 対応できない質問

### ✅ 対応できる（QuerySchemaに載る＝地図データで判定できる）

**基準点(proximity)**
- 駅（`station`）、地名・エリア（`locality`）、施設・ランドマーク（`poi`）、住所・丁目（`address`）、名前付き交差点（`intersection`）
- 「AとBの間」（2アンカーの中間エリア）
- 行政区域での絞り込み（`scope`：鎌倉市の〜 等）
- 方角カット（`bearing_filter`：駅の北側 等）
- 基準点からの到達範囲（`within`）：徒歩/自転車/車の「n分以内 / n分以上 / n分〜n分（ドーナツ）」、「500m以内」、「目の前 / すぐ隣」

**探索対象(target)**
- マンション / アパート / ビル（建物カテゴリを区別）、固有名・一般POI（ホテル/カフェ/寿司屋…）
- 階数条件（`floors`）：「12階建て」「10階建て以下」「タワマン/高層(min20)」「低層(max3)」「N階建てではない(negate)」

**近接条件(conditions・複数OR)**
- POI（コンビニ・ATM・飲食店…、`queries`で表記ゆれ展開）
- 大通り/国道等（`road`）、川/海/湖(有無のみ)（`water`）、**線路沿い（`rail`：JR/私鉄/地下鉄/ケーブル/路面電車を区別せず）**
- 交差点（`intersection`）、信号（`signal`）、駅出口・改札（`transit_entrance`）、バス停（`category_busstop`）
- 各条件に距離（円/等時間、分/m/レベル）・方角（`direction`）・**反転（`negate`：〜が無い/入っていない/避けたい）**・同一建物（`same_building`）
- 「大体のエリアを知りたい」（`result_area`）

**対話・運用**
- 曖昧な場所や場所欠落 → 明確化質問（選択肢/追加入力、最大3回）
- 結果へのフィードバック → 終了 / 更に絞り込む（L3目印＋階数サジェスト）/ 条件追加で探し直す
- 処理中キャンセル、通信/タイムアウト/上限エラーのやり直し、日英切替、地図ON/OFF

### ❌ 対応できない（＝ユーザーに透明化して通知）

- **数値化・地図化できない非地理的特徴**（`unsupported_features` に格納し「判定できないため含めていない」と通知）
  例：築浅 / 壁が赤い・屋根が赤い / ペット可 / オートロック / 南向き / 家賃・価格 / 評判・口コミ / 営業時間 / 何階に入居 など
- **場所探しでない入力**（挨拶・雑談・手がかりが無い）→ `not_a_query` として案内
- **条件数の上限超過**：`MAX_CONDITIONS`（既定3・設定で0〜5）を超える地理条件は切り捨て、切り捨て分を通知（透明化A）
- **rail の地上/地下の区別不可**：「線路沿い」指定時、地下鉄など地下路線も線路とみなす旨を申し送り（データ上区別できないため）
- **water の川/海/湖の区別不可**：有無＋距離のみ
- **far（かなり遠い）** は距離条件として扱わずプッシュバック
- **目印でも階数でも区別できない同質な候補**：正直に残す（無理に1つへ絞らない）
- **同一クエリでもLLM判定によりヒット件数が数件ブレることがある**：候補の収集（Search Box/Tilequery・階数・幾何）は決定的で常に同一だが、L2の関連性判定（4段階の意図一致）はLLM呼び出しのため、名前だけでは業態が曖昧な候補（例：「〜荘」＝古い形式のアパート、業態不明瞭な固有名など）で判定が揺れることがある（temperature:0でも完全決定論ではないため）。収集結果自体がブレることはない（2026-07-10・3回連続実行で収集は完全一致・L2のみ数件差を実測確認）。

---

## 10. コスト管理・上限・キャッシュ（`config.js`）

- 候補収集上限 `CANDIDATE_LIMIT=150`、条件上限 `MAX_CONDITIONS=3`（0〜5）
- per-query API 安全上限：`TQ_MAX_PER_QUERY=2000` / `SB_MAX_PER_QUERY=100` / `ISO_MAX_PER_QUERY=100`（クエリ毎・リロードでリセット）
- Tilequery は座標スナップ＋within-run キャッシュで重複削減（`_fetchTilequeryWithCache`）
- API timeout（既定8s、L1のみ `L1_TIMEOUT_MS=20000`）＋リトライ（`API_MAX_RETRY` / `L1_MAX_RETRY`）
- **プロンプトキャッシュ**：L1/L2 の system を `cache_control` でキャッシュ（2回目以降 約0.1倍）。ヘッダーのテレメトリに `💾r/w` を表示
- ヘッダーに **APP_VERSION**（`.githooks/pre-commit` がコミット毎に `YYYY-MM-DD.HHMM` を自動スタンプ）を表示＝キャッシュで古いJSを読んでいないかの切り分け用

---

## 11. 補足

- 旧・LLM主導（エージェントループ）版は撤去済み。現行は JS主導版のみ。設計検討の経緯は `doc/`（ローカル専用・gitignore対象）に記録。
- ブラウザ完結（ビルド不要）。`index.html` をハードリロードで最新反映（バージョンはコミット時スタンプ）。
