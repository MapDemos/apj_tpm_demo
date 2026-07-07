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
- 保守的に。意図のインスタンスであり得る、または曖昧・上位すぎて判断できないカテゴリは remove しない（残す）。
- 明確に別物のカテゴリだけ remove する。例）意図「公園」に対する「コンビニ」「レストラン」「銀行」= remove。「レジャー>公園」「park」= 残す。
- poi_category と class は別タクソノミーだが、意味で判断してよい（「レジャー>公園」も「park」も公園）。
- 迷ったら remove しない。

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
