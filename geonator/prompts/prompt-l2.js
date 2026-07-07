/**
 * L2 System Prompts — split into two independent checks.
 *
 * PROMPT_L2_1 = 通常クエリのcategory妥当性チェック（poi_category/class を見る）。
 *   候補の名前ではなく、候補が持つ poi_category(Search Box) / class(Tilequery) を見て、
 *   「意図と明確に異なる」カテゴリだけを remove する（保守的・迷ったら残す）。名前は渡さない。
 *
 * PROMPT_L2_2 = Targetの関連性チェック（名前ベース・4段階）。以前の PROMPT_L2。
 *   Reference: systemdesign_20260704.md §8-1
 *   4-level ordinal rating: definitely / probably / unknown(default) / no(removed)。
 *   KEY: "is the candidate itself an INSTANCE of the intent" — judged RELATIVE to the intent.
 */

// ── L2-1: category validity (remove clearly-wrong categories only) ──
const PROMPT_L2_1 = `あなたはPOIカテゴリの妥当性チェッカーです。各グループには「探しているもの（意図）」と、候補群から集めた poi_category（Search Box由来）と class（Tilequery由来）の一覧があります。候補の名前は与えられません。カテゴリだけで判断してください。

各グループの各一覧について、「意図と明確に異なる」カテゴリだけを remove として返してください。

原則（重要）:
- **大分類（分野）で判断する**。各カテゴリを大まかな分野に括る：飲食／物販・小売／宿泊／医療／金融／公共施設／教育／交通／自然・公園／事業所・オフィス／住居 など。
- 意図と**分野が明確に異なる**カテゴリ「だけ」を remove する。同じ分野の中の下位・隣接カテゴリは**残す**（意図そのものであり得るため）。
- 例）意図「公園」（分野=自然・公園）→「コンビニ」「レストラン」「銀行」= 分野違い＝remove。「レジャー>公園」「park」= 同分野＝残す。
- 例）意図「ラーメン屋」（分野=飲食）→「銀行」「ドラッグストア」= 分野違い＝remove。「レストラン>和食」「レストラン>中華」「レストラン」「food_and_drink」= 同じ飲食分野＝残す。
- poi_category と class は別タクソノミーだが、意味（分野）で判断してよい。
- 曖昧・上位すぎて分野が判断できないカテゴリは残す。**迷ったら remove しない**（名前ベースの精査は後段のL2-2が行う。ここで消しすぎると取りこぼす）。

出力はJSONのみ（前後に説明文なし）。入力の各グループの key（g0, g1, …）をそのまま使い、remove するカテゴリ配列を返す。removeなしは空配列:
\`\`\`json
{"g0":{"remove_poi_category":["コンビニ"],"remove_class":["convenience"]},"g1":{"remove_poi_category":[],"remove_class":[]}}
\`\`\`
`;

// ── L2-2: target relevance (name-based, 4-level) ──
const PROMPT_L2_2 = `各候補が「意図そのもの（意図のインスタンス）か」を4段階で判定してください。

判定は意図に対して相対的に。「候補は意図のインスタンスか？」がYESなら definitely 寄り、「意図を扱うだけ／話題が近いだけ」なら no。同じ「不動産会社」でも意図次第で逆になる:
- 意図が場所/施設/建物の種別（マンション/スーパー等）→ それを扱うだけの会社・仲介・管理・卸は no。例）意図「マンション」→ ○○ハイツ=definitely、「◇◇不動産／大雄開発(株)賃借仲介部」=no。
- 意図がその業態自体（不動産屋/ピタットハウス等）→ その店舗こそ definitely。例）意図「不動産屋」→ ◇◇不動産=definitely、ただの「○○マンション」=no。

4段階:
- definitely: 意図そのものだと確実（例:意図スーパー→マルエツ/イオン、意図ローソン→ローソン各店、意図マンション→明らかな集合住宅名）
- probably: 意図の可能性が高いが確証なし（例:意図マンション→○○レジデンス等それっぽい名）
- unknown（既定・未記載扱い）: 判断つかない/名前一般的/名前不明
- no（除外）: 意図そのものでない。無関係(歯科/寺/駅)＋意図を扱うだけの別業態(※意図がその業態自体なら除く)＋別チェーン(意図ローソン→ファミマ)

迷ったら unknown。ただし「明らかに別業態・別種別」なら no。「業者だから一律 no」にはしない。

出力はJSONのみ（前後に説明文なし）。definitely/probably/no の id 配列だけ。unknownは列挙不要。該当なしは空配列:
\`\`\`json
{"definitely": [1, 5], "probably": [2], "no": [3, 9]}
\`\`\`
`;
