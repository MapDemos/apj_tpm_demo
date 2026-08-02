# geonator_lite 実装仕様書

**作成日**: 2026-08-01
**位置づけ**: この文書は、既存の `geonator/`（同リポジトリ内、apj_tpm_demo/geonator）の開発経験を踏まえて設計した、新規の軽量POI検索ツール「geonator_lite」の実装仕様書である。**別プロセス・別モデルが本書だけを読んでゼロから実装できること**を目的に書いている。設計の背景・議論の経緯は本書には含めず、確定した仕様のみを記述する。

**最重要の前提**：
- **既存の `geonator/` フォルダは一切変更しない。** 参照（読む）のみ可。全ての新規コードは `geonator_lite/` 配下に作成する。
- 実装のスタート地点は「`geonator/modules/` 等の既存ファイルをコピーしてフォークし、そこから大幅に簡略化する」方式。ゼロから書き起こす必要はない（むしろ流用すべき）。
- geonator本体とgeonator_liteは今後別々に進化する前提（共有ラッパーにはしない）。

---

## 1. このツールが何か

**一言で言うと**：自然言語のあいまいな検索文を受け取り、Mapboxのデータセット（Search Box API / Tilequery API / Isochrone API）だけを使って、それに合致するPOI（施設・場所）のランキング済みリストを返す、Google Places APIに似た検索ツール。

**geonatorとの決定的な違い**：
- geonatorは「その1軒を特定する」ツール（confirmSchema・choice panel・絞り込み会話ループを持つ）。
- geonator_liteは「該当しそうなPOIのリストを返すだけ」のツール。**ユーザーに確認を取らず、常に一発で検索を実行し、結果をそのまま返す**。ヒット0件も正常なレスポンス（エラーではない）。

**価値提案（変わらない部分）**：
- LLMの世界知識に頼らない、決定的（deterministic）なジオ解決。LLMは「自然文→構造化クエリへの解釈」と「収集結果の意味的クレンジング（カテゴリ・名前の妥当性判定）」にのみ使う。
- 強力なあいまい検索（表記ゆれ・同義語展開・距離語の解釈）とMapboxデータセットの活用。

**再利用性**：
- 検索ロジックは**UIを持たないheadless関数**として実装する。同一リポジトリ内の別のhtmlツールからも、この関数を直接呼び出して使えるようにする（地図の所有権は呼び出し元にある。geonator_lite側は地図インスタンスを持たない）。

---

## 2. スコープ外（意図的に実装しないもの）— 重要

geonatorには存在するが、**geonator_liteには実装しない**もの。実装中にgeonatorのコードを参照する際、以下は移植しないこと。

| 項目 | geonatorでの役割 | 削除理由 |
|---|---|---|
| L0（会話エージェント） | 対話管理・雑談判定・confirmSchema・describeResults・classifyFeedback | 決め打ち一発検索には対話状態が不要 |
| L1-1（`PROMPT_CONFIRM`） | 高速確認文の先出し | geonatorでも既にL0導入後は非活性。不要 |
| L1-3（`suggestProximityAnchors`） | 広域地名→周辺駅等をLLM世界知識で列挙 | 「LLM世界知識を使わない」という価値提案に反する |
| L3（`PROMPT_L3`、目印提案） | 複数候補の絞り込み用ヒントボタン提案 | 絞り込み会話ループが無いので不要 |
| `PROMPT_L1_REFINE`（差分絞り込み） | 追加発話での既存検索の修正 | 一発検索のみ。追加リクエストは常に新規クエリとして扱う |
| interpretations（構造の複数解釈） | 選択肢パネルでユーザーに確認 | 確認ステップが無い。L1は常に最有力の1解釈だけを出力する |
| confirmation（検索前の確認文） | 検索前に「〜を探しますね」と表示 | 確認ステップ自体が無い |
| not_a_query 判定 | 場所の手がかりが無い入力を拒否 | 検索APIとして扱うため、該当なしは「ヒット0件」で表現する。拒否ゲート不要 |
| unsupported_features | 数値化できない特徴をユーザーに通知 | 通知UIが無いので不要（値は単に無視してよい） |
| result_area（面検索モード） | エリア全体を面で提示 | POIリスト検索のみに特化 |
| tier判定（gold/full/partial/none）・確信度ラベル | ユーザーへの確信度表示 | 番号順ランキングのみに簡略化 |
| `GOLD_MIN_SCORE` / `SCORE_DECISIVENESS` | tier判定用の閾値・言い切り度 | tier自体が無いので不要 |
| Tilequery収集グリッド（`_gridTilequeryPOI`, `buildPoiLabelGrid`、六角格子の多点サンプリング） | 広域を漏れなく網羅するための多点Tilequery呼び出し | 下記§5参照。単発の大半径呼び出し＋limit=50で代替 |
| geonatorの設定モーダル（基本タブ／スコアタブ、ロール別モデル選択5種、絞り込みターン数などのUI全般） | 全設定項目のGUI | 下記§7の簡略版のみ実装 |
| `L2_1_KEEP_NULL_CATEGORY` | L2-1（カテゴリ妥当性）のnull候補の扱い切替 | L2-1/L2-2統合によりこの単位の設定自体が消滅 |

---

## 3. パイプライン全体像

```
リクエスト受信 (JS)
  input: { text, proximity?: {lat,lng}, model?, judge?: {...} }
  ↓
L1 (LLM 1回) — クエリ解釈
  自然文 → QuerySchema JSON（§4）
  ↓
候補収集 (JS, 非LLM) — Search Box / Tilequery を単発実行（グリッド無し。§5）
  ↓
L2 (LLM 1回、target/conditionsごとに並列) — カテゴリ妥当性＋名前関連性の統合判定（§6）
  ↓
重複統合 (LLM 1回、座標クラスタがある場合のみ・任意)
  ↓
スコアリング・ランキング (JS, 非LLM) — 重み付きスコア計算→降順ソート（§7）
  ↓
レスポンス返却 (JSON POIリスト)
```

**LLM呼び出しは最大3回**（L1 → L2 → 重複統合〈条件付き〉）。geonatorのL1→L2-1→L2-2→重複統合(最大4回)から1段削減している。

---

## 4. クエリスキーマ（L1出力）

### 4.1 方針
- geonator既存の `prompts/prompt-l1.js` の `PROMPT_L1` をベースにする（フィールド定義・抽出ルールの大部分はそのまま有効）。
- **JSON形式は維持する**。ただし出力トークン削減のため**キー名を短縮する**（下記4.3）。
- 「最小出力の原則」（値が無いフィールドは省略する）は維持する。
- **`proximity.anchors` は必須ではなくなる**（§4.2参照）。
- `interpretations` / `confirmation` / `unsupported_features` / `result_area` フィールドは出力させない（プロンプトから該当セクションを削除）。
- `not_a_query` の出力自体は維持してよいが、**JS側でこれを「拒否」として扱わない**。target/proximityとも抽出できない場合は、その後の候補収集で単純にヒット0件になるようにする（下記4.2）。
- query_intentの種類（category_mansion / category_apartment / category_building / specific / category_busstop / category_busstop_location / intersection / signal / transit_entrance）は**全て維持する**。理由：Tilequery側でどのタイルセット/レイヤーを叩くかの分岐に必須のため。
- conditions[]のtype一覧（poi / road / water / rail / intersection / signal / transit_entrance / category_busstop）も全て維持。
- 維持するフィールド： `target.floors`、`conditions[].direction`、`conditions[].negate`、`category_tag`（target・条件双方）、`proximity.scope`、`proximity.bearing_filter`、`proximity.within`、`target.queries` / `conditions[].queries`（同義語展開）。

### 4.2 proximityのデフォルト値ルール（重要・確定仕様）

- L1はテキストから場所の言及を検出できた時だけ `proximity.anchors` を出力する（現行の抽出ルールのまま）。検出できなければ出力しない（省略）。
- **リクエストに `proximity: {lat, lng}` が含まれている場合**：JS側は以下のロジックで実効proximityを決定する。
  - L1が `anchors` を出力した場合 → その anchor テキストを Search Box で解決した座標を実効proximityとして使う（＝クエリ内の明示的な場所がリクエストのlat/lngより優先される）。
  - L1が `anchors` を出力しなかった場合 → リクエストの `proximity.lat/lng` をそのまま実効proximityとして使う。
- **リクエストに `proximity` が無く、かつL1も anchors を出力しなかった場合**（＝場所の手がかりが一切無い）：
  - **エラーにはしない**。Search Boxをproximityバイアス無しで実行し、targetのテキストのまま検索する。
  - **Tilequery（座標グリッド前提のAPI）は実行しない**（実行できないため単純にスキップ）。
  - 結果が0件になることは正常なレスポンスとして扱う。
- 例（動作確認用）：
  - リクエストproximity=東京駅, クエリ=「清水寺」→ anchorsなし → 東京駅座標をそのままproximityとして清水寺をSearch Boxで検索。
  - リクエストproximity=東京駅, クエリ=「京都 清水寺」→ anchors=[{type:locality,text:"京都"}]検出 → 京都をSearch Boxで解決した座標が実効proximityになり、そこを中心に清水寺を検索（東京駅は使われない）。

### 4.3 短縮キー案（叩き台。実装時に調整可）

以下を出発点として、L1のシステムプロンプト内のJSON例・フィールド説明を書き換える。**実装後、実例セットで解析精度が既存(フルネームキー)と比べて劣化していないか確認すること**（後述§9の教訓参照。キー短縮は英語化実験と同種のリスクがあるフォーマット変更）。

```json
{
  "prox": {
    "anc": [{ "ty": "station", "tx": "西大島駅" }],
    "sc": { "ty": "locality", "tx": "鎌倉市" },
    "brg": "north",
    "wi": { "pf": "walking", "pfi": false, "mnMi": null, "mxMi": 5, "mxMe": null, "lv": null }
  },
  "tgt": {
    "tx": "マンション",
    "qi": "category_mansion",
    "q": ["マンション"],
    "fl": { "mn": 20 },
    "cat": "レストラン>丼もの"
  },
  "cond": [
    {
      "ty": "poi",
      "tx": "ローソン",
      "qi": "specific",
      "q": ["ローソン"],
      "dir": null,
      "ng": false,
      "d": { "m": "radius", "lv": "very_close", "pf": null, "mi": null, "me": null },
      "cat": null
    }
  ]
}
```

キー対応表：`proximity→prox, anchors→anc, type→ty, text→tx, specificity→spc, subtype→sub, scope→sc, bearing_filter→brg, within→wi, profile→pf, profile_inferred→pfi, minMinutes→mnMi, maxMinutes→mxMi, maxMeters→mxMe, level→lv, target→tgt, query_intent→qi, queries→q, floors→fl, value→v, min→mn, max→mx, negate→ng, category_tag→cat, conditions→cond, direction→dir, distance→d, method→m, minutes→mi, meters→me`

not_a_query はキー名そのまま `not_a_query` でよい（出現頻度が低いので短縮の効果が薄い）。

---

## 5. 候補収集（Tilequery単発呼び出しへの変更）

### 5.1 確定仕様
- **Tilequery収集のグリッド方式（`mapbox-mcp.js` の `_gridTilequeryPOI` / `buildPoiLabelGrid`、六角格子の多点サンプリング）は実装しない。**
- 代わりに、**1回のTilequery呼び出しで完結させる**：`radius` は実務上できるだけ大きい値を使う（下記5.2参照）、`limit` は最大値の50を使う。
- これはpoi_labelレイヤー（一般POI）・building系レイヤー（マンション/アパート/ビル）**両方**に適用する。
- **根拠（Mapbox公式ドキュメントで確認済み）**：
  - `radius` パラメータに上限は無い（"Has no upper bound"）。
  - `limit` の最大値は50。
  - `radius` 指定時、結果は近い順にソートされて返る。ポイントレイヤーはクエリ地点からの距離、ポリゴンレイヤー（building等）は**ポリゴンの最寄りの辺までの距離**で同様にソートされる（point-in-polygon方式ではなくなる）。
  - 例外：重なり合うポリゴンが多いタイルでは順序が完全には保証されないケースがあるが、`limit=50`で上限を切る運用で許容範囲。
- Search Box側の収集ロジック（`category_tag` によるカテゴリ検索の活用等）はgeonatorのまま流用してよい。

### 5.2 radius初期値
- 「小さくする意味は無い」という方針のもと、**実務上の最大値**を使う。
- ただし極端に大きい値ではTilequery API自体のレイテンシが伸びる可能性があるため、**実装時に実際にAPIを叩いて許容できるレイテンシの範囲で最大の値を決めること**（例えば案として5万m前後から試し、実測して調整。上限が無いからといって無条件に極端な値を決め打ちしない）。
- 複数の条件（conditions）がある場合も、それぞれ同様に単発の大半径呼び出しにする。

### 5.3 安全上限
- `TQ_MAX_PER_QUERY` / `SB_MAX_PER_QUERY` 等、1クエリあたりのAPI呼び出し数上限の仕組みはgeonatorのまま流用してよい（グリッドが無くなる分、実際の呼び出し数は大幅に減るはず）。

---

## 6. L2判定（L2-1とL2-2の統合）

### 6.1 確定仕様
- geonatorの `_applyCategoryFilter`（L2-1、カテゴリ妥当性、`filterCategories`関数）と `rateCandidates`（L2-2、名前関連性）を**1回のLLM呼び出しに統合する**。
- 統合後の呼び出しは、候補ごとに `{ id, name, poi_category, class }` を渡し、**カテゴリ情報と名前の両方を同時に見て**、意図と合致するかを4段階（definitely / probably / unknown / no）で判定する1回の応答を得る設計にする。
- 出力形式はgeonatorの`rateCandidates`のレスポンス形式（`{definitely:[], probably:[], no:[]}`、未列挙=unknown）を踏襲してよい。
- target側とcondition側は引き続き `Promise.all` で並列実行する（geonatorの既存パターンをそのまま流用）。
- **`L2_1_KEEP_NULL_CATEGORY` 設定は実装しない**（この単位の判定が消滅するため）。
- 重複統合（座標クラスタに対するLLM意味判定、`dedupCandidateClusters`相当）は、統合L2の判定後に、クラスタが実際に存在する場合のみ呼ぶ形でgeonatorの実装をそのまま流用してよい。

---

## 7. スコアリング・ランキング・設定

### 7.1 スコア計算
- geonatorのスコア式（`score = (w_rel×relScore + w_cond×condScore + w_anchor×anchorScore + w_floors×floorsScore) の重み正規化`）をそのまま流用する。
- **tier判定（gold/full/partial/none）・確信度ラベルは実装しない**。スコアで降順ソートし、順位番号を付けて返すだけ。
- `SAME_BUILDING_MODE` / `FLOORS_MODE`（'hard'|'soft'）はgeonatorのまま維持する。

### 7.2 request body 仕様（確定）

```json
{
  "text": "东京駅の近くのカフェ",
  "proximity": { "lat": 35.681236, "lng": 139.767125 },
  "model": "claude-haiku-4-5-20251001",
  "judge": {
    "weights": { "relevance": 0.30, "condition": 0.50, "anchor": 0.20, "floors": 0.40 },
    "sameBuildingMode": "hard",
    "floorsMode": "hard"
  }
}
```

- `proximity` は省略可（§4.2のフォールバック挙動に従う）。
- `model` は単一フィールド。L1・L2どちらの呼び出しにも同じモデルを使う（geonatorのようなロール別5種類のモデル選択は実装しない）。省略時デフォルトは `claude-haiku-4-5-20251001`。
- `judge.weights` の4項目・`sameBuildingMode`・`floorsMode` 以外の判定系設定（`GOLD_MIN_SCORE`、`SCORE_DECISIVENESS`等）は実装しない。

### 7.3 レスポンス仕様（叩き台）

```json
{
  "results": [
    { "rank": 1, "name": "...", "lat": 35.68, "lng": 139.76, "score": 0.82, "poi_category": ["cafe"] }
  ],
  "meta": { "candidateCount": 12, "elapsedMs": 1800 }
}
```

具体的なPOIオブジェクトのフィールド構成は、geonatorの候補オブジェクト（`_dbgReport.target.keptNames`等で使っている内部表現）を踏襲してよい。

---

## 8. 配布形態・再利用性

- 検索ロジックは**headless関数**として実装する。関数シグネチャの目安：

```js
async function searchPOI(requestBody) {
  // requestBody は §7.2 の形式
  // 戻り値は §7.3 の形式
}
```

- **DOM・地図インスタンスを一切参照しない**。地図の中心座標(lat/lng)は呼び出し元が `proximity` として渡す（§4.2のロジックにより、地図の所有権はgeonator_lite側には無い）。
- 既存geonatorのファイル群（script-tagグローバル前提、モジュールシステム無し）と同じ配布方式を踏襲してよい。つまり `<script>` タグで読み込むだけで、同一リポジトリ内の他のhtmlツールからもこの関数を直接呼び出せるようにする。ビルドツール・バンドラは導入しない。
- geonator_lite自身のデモアプリ（地図＋検索ボックスのみのUI）は、この `searchPOI` 関数を内部的に呼び出すクライアントの1つという位置づけにする。

### 8.1 デモアプリの設定画面
- geonatorの設定モーダルはそのまま移植しない。**§7.2のrequest bodyをGUIで編集できる簡易フォーム**のみを実装する：
  - モデル選択（1つのドロップダウン）
  - スコア重みスライダー×4（relevance/condition/anchor/floors）
  - same-building判定 hard/soft ドロップダウン
  - floors判定 hard/soft ドロップダウン
- 生JSONエディタではなく、上記の構造化フォーム（geonatorの既存UIコンポーネントを流用可）。

---

## 9. フォーク元・実装の起点

以下のgeonator既存ファイルを**コピー**して起点にする（geonator本体は無改変のまま）：

| コピー元 | 用途・改変方針 |
|---|---|
| `geonator/modules/query-engine.js` | パイプライン制御。L0/L3/絞り込みループ関連コードを削除し、§3のパイプラインに簡略化 |
| `geonator/modules/llm-client.js` | `_callClaude`（Anthropic呼び出し・プロンプトキャッシュ・タイムアウト・モデル判定ロジック）はほぼそのまま流用。L0/L1-3/L3関連の呼び出し関数のみ削除 |
| `geonator/modules/mapbox-mcp.js` | Search Box/Tilequery呼び出し。§5の通りグリッド関連コード（`_gridTilequeryPOI`, `buildPoiLabelGrid`）を削除し、単発呼び出しに置き換え |
| `geonator/data/category-taxonomy.js` | そのまま流用（category_tag解決用） |
| `geonator/data/category-synonyms.js` | そのまま流用 |
| `geonator/data/poi-blocklist.js` | そのまま流用 |
| `geonator/prompts/prompt-l1.js` | `PROMPT_L1`のみ抽出・§4の通り簡略化＋キー短縮。`PROMPT_L1_REFINE`/`PROMPT_L3`/`PROMPT_CONFIRM`は削除 |
| `geonator/prompts/prompt-l2.js` | L2-1用・L2-2用プロンプトを1本に統合（§6） |

**インフラはそのまま流用**：
- Anthropic呼び出し先（`config.js`の`CLAUDE_API_PROXY`のLambda URL）は同じ値をそのまま使う（プロバイダ非依存の単純パススルーのため、プロジェクト固有のインフラではない）。
- Mapboxアクセストークンも同様にそのまま流用。
- ローカル開発時の`local-proxy/`構成（gitignore対象）を使いたい場合は、geonatorの`local-proxy/server.js`と同じパターンをgeonator_lite側にも独立して用意してよい（geonator側のものを共有はしない）。

---

## 10. 既知の注意点（実装時に踏まえること）

- **target/proximity自己言及バグ**：geonatorで未解決のまま残っている既知の問題（例:「入谷二丁目」のような入力で、targetとproximity anchorが同一文字列になり自己言及的に0件化するケース）。§4.2のフォールバック（anchor無し→リクエストのlat/lng使用）の経路ではこの問題は構造的に起きない（anchorテキスト自体が存在しないため）が、**明示的に場所が言及されるケースでは同じ曖昧さが残る**。実装時に遭遇したら、無理に自動対応せず既知の未解決事項として記録すること。
- **フォーマット変更のリスク**：キー短縮（§4.3）はgeonatorで過去に実施した「L1プロンプトの説明文英語化」実験（15%トークン削減と引き換えに実例の8/13で解析結果が乖離、1件で必須フィールド欠落という重大な退行が発生し見送った経緯がある）と同種のリスクを持つ変更。**実装後、変更前(フルネームキー)との解析結果の再現性を実例セットで比較してから採用を確定すること**。もし精度劣化が大きい場合は、キー短縮の度合いを緩めるか撤回する判断もあり得る。
- **Tilequery radius**：§5.2の通り、極端に大きい値でのAPIレイテンシは未検証。決め打ちで実装せず、実測してから確定する。

---

## 11. ディレクトリ構成（提案）

```
geonator_lite/
  IMPLEMENTATION_SPEC.md   ← 本書
  index.html               ← デモアプリ（地図＋検索ボックス＋簡易設定フォーム）
  index.js
  config.js
  modules/
    query-engine.js
    llm-client.js
    mapbox-mcp.js
  data/
    category-taxonomy.js
    category-synonyms.js
    poi-blocklist.js
  prompts/
    prompt-l1.js
    prompt-l2.js
  local-proxy/              ← ローカル開発用（gitignore対象、必要なら独自に用意）
```

以上。不明点があれば、本書の該当セクション番号を明示した上で、geonator既存コードの該当箇所を実際に読んで判断すること（過去の教訓：課題管理表やドキュメントの記述だけで判断せず、実装直前にコードで裏取りする習慣が重要）。
