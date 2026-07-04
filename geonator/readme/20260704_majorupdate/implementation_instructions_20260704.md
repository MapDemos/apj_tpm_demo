# Geonator JS主導アーキテクチャ 実装指示書（Claude Code Sonnet 向け）

**作成日**: 2026-07-04
**対象実装者**: Claude Code (Sonnet)
**前提資料（必読・仕様の正）**: `systemdesign_20260704.md`（設計）/ `flowdetail_20260704.md`（ステップ表）。本書はそれを**どう実装するか**の厳密指示。設計判断で迷ったら勝手に決めず、両設計書の記述を優先し、記述が無ければ実装を止めて質問すること。

---

## 0. これは何をする作業か（背景）

現行 Geonator は **LLM主導**（`index.js` の `processUserMessage` で Claude がツールを自律ループ実行）。これを **JS主導** に全面転換する。

- **転換の核**: フロー制御・APIコール・数値計算・UI・分岐判定をすべてJSが行う。LLMは **L1（自然文→QuerySchema変換）** と **L2（候補のネガティブフィルタ）** の2箇所だけで呼ぶ。
- LLMにツールを選ばせる agentic loop は**廃止**する。

この転換は破壊的変更のため、**現行ファイルを直接改造せず、下記のブランチ運用と段階実装**で進めること。

---

## 1. 絶対に守るルール（違反＝設計違反）

1. **数値・しきい値・分数・半径・上限は全てJS定数**。LLMに生の数値（メートル/分）を発明させない。LLMは「どのlevel/methodか」を**選ぶ**だけ。
2. **対話パネルの文言は `systemdesign §5-3` の固定テキストのみ**。LLMにユーザー向け文章を生成させない。
3. **LLM呼び出しはL1とL2の2種類だけ**。それ以外でClaude APIを呼ばない。
4. 以下は**作らない/使わない（廃止済み・systemdesign §2-3, §9-3）**:
   - `route_between` を独立typeにする実装（→ `proximity.anchors[]` が N≥2 で表現）
   - `landmark_bearing` / `compute_area_from_landmark_bearing`
   - `visible` という独立level
   - 複合proximity（scope+anchorでセブン等をproximityにする）— generic は condition に降格
   - `get_facing_road` / `scan_natural_features` / `find_intersections` / `find_traffic_signals` / `get_midpoint_area`（→ `resolveBBox` に統合）
5. **既存の有用実装は流用**（削除・再発明しない）:
   - 座標ベース dedup（`mapbox-mcp.js` の `dedupKey` / `seen`）
   - `_getBuildingId(lat,lng)`（same_building判定に使う）
   - `data/poi-blocklist.js`（建物カテゴリの負引き）
   - Search Box / Tilequery のリクエスト実装（`_searchBoxRequest`, `_fetchTilequeryWithCache`, `_gridTilequeryPOI` 等）
   - `spatial-utils.js` の turf ベース計算
6. **段階ごとにコミット**し、各段階の受け入れ基準（§9）を満たしてから次へ進む。

---

## 2. ブランチ・ファイル構成

- 作業ブランチ: `feat/js-driven-architecture`（main から切る）。
- 新規モジュール（`modules/` 配下）:
  - `modules/query-engine.js` — **JS主導オーケストレーター**（本アーキの中核。フロー全体を制御）
  - `modules/llm-client.js` — L1/L2 のClaude API呼び出し＋schemaバリデータ
  - `modules/distance-table.js` — 距離テーブル定数（single source of truth・§4）
  - `modules/query-schema.js` — QuerySchemaのJSDoc型定義＋バリデータ＋デフォルト補完
- 改修:
  - `modules/mapbox-mcp.js` — 「ツール定義＋自律実行」から「**JSから呼ぶ純関数群**」へ整理。不要ツール削除、`resolveBBox` 統合、`evaluate_distance` を `distance` オブジェクト対応に。
  - `index.js` — `processUserMessage` の agentic loop を撤去し、`QueryEngine` を呼ぶ薄い層に。UI（マーカー・パネル・ボタン）制御は流用/整理。
  - `config.js` — 新定数追加（§3）
  - `prompts/prompt.js` — L1/L2 用の2プロンプトに再編（§5, §6）
  - `index.html` — 新モジュールの `<script>` 読み込み追加

---

## 3. config.js に追加する定数

```javascript
// ── JS主導アーキ ──
DEFAULT_LEVEL:        'very_close',  // 距離語なし時のデフォルト
MAX_CLARIFY_TURNS:    3,             // 明確化ループ上限（HH）
API_TIMEOUT_MS:       8000,          // 各API呼び出しのタイムアウト（GG）
API_MAX_RETRY:        1,             // タイムアウト時のリトライ回数（GG）
L1_MAX_RETRY:         1,             // L1 JSON不正時のリトライ（II）
CANDIDATE_LIMIT:      150,           // 収集候補の上限（既存slice(0,150)を定数化）
BBOX_MAX_HALF_M:      2000,          // 一次検索bboxの半径上限（span/far判定・§6-3）
```

`CLAUDE_MODEL` は `claude-sonnet-4-6` のまま。`MAX_TOOL_TURNS` / `MAX_HINT_TURNS` / `HINT_EXTRA_TURNS` は agentic loop 廃止に伴い**未使用化**（削除せずコメントで deprecated 明記）。

---

## 4. distance-table.js（距離テーブル＝single source of truth）

`systemdesign §6-1/§6-2` を定数化。**全ての距離判定はここを参照**。

```javascript
const DISTANCE_TABLE = {
  same_building:   { method: 'building_id', radius_m: null, iso_min: null },
  adjacent:        { method: 'circle',      radius_m: 50,   iso_min: null }, // 常にcircle
  very_close:      { method: 'both',        radius_m: 250,  iso_min: 3   },
  nearby:          { method: 'both',        radius_m: 700,  iso_min: 10  },
  somewhat_nearby: { method: 'both',        radius_m: 1400, iso_min: 20  },
  far:             { method: 'none',        radius_m: null, iso_min: null }, // 使わない→pushback
};
```

- `condition.distance.method` が `radius` → `radius_m` を使用。`isochrone` → `iso_min`（または明示 `minutes`）＋ `profile` を使用。
- `adjacent` は method指定に関わらず circle(50m)。`same_building` は `_getBuildingId` 比較。`far` は距離条件にせず pushback（§5-3の遠すぎ文言）。
- level未指定は `CONFIG.DEFAULT_LEVEL`（very_close）で補完。

---

## 5. L1（クエリ解析）プロンプト仕様

`llm-client.js` の `parseQuery(userText, previousText=null)`。`prompts/prompt.js` に L1 プロンプトを定義。

**出力**: `systemdesign §4` のQuerySchema JSON **のみ**（前後に地の文を出させない。JSON以外を返したらII扱いでリトライ）。

**プロンプトに必ず含める指示:**
1. `systemdesign §4` のスキーマ全文と各enumの意味。
2. **役割分担ルール（§4-2）**: proximity には最も一意に特定できる場所を選び、他の場所言及は condition に降格。一意なアンカーが2つ以上同格なら `anchors` に複数入れる。
3. **specificity**: 各proximityアンカーに `specific`/`generic` を付与（コンビニ・スーパー・モール等の一般カテゴリ＝generic）。
4. **target は1つ**。複数解釈可能なら最も可能性が高い1つ＋残りは出さない（JS側が個数を見て明確化する）。
5. **distance の method 振り分け（§6-2）**: 移動手段（歩く/自転車/車）・時間（x分）を含む→`isochrone`（profile/minutes付与）。それ以外の曖昧語・明示距離→`radius`。距離語が無ければ `distance` の level を null（JSが補完）。**生の数値は必要な明示指定（「500m」「5分」）のときだけ**入れる。
6. **bearing_filter**: 「北側/東口方面」等→4方位に丸め（北西→north等）。無ければ null。
7. **Query Expansion**: 曖昧表現のみ展開（既存 `prompt.js` のQEルールを流用）。固有名詞・駅名は展開しない。
8. **unsupported**: どのtype/conditionにも当てはまらない条件（建物の色・階数等）は自由記述で格納。
9. **再解析時（previousText有り）**: 「元の全文＋追加ヒント」を丸ごと渡して**schemaを作り直す**（差分マージはしない・K）。

**受け側（JS）**: `query-schema.js` のバリデータで enum/必須/型を検証（II）。失敗なら `L1_MAX_RETRY` 回リトライ→固定文。

---

## 6. L2（ネガティブフィルタ）プロンプト仕様

`llm-client.js` の `filterCandidates(target, candidates)`。

- **入力**: 探索対象（text＋type）と候補リスト `[{id,name}, ...]`。
- **出力**: `{ "exclude_ids": [1,5,12] }` **のみ**。
- **指示**: 「明らかに対象外のIDだけ挙げよ。**判断が曖昧なものは残せ**（見逃しは過検出より危険・R）」。ポジティブ選択はさせない。
- **適用範囲（B）**: メイン候補＋全condition候補に一律適用（カテゴリ系の空振りは許容）。1回のプロンプトで全リストを並行処理してよい。座標は渡さない（名前とIDのみ）。

---

## 7. query-engine.js（中核オーケストレーター）

`flowdetail_20260704.md` のステップ表を**そのまま状態機械として実装**する。`QueryEngine` クラス。UIコールバック（パネル文言表示・ボタン・マーカー描画）は `index.js` から注入する（QueryEngineはUI DOMを直接触らない）。

**主要メソッド（想定シグネチャ）:**
```javascript
class QueryEngine {
  constructor({ mcp, llm, ui, config }) {}

  async run(userText) {}                 // [1]→[4] 一連
  async _resolveProximity(schema) {}     // [3-A] anchors→bbox（AA/C-2/方角）
  async _collectCandidates(schema, bboxes) {} // [3-B] target/conditions収集＋ノイズ除去
  async _evaluate(schema, mains, conds) {}    // [3-C] evaluate_distance＋conditionTracker
  _classifyResults(tracker) {}           // full/partial/none（E/I）
  async _clarify(kind, options) {}       // Mode1(ボタン)/Mode2(自由記入)。上限MAX_CLARIFY_TURNS
  _invalidateCache(oldSchema, newSchema) {} // K・3+1粒度
}
```

**実装上の必須点:**
- **二重bbox（C-2/§7-4）**: `targetBbox`（タイト）と `conditionBbox`（＝targetBbox＋`max(条件距離)`マージン）を分けて収集。
- **bbox上限（EE）**: 上限判定は target(span) bbox に対して。conditionマージン拡張は上限判定の対象外。
- **isochrone最適化（FF）**: 「アンカー×level」でisochroneを1回計算しキャッシュ、同levelの全conditionは point-in-polygon で判定。
- **OR評価（I）**: 0conditionのメイン候補も `none` として保持し表示する（除外しない）。
- **条件0件注記（S）**: `condition_candidates[type]` が空なら固定文で注記。
- **0件2分岐（L）**: メイン0件 vs メインあり条件0 で文言・導線を分ける。
- **キャッシュ（K）**: 一次bbox / メイン候補 / 二次評価 を別レイヤで保持し、再解析時に差分に応じて破棄。
- **明確化（Mode1/2）**: Mode1はボタン結果を直接採用（再L1なし）、Mode2は元クエリ＋入力でL1再実行。`MAX_CLARIFY_TURNS` を超えたらベストエフォート。

---

## 8. mapbox-mcp.js の改修

1. **ツール自律実行の撤去**: `listTools`/`executeTool` の agentic 用途を廃止。JSから直接呼ぶ純関数として公開（メソッドはそのまま流用可）。
2. **不要ツール削除**: §1-4 の廃止リスト。
3. **`resolveBBox` 統合（C-3・§9-2）**: 散在する `radius→bbox`（`_searchNearbyPOI` 内インライン）/ `compute_bbox_from_points` / `calculateMidpointBBOX` を **単一関数 `resolveBBox({ points?, center?, radiusM?, marginM? })`** に集約。一次・二次の両方がこれを通る。
4. **`evaluate_distance` を `distance` オブジェクト対応に**: 引数を `(distance, anchor, candidates, profile)` にし、`distance.method`（circle/isochrone/building_id）で内部分岐。`same_building` は `_getBuildingId` 比較（既存 `_checkSameBuilding` を流用/整理）。
5. **候補上限**: `slice(0, 150)` を `CONFIG.CANDIDATE_LIMIT` に置換。
6. **dedup / poi-blocklist / 前方一致（`_matchesAnyQuery`）は流用**。前方一致は「specific POI は text 前方一致のみ残す」で使用（B）。
7. **API堅牢性（GG）**: `_fetchWithRetry` を `CONFIG.API_TIMEOUT_MS` / `CONFIG.API_MAX_RETRY` に合わせ、タイムアウト付き fetch（`AbortController`）にする。

---

## 9. index.js の改修

- `processUserMessage` の agentic loop（`for turn ... tool_use ...`）を撤去し、`QueryEngine.run(userText)` を呼ぶ薄い層に。
- **UI関数は流用**: `addCandidateMarkers`（full/partial/none で色分け・E）、`_showChoicePanel`（Mode1ボタン）、`_showHintPanel`（Mode2自由記入）、固定文表示、フィードバックボタン（done/continue/restart）。
- マーカーは**上限なしで全件表示**（O）。full/partial/none を色で区別し、ポップアップに「一致した条件の内訳」を出す。
- デバッグ描画（`_dbg*`）は流用してよい。

---

## 10. テスト・受け入れ基準（P）

`tests/`（または `readme/20260704_majorupdate/` 配下）にゴールデンセットと自動実行ハーネスを作る。

- **L1 fixtureテスト**: 代表クエリ10〜20件について、期待QuerySchema（人手で確定）を fixture 化。`parseQuery` の出力を fixture と突き合わせ、enum/構造の一致を検証（LLM揺れの検知）。※完全一致が難しいフィールドは構造・enumレベルで検証。
- **JS決定性テスト**: 同一QuerySchema＋モックAPI応答を入力し、`QueryEngine` の分類結果（full/partial/none のID集合）が常に同一になることを検証（JSは決定論であるべき）。
- **距離テーブルテスト**: 各level/methodで circle/isochrone/building_id が正しく選択されることを単体検証。
- **代表シナリオ（最低これらは通す）**:
  1. 「西大島駅近くのマンション、バス停が目の前、ローソンがすぐ隣」→ full候補が出る
  2. 「入谷のマンション」で 入谷 が台東/足立の2件 → Mode1ボタンが出る
  3. 「イオンモールの近くのマンション」（他に地名なし）→ B1で明確化文
  4. proximity欠落クエリ → 場所を聞く固定文
  5. condition物がエリア内0件 → 注記＋partial/参考で候補は出る（S）
  6. 「駅から車で5分のホテル」→ isochrone(driving,5) で評価

**各段階の受け入れ**: §11のフェーズごとに、該当シナリオが手動またはテストで通ることを確認してからコミット。

---

## 11. 実装フェーズ（この順で）

| Phase | 内容 | 完了条件 |
|---|---|---|
| **P0** | ブランチ作成・新規空モジュール・config定数追加・index.htmlにscript追加 | ページがエラーなく起動 |
| **P1** | `distance-table.js` / `query-schema.js`（型＋バリデータ＋デフォルト補完）＋単体テスト | 距離テーブル・バリデータのテスト緑 |
| **P2** | `llm-client.js`（L1/L2）＋ `prompts/prompt.js` 再編＋L1 fixtureテスト | 代表クエリでschemaが正しく出る |
| **P3** | `mapbox-mcp.js` 改修（不要ツール削除・`resolveBBox`統合・`evaluate_distance`改修・timeout） | 純関数として各検索/評価が単体で動く |
| **P4** | `query-engine.js`（一次検索：anchors/span/方角/駅出口/二重bbox/B1/B2） | シナリオ2,3,4 が通る |
| **P5** | `query-engine.js`（二次検索：Step1収集＋ノイズ除去＋Step2評価＋分類＋isochrone最適化） | シナリオ1,5,6 が通る |
| **P6** | `index.js` 結線（UI・フィードバック・キャッシュK・明確化ループHH・エラーGG） | 全シナリオ＋継続/やり直しが通る |
| **P7** | ゴールデンセット整備・回帰テスト自動化・旧コードの deprecated 整理 | テスト一式緑・デモ通し確認 |

---

## 12. 迷ったときの原則

- 仕様に無い挙動を発明しない。設計書に無ければ**止めて質問**。
- 「LLMに任せようか」と迷ったら **JSでやる**（数値・分岐・文言は必ずJS）。
- 「広く出すか絞るか」で迷ったら **広く出す**（見逃し回避優先・I）。
- 既存の動く実装がある機能を再発明しない（§1-5）。

---

*本書は `systemdesign_20260704.md` / `flowdetail_20260704.md` と一体。3点セットで参照すること。*
