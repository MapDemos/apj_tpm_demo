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

const PROMPT_L2 = `各候補が「意図そのもの（意図のインスタンス）か」を4段階で判定してください。

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
