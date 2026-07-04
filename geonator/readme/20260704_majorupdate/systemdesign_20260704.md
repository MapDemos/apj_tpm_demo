# Geonator JS主導アーキテクチャ 概要設計書

**作成日**: 2026-07-04
**バージョン**: 2.0（設計確定フェーズ）
**位置づけ**: ステップ①（概要設計）の最終成果物。この文書と `flowdetail_20260704.md` が仕様の正（source of truth）。実装は `implementation_instructions_20260704.md` に従う。

---

## 1. ツールの目的

Geonatorは、曖昧な自然言語の説明（「西大島駅近くのマンション、バス停が目の前、ローソンがすぐ隣」等）から位置を特定するAIエージェントツールである。緊急通報オペレーター支援・配車支援デモとして使用される。

**優先事項（この順で優先）**:
1. **精度・網羅性** — 候補の見逃しは過検出より危険。**広く拾ってオペレーターに見せる**。
2. **安定性・再現性** — 同じ入力には同じ結果。
3. **コスト効率** — 不要なLLM呼び出しを排除。

**思想の根幹**: ユーザーが見ている世界と地図データベースは常にわずかにズレる（例：新しくできた店がまだDBに無い）。これは技術的に完全解決できない。したがって「条件で絞り込む」のではなく「一致しそうな候補をできるだけ広く提示する」設計とする（→ conditionsはOR評価、§5-4）。

---

## 2. 設計思想

### 2-1. LLMとJSの役割分担

| 担当 | 役割 |
|---|---|
| **JS** | フロー制御、APIコール実行、計算処理、UI制御、固定テキスト表示、全ての数値・しきい値・分岐判定 |
| **LLM** | 意味解釈のみ（**L1・L2の2箇所だけ**） |

**LLMが呼ばれるのは以下の2箇所のみ：**
- **L1**: ユーザー入力 → QuerySchema（構造化データ）への変換（＋Query Expansion＋specificity分類）
- **L2**: Step1で取得した候補 → 探索対象に明らかに合わないIDの除外（ネガティブフィルタ）

**L3（曖昧さ解消）はLLMではない**: Search Boxが返した有限候補をボタンUIで提示し、**ユーザーが選ぶ**。LLM不関与。

### 2-2. 設計原則

- **JSがフロー主導**: 現アーキテクチャ（LLMがツールを自律ループ）と真逆。LLMはJSから問われたときだけ応答する。
- **数値はすべてJS所有**: 距離・半径・分数・しきい値・上限は全てJS定数（§6の距離テーブル等）。LLMには「どのlevel/methodか」を選ばせるだけで、生の数値（メートル・分）を発明させない。
- **固定テキスト**: 対話パネルのシステムメッセージはJSが事前定義。LLM生成は一切なし（§5-3の一覧が全て）。
- **スキーマ駆動**: ユーザー入力はQuerySchemaに当てはめる。当てはまらない条件は `unsupported` に格納。
- **ユーザーインタラクションの制限**: 自由記入は「探索依頼」と「追加ヒント」のみ。それ以外はボタン選択。
- **二段検索**: 一次検索（proximity → bbox確定）→ 二次検索（Step1候補洗い出し → Step2距離評価）。

### 2-3. このバージョンで廃止した概念（実装者は作らないこと）

| 廃止対象 | 理由 | 代替 |
|---|---|---|
| `route_between` を独立typeにする | proximityを複数アンカーのリストにすれば N≥2 の自然な帰結として吸収できる | `proximity.anchors[]` が2点以上（§4-1, §7-2） |
| `landmark_bearing`（〜が左手に見える） | スカイツリー等は遠方から見え、一次検索bbox外になり情報として無意味 | 「どれぐらい近いですか？」と聞き返し、通常のconditionに読み替え（§5-2） |
| `visible`（見える系の独立level） | 定義が対象依存で発散する。不要な複雑さ | method（radius/isochrone）をLLMが言葉で振り分ける方式に一本化（§6） |
| 複合proximity（scope+anchor / 入谷駅のセブンをproximityにする） | 「proximity=最も一意な場所、他はcondition降格」ルール（§4-2）で統一する方が単純かつ一貫 | セブン等は condition に降格 |
| Step2の個別評価ツール群 | Step1のTilequery取得で代替可能 | `evaluate_distance` に一本化（§8） |

---

## 3. アーキテクチャ全体像

```
┌─────────────────────────────────────────────────────────────┐
│ JS オーケストレーター（フロー主導）                              │
│                                                              │
│  [1] 自由入力 ──► [L1: LLM] ──► QuerySchema                   │
│                                    │                          │
│                    [A: JS構造検証] ◄┘                          │
│                        │ 不備 ──► 明確化（Mode1/2）             │
│                        ▼                                      │
│  [一次検索: JS] proximity解決 → base bbox                     │
│        ├─ [B1: LLM分類結果を見て] genericなら明確化            │
│        ├─ [B2: JS] 同名地名 → ボタン（L3）                     │
│        └─ 方角修飾子/駅出口/複数アンカー span                  │
│                        ▼                                      │
│  [二次検索 Step1: JS] target/conditions を並列収集             │
│        ├─ ノイズ除去: 前方一致 + [L2: LLM] + dedup            │
│                        ▼                                      │
│  [二次検索 Step2: JS] evaluate_distance × conditionTracker    │
│                        ▼                                      │
│  [結果表示: JS] 全マッチ/部分マッチ/マッチなし + 固定文         │
│                        ▼                                      │
│  [フィードバック: JS] 確定 / 継続 / やり直し                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. QuerySchema定義

L1がユーザー入力を変換する構造化データ。JSはこれを元に全処理を駆動する。

```json
{
  "proximity": {
    "anchors": [
      {
        "type": "station | poi | address | locality",
        "text": "西大島駅",
        "specificity": "specific | generic",
        "subtype": { "exit": null }
      }
    ],
    "bearing_filter": null
  },
  "target": {
    "type": "residential_building | commercial_building | general_poi",
    "text": "マンション",
    "query_intent": "category_building | specific"
  },
  "conditions": [
    {
      "type": "poi | road | water | intersection | signal | transit_entrance | category_busstop",
      "text": "ローソン",
      "query_intent": "specific",
      "distance": {
        "method": "radius | isochrone",
        "level": "adjacent | very_close | nearby | somewhat_nearby | same_building",
        "profile": null,
        "minutes": null,
        "meters": null
      }
    }
  ],
  "unsupported": []
}
```

### 4-1. proximity（必須・アンカーのリスト）

- **必ず1つ以上のアンカーが必要**。proximityが解決できないと処理は進めない（§7-1、DDで確定）。
- `anchors.length == 1` → そのアンカーを中心に bbox を描く。
- `anchors.length >= 2` → 全アンカーを内包する span bbox を描く（「AとBの間」「AとBとCの間」）。
- span が bbox 上限（§6-2）を超える → ユーザーにpushback（「範囲が広すぎます」）。
- **アンカーになれるのは「一意に特定できる場所」だけ**（駅・住所・地名・一意なランドマーク）。generic（コンビニ・モール等の一般カテゴリ）はアンカーにならず condition に降格する（§4-2）。

**anchor.type と bbox確定方法:**

| type | 意味 | bbox確定方法 |
|---|---|---|
| `station` | 駅名（出口あり/なし） | 出口あり→出口座標＋radius、出口なし→全出口から span bbox（§7-2） |
| `poi` | 一意な施設・ランドマーク（渋谷109等） | Search Box → 座標＋radius（§6の距離） |
| `address` | 丁目・番地レベル | Search Box → 座標＋radius |
| `locality` | 地名・エリア（入谷等） | Search Box → bboxをそのまま使用（同名複数ならL3ボタン） |

- `specificity`: L1が付与。`generic`（一般カテゴリ）のアンカーは B1 の対象（§5-1）。**唯一のアンカーがgenericなら明確化**、他に一意なアンカーがあればそちらを使う。
- `bearing_filter`: `"north" | "south" | "east" | "west" | null`。「駅の北側」等。方角は北西→北・北東→北・南西→南・南東→南と**4方位に丸める**（L1が標準化）。base bbox（circle/isochrone/span）を中心線で半分にカットする修飾子（§7-3）。

### 4-2. L1のproximity/condition役割分担ルール（最重要）

> **proximity には、クエリ中で最も一意に特定できる場所を1つ（または同格複数）選ぶ。それ以外の場所言及はすべて condition に降格する。**

例:
- 「入谷駅のイオンモールの中のスタバ、近くにセブン」
  → proximity: 入谷駅 / target: スターバックス / conditions: イオンモール(same_building), セブン(very_close)
- 「入谷駅近くのマンション、バス停が目の前、ローソンがすぐ隣」
  → proximity: 入谷駅 / target: マンション / conditions: バス停(adjacent), ローソン(adjacent)
- 「渋谷109と東京タワーの間のホテル」
  → proximity.anchors: [渋谷109, 東京タワー]（span bbox）/ target: ホテル

このルールにより generic（イオンモール等）は自然に condition へ流れ、genericでも問題なくなる（same_building等で評価するだけ）。B1が発動するのは「**唯一の手がかりがgeneric**」なとき（例：「イオンモールの近くのマンション」で他に地名なし）だけ。

### 4-3. target（必須・1つ）

- `type`: `residential_building`（マンション/アパート等）/ `commercial_building`（ビル等）/ `general_poi`（ホテル/飲食店/コンビニ等）
- `query_intent`: `category_building`（建物カテゴリ）/ `specific`（固有名・通常POI）
- **必ず1つに絞る**。L1が複数候補を出したらJSが「どちらをお探しですか？」でボタン明確化。
- **targetがgenericでもOK**（「コンビニ」を探す＝大量ヒットが正常）。B1のgenericチェックは **proximityアンカーにのみ**適用し、targetには適用しない（非対称性）。

### 4-4. conditions[]（任意・複数可・OR評価）

- `type`: `poi`（コンビニ・飲食店等）/ `road`（大通り・国道）/ `water`（川・海・湖）/ `intersection`（交差点）/ `signal`（信号機）/ `transit_entrance`（駅出口）/ `category_busstop`（バス停カテゴリ）
- `query_intent`: `specific` 等（poiのみ）
- `distance`: §6の距離オブジェクト。
- **OR評価**: どれだけ絞るかではなく、どれだけ一致しそうな候補を出すか。全conditionクリア＝全マッチ、一部＝部分マッチ、0＝マッチなし（いずれも表示する。§5-4）。

### 4-5. unsupported[]

L1がどのtype/conditionにも当てはめられなかった条件を自由記述で格納（事前定義なし）。

```json
"unsupported": ["建物の3階にある", "壁が赤い"]
```

JSは空でなければ固定テキスト「以下の条件は現在対応していませんが、他の情報で検索を進めます：〜」を表示する。

---

## 5. 検証・明確化

### 5-1. 検証の三層（A / B1 / B2）

| 層 | 内容 | 判定者 | タイミング | 例 |
|---|---|---|---|---|
| **A. 構造検証** | schema自体の整合（target個数、必須欠落、enum違反、distanceの整合） | **JS**（決定論・無料） | L1直後（API前） | targetが複数 / proximity欠落 |
| **B1. 汎用性検証** | proximityアンカーが一般カテゴリで一意特定不能 | **LLM**（L1の`specificity`を見てJSが判定） | API前 | 「イオンモール」が唯一の手がかり |
| **B2. 同名解決** | 実在する別々の場所が同名 | **JS**（Search Boxの`context`/region差で判別）→ **ボタン** | 一次検索中（API後） | 台東区入谷 vs 足立区入谷 |

**多層防御の原則**: B1は「早期・安価な足切り」、B2は「最終防衛線」。B1が漏れてもB2（Search Box複数→ボタン）が拾う。**B1の誤爆（弾きすぎ）だけは実害が大きい**ので、B1は明確な一般名詞（コンビニ・スーパー・モール等）に限定し、固有名っぽいものは触らずB2に流す。

### 5-2. 明確化の2モード

| | Mode 1：ボタン（JS完結・再L1なし） | Mode 2：自由記入（L1再実行） |
|---|---|---|
| **使う条件** | 決定時点で**有限の選択肢が手元にある** | ユーザーから**新情報**が要る |
| **例** | 台東区入谷 vs 足立区入谷（Search Boxが2件返した） | 「どこからの距離ですか？」「出口番号は？」「どのイオンモール？地名も」「スカイツリーはどれぐらい近い？」 |
| **処理** | JSがボタン描画→クリック→その結果のbboxを直接採用 | ユーザー入力→元クエリに連結→L1再実行→新schema→再検証 |

**上限（HH）**: 明確化は最大 **3回**（`MAX_CLARIFY_TURNS`）。超えたら「情報が不足しています。分かる範囲で場所を教えてください」でベストエフォート検索に進むか打ち切る。

### 5-3. 固定テキスト一覧（LLM生成禁止・これが全て）

| タイミング | テキスト |
|---|---|
| 起動時 | 「探している場所を教えてください。近くの駅名・施設名・住所と、条件（近くのお店・道路など）を一緒に伝えていただくと絞り込めます。」 |
| target複数 | 「〇〇と〇〇、どちらをお探しですか？」＋ボタン |
| proximity同名（B2） | 「〇〇はどちらですか？」＋ボタン |
| proximity generic（B1） | 「〇〇は複数あります。地名や駅名も一緒に教えてください。」 |
| proximity欠落 | 「どのあたりをお探しですか？地名や駅名を教えてください。」 |
| 距離だけで対象不明 | 「〇〇とありますが、どこからの距離ですか？」 |
| 遠すぎ（level=far/上限超過） | 「その範囲は広すぎます。もっと近い目印を教えてください。」 |
| 範囲広すぎ（span上限超過） | 「その範囲は広すぎます。もっと絞れる情報を教えてください。」 |
| 候補検索中 | 「候補を検索しています…」 |
| 対応不可条件あり | 「以下の条件は現在対応していませんが、他の情報で検索を進めます：〇〇」 |
| 条件がエリア内に0件（S） | 「〇〇はこのエリアで見つかりませんでした（地図データ未収録の可能性があります）。」 |
| 結果あり | 「〇件見つかりました（全マッチ：N件、部分マッチ：M件、参考：K件）」 |
| メイン0件（L） | 「〇〇の近くに〇〇は見つかりませんでした。追加の情報を教えていただけますか？」 |
| メインあり条件0（L） | 「条件に完全一致する候補はありませんでしたが、〇件を参考として地図に表示しています。」 |
| 通信エラー（GG） | 「通信エラーが発生しました。もう一度お試しください。」 |
| 継続時 | 「さらに絞り込む情報を教えてください（例：出口番号、近くの交差点名、建物の特徴など）。」 |
| 確定 | 「ありがとうございました。またお気軽にご相談ください。」 |

### 5-4. 結果の分類（E / I）

- **全マッチ（full）**: 全conditionをクリア
- **部分マッチ（partial）**: 一部conditionをクリア
- **参考（none）**: 0condition（メイン候補ではあるが条件に当たらない）

3分類すべて地図に表示する（O：マーカー上限なし。地図は表示専用でロジック非関与）。ランキング・番号は不要（ランダム順でよい）。各マーカーには「どのconditionにどれだけ一致したか」を表示する。分類はJSの `conditionTracker` が機械的に決定する。

---

## 6. 距離テーブル（single source of truth）

**全ての距離・近接評価はこの1テーブルを参照する**（proximityの"近く"にも、conditionの距離にも同一適用）。数値は全てJS定数。

### 6-1. levelテーブル（数値をロック）

| level | 表現例 | 半径（radius method） | isochrone等価（isochrone method・徒歩） |
|---|---|---|---|
| `same_building` | 同じビルの中 | building-id比較（距離ではない） | — |
| `adjacent` | 目の前・すぐ隣・すぐ横 | **30m**（circle固定） | —（常にcircle） |
| `very_close` | すぐ近く・出てすぐ | **120m** | 約2分 |
| `nearby` | 近く・付近・そば | **350m** | 約5分 |
| `somewhat_nearby` | 少し歩く | **700m** | 約9分 |
| `far` | かなり遠い | 距離条件として使わない（→ pushback） | — |

（徒歩≒80m/分で半径とほぼ同サイズになるよう定義。ユーザーが「徒歩5分」「200m以内」等の具体数値を入力した場合は、テーブルより優先してその値を使う。）

### 6-2. method の振り分け（LLMが言葉で選ぶ・JSが数値を引く）

- **isochrone を使うケース**: 「歩いて」「自転車で」「車で」など移動手段を含む、または「x分」など時間指定がある、つまり半径では断定できないケース。
  - `method="isochrone"`, `profile ∈ {walking, cycling, driving}`（未指定なら walking）, `minutes`（明示時間があれば。無ければlevelの等価分数）。
- **radius を使うケース**: 上記以外の曖昧語（近く・すぐ近く等）や明示距離（「500m以内」）。
  - `method="radius"`, level から半径を引く。明示距離があれば `meters` を直接使う。
- **距離語なし**: JSがデフォルト `level=very_close` / `method=radius`（250m）で埋める（M・DEFAULT_LEVEL）。
- `same_building` / `adjacent` は特別扱い（id比較 / 50m circle固定）。

### 6-3. bbox上限

一次検索bboxには面積上限がある。`far`（level上限超過）や span超過を検出したらpushback（§5-3）。**上限判定は target(span) bbox に対して行い、conditionマージン拡張（§7-4）は上限判定の対象外**（conditionのはみ出しは許容・EE）。

---

## 7. 一次検索（proximity → bbox）

### 7-1. 全体

proximity.anchors[] を解決して base bbox を確定する。**proximityが1つも解決できなければ処理を進めない**（固定文で場所を聞く）。

### 7-2. アンカー数による分岐（AA）

```
anchors を全て Search Box 等で座標解決
  │
  ├─ 1点  → 中心 + radius（§6の距離。距離語なければ既定extent）で bbox
  └─ N≥2点 → 全点を内包する span bbox（compute_bbox_from_points 相当）
                └─ span が上限超過 → pushback
```

**station（駅）の特別処理（C-2）:**
- 出口指定なし: Search Box→駅座標 → Tilequery(streets-v8, transit_stop_label, stop_type=entrance) で全出口取得 → 全出口から span bbox。
- 出口指定あり: 全出口取得 → 名称一致の出口座標を確定 → その座標 + radius。
- これは一次検索の中でJSがオーケストレーションする。

### 7-3. bearing_filter（方角修飾子）

base bbox（circle/isochrone/span いずれか）を確定後、`bearing_filter` があれば中心を通る線で半分にカットする（「北側」→北半分を残す）。処理順は §7-4 の末尾。

### 7-4. 二重bbox（C(2)・target厳守／condition広め）

**targetとconditionで収集bboxを分ける**：

```
① proximity解決 → base bbox
② bearing_filter があれば base bbox を方角カット
③ target収集bbox   = ②の bbox（タイト・"近く"の前提を厳守）
④ condition収集bbox = ②の bbox を max(全conditionの距離) だけ四方に拡張
```

- target候補は③のタイトなbboxで収集（proximity前提を守る）。
- condition候補は④の広いbboxで収集（端のtarget候補の隣にある条件物を取りこぼさない）。
- 拡張量は**倍率ではなく絶対マージン = max(condition距離)**。
- 方角カット後にconditionマージンで拡張すると南側が少し戻るが、conditionのはみ出しとして許容（U）。target収集は方角限定を守る。

---

## 8. 二次検索

### 8-1. Step1: 候補洗い出し（JS）

- target を target収集bbox（§7-4③）で収集。
- conditions[] を condition収集bbox（§7-4④）で並列収集。
- **クエリ種別ごとのAPI**は §8-3。
- **ノイズ除去は全クエリ結果に一律適用（B）**：
  1. **前方一致フィルタ**（JS）: specific POI（ローソン等）は名前が condition/target の text に前方一致するものだけ残す。ブランド系の負引きは `data/poi-blocklist.js`（建物カテゴリ）。
  2. **L2ネガティブフィルタ**（LLM）: 全候補リストを渡し、明らかに対象外のIDを除外。**保守的に**（曖昧なものは残す。見逃し回避優先・R）。
  3. **dedup**（JS）: 既存の座標ベースdedup（`dedupKey`/`seen`）を継続（F）。
- カテゴリ系（バス停 mode=bus・交差点 class=intersection 等）は元々均質なのでL2は空振りになるが、実装単純化のため一律適用でよい（B）。

### 8-2. Step2: 距離評価（JS）

- 各メイン候補 × 各condition を `evaluate_distance` で評価。
- `distance.method` により内部実装を切替：`same_building`→building-id比較、`adjacent`→turf.circle(50m)、`method=radius`→turf.circle、`method=isochrone`→Isochrone API。
- **isochroneコスト最適化（FF）**: 「アンカー×level」単位でisochroneを1回だけ計算し、そのポリゴンに対して同levelの全conditionを point-in-polygon 判定する（condition数ぶんAPIを叩かない）。
- `conditionTracker` が各メイン候補のクリア数を記録 → full/partial/none を機械決定（§5-4）。
- **conditionがエリア内に0件だった場合（S）**: そのconditionは全候補がmiss扱い（OR評価で自然に吸収）。加えて「〇〇はエリア内に見つからず」を固定文で注記。

### 8-3. クエリ種別一覧

| クエリ種別 | API | タイルセット | レイヤー/フィルタ | L2 |
|---|---|---|---|---|
| 居住系建物（マンション/アパート） | Tilequery | streets-v8 | poi_label（グリッド） | 適用 |
| 商業系建物（ビル） | Tilequery | streets-v8 | poi_label（グリッド） | 適用 |
| 通常POI（ホテル/飲食店/コンビニ） | Search Box + Tilequery | — / streets-v8 | — / poi_label | 適用 |
| バス停（名称指定） | Tilequery | 10da032y.busstop_gov_0608 | — | 一律適用（空振り可） |
| バス停（カテゴリ・位置） | Tilequery | streets-v8 | transit_stop_label, mode=bus | 一律適用 |
| 交差点 | Tilequery | streets-v8 | road, class=intersection | 一律適用 |
| 信号 | Tilequery | streets-v8 | road, class=traffic_signals | 一律適用 |
| 駅出口 | Tilequery | streets-v8 | transit_stop_label, stop_type=entrance | 一律適用 |
| 道路（条件） | Tilequery | streets-v8 | road, class=primary/secondary等 | 一律適用 |
| 水域 | Tilequery | streets-v8 | water, waterway | 一律適用 |
| 建物ID確認 | Tilequery | streets-v8 | building | — |

---

## 9. ツール（内部関数）体系

### 9-1. 評価ツール

| ツール | 役割 |
|---|---|
| `evaluate_distance` | アンカーから候補が指定距離/時間以内かを判定。`distance` の method/level/profile/minutes/meters に応じて circle / isochrone / building-id を内部で使い分ける（§8-2）。 |

### 9-2. bbox計算ユーティリティ（統一・C-3）

**現状3箇所に散らばっているbbox計算を1つの `resolveBBox` に集約する**：
- `radius_meters → bbox`（現 `_searchNearbyPOI` 内インライン）
- `compute_bbox_from_points`（点群 → bbox）
- `calculateMidpointBBOX`（2点 → bbox, spatial-utils.js）

→ 入力「点群 / 中心+半径 / 複数点span」を吸収する単一関数にし、**一次検索も二次検索も同じ関数を通す**（isochrone/radius/span/方角カットは「領域外を候補から外す」同一ファミリーとして仕様を揃える）。

### 9-3. 廃止するツール（削除）

`get_facing_road` / `scan_natural_features` / `find_intersections` / `find_traffic_signals`（→Step1 Tilequery取得で代替）、`compute_area_from_landmark_bearing`（landmark_bearing廃止）、`get_midpoint_area`（→`resolveBBox`のN≥2に統合）。

---

## 10. キャッシュ方針（K・3+1粒度）

追加ヒント（Mode2）でL1を再実行しschemaを作り直した後、**変更箇所の依存先だけを破棄**する：

| 変更 | 破棄範囲 |
|---|---|
| proximity が変化 | 一次bbox含め**全破棄・再解決** |
| proximity不変・target変化（マンション→ビル） | bbox保持、**メイン候補だけ再検索** |
| proximity不変・condition変化のみ（追加/削除） | bbox＆メイン候補保持、**二次評価だけ再実行** |
| 変化なし（「もう一回調べて」） | そのまま or 全再実行 |

一次検索bboxは proximity前提が崩れない限り保持する（一貫性・H）。

---

## 11. 運用・堅牢性

- **API失敗・タイムアウト（GG）**: 各API呼び出しに **タイムアウト＋1回リトライ**。それでも失敗なら固定文「通信エラー…」でループ先頭へ。
- **L1不正出力（II）**: L1のJSON出力を **JS側のschemaバリデータ**（enum・必須・型）で検証。失敗ならL1を1回リトライ、それでもダメなら固定文。
- **明確化ループ上限（HH）**: `MAX_CLARIFY_TURNS=3`。
- **回帰テスト（P）**: 代表クエリのゴールデンセット＋自動実行ハーネスを持つ。特にL1のschema出力を固定（fixture）してJSパイプラインの決定性を検証する（§実装指示のテスト章）。

---

## 12. 未確定・将来課題（このバージョンでは扱わない）

- 数量条件（「ローソンが2つ見える」等）
- 過度にネストした制約（「XのAにいて、AはCとDの間」）— L1が最も信頼できる制約を採ってanchors化し、残りはbest-effort。
- 英語・多言語入力（当面日本語のみ想定）。

---

*本書はステップ①（概要設計）の確定版。実装は `implementation_instructions_20260704.md` に従い、`flowdetail_20260704.md` のステップ表を併用すること。*
