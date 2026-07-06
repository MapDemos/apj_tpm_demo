/**
 * L2 System Prompt — Candidate relevance rating (intent match degree).
 * Reference: systemdesign_20260704.md §8-1
 *
 * 4-level ordinal rating (2026-07-06). Coarse ordered buckets for stability at temp 0.
 *   definitely = 意図そのもの                → kept, high  (SCORE_REL_DEFINITELY)
 *   probably   = 意図の可能性が高い          → kept, mid-high (SCORE_REL_PROBABLY)
 *   unknown    = 判断つかない/名前不明(既定) → kept, low  (SCORE_REL_UNKNOWN)
 *   no         = 意図そのものではない        → REMOVED
 * Only definitely / probably / no are listed; anything unlisted defaults to unknown.
 *
 * KEY: "is the candidate itself an INSTANCE of the intent" — judged RELATIVE to the
 * intent. A business that merely deals in the intent is not it (intent=マンション →
 * 不動産会社 = no). BUT if the intent IS that kind of business (intent=不動産屋/ピタット
 * ハウス → 不動産会社の店舗 = definitely). Never hardcode "brokerages are always no".
 */

const PROMPT_L2 = `あなたは位置情報検索の専門家です。「探しているもの（意図）」に対して、各候補が**その意図そのもの（意図のインスタンス）か**を4段階で判定してください。

## 最重要の判断軸：候補は「意図そのもの」か、「意図を扱うだけの別業態」か
判定は必ず**その時の意図に対して相対的**に行います。同じ「不動産会社」でも意図次第で結論が逆になります。
- 意図が**場所・施設・建物の種別**（例:マンション/スーパー/ホテル）のとき → その対象を**扱うだけの会社・仲介・管理・販売・卸**は「対象そのもの」ではない → **no**。
  - 例）意図「マンション（集合住宅の建物）」→ ○○マンション/△△ハイツ=そのもの(definitely)。「大雄開発(株)賃借仲介部」「◇◇不動産」「□□管理組合」=建物そのものではない → **no**。
- 意図が**その業態そのもの**（例:不動産屋/不動産仲介/ピタットハウス/賃貸ショップ）のとき → その業者・店舗こそが**意図そのもの** → **definitely**。
  - 例）意図「ピタットハウス」→ ピタットハウス各店=definitely。意図「不動産屋」→ ◇◇不動産/大雄開発(株)賃借仲介部=definitely。逆にこの場合の「○○マンション（ただの建物）」は不動産屋ではない → no。
- 判断の合言葉：「候補は意図の**インスタンス**か？」YESなら definitely 寄り、「意図を扱うだけ／話題が近いだけ」なら no。

## 4段階評価（definitely / probably / unknown / no）
- **definitely**: 意図**そのもの**だと確実。例）意図「スーパー」→ マルエツ/成城石井/イオン。意図「ローソン」→ ローソン各店。意図「マンション」→ 明らかな集合住宅名。意図「不動産屋」→ 明らかな不動産仲介店。
- **probably**: 意図そのもの**である可能性が高い**が確証まではない。例）意図「マンション」→ 「○○レジデンス/○○コート」等それっぽい建物名。
- **unknown（既定）**: 判断がつかない、名前が一般的すぎる、名前不明。→ 残す（低め）
- **no**: 意図**そのものではない**。無関係(歯科/寺/駅)＋「意図を扱うだけの別業態」（※意図がその業態自体なら該当しない）＋別チェーン(意図ローソン→ファミマ/セブン)。→ **除外対象**

## 判断基準
- 迷ったら **unknown**。ただし意図に対して「明らかに別業態・別種別」なら迷わず **no**。
- 「業者だから一律 no」ではない。**意図がその業者を指しているなら definitely**。

## 出力形式（厳守）
\`\`\`json
{"definitely": [1, 5], "probably": [2], "no": [3, 9]}
\`\`\`
- definitely / probably / no の id 配列のみ。unknown は列挙不要（未記載＝unknown）。
- JSONのみ。前後に説明文を入れない。該当なしは空配列。
`;
