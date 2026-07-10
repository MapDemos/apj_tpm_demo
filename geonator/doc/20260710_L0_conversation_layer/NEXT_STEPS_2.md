# geonator — L0会話レイヤ 引き継ぎメモ・続き（2026-07-10 夜時点）

前身の `NEXT_STEPS.txt`（同日午後時点）を読んだ後、その日のうちに続きを進めた分の
引き継ぎ。前身の1〜6章の内容はまだ有効。ここでは前身の「3. まだできていないこと」
①〜⑦のうち何が終わり、何が残っているかを更新する。

設計ドキュメント： `doc/20260710_L0_conversation_layer/design.md`
永続メモリ： auto memory の `project_l0_conversation_layer`（MEMORY.md から辿れる）

直近のコミット履歴（新しい順、前身メモ以降）：
```
b94949a フィードバック自由文をL0がdone/narrow/researchに振り分け
58e60e4 処理ビューOFF時に候補パネルを折りたたみ表示に
4348ccc describeResultsのmax_tokens不足によるJSON破損を修正
89e1a37 処理ビュートグルを追加(tool-status/proc-noteのみ対象)
21e2122 確度コメントに上位5件の紹介(名前・条件・件数)を統合
8173ac8 確度コメント機能を追加(design.md §6)
6f3d277 ヘッダーを簡素化し設定を4タブ(一般/会話/処理/判定方式)に再編
69f1bc9 断片合成をintentに関わらず有効化+上限を設定可能に
c091b91 復唱をL1-2のschema確定後に移す(先走り発話バグの根本解消)
96921a8 指示語だけの発話で「現在地」等を捏造するバグを修正
7ee9fde 断片合成フォーマットを改善+連続失敗に上限を追加
0e135b6 断片的な場所探し依頼が無言で終わるバグ修正(根本+安全網)
7726f42 多ターン記憶＋intent分類(JSON化)を追加(フェーズ1・2)
```

---

## 1. 前身メモ③〜⑦の進捗更新

**④L0の多ターン記憶** → **完了**（7726f42）。`_convHistory`（QueryEngine側、
`{role:'user'|'l0', text}[]`、`config.L0_HISTORY_MAX_TURNS`=10件でトリム、
`_resetCache()`ではクリアしない）。converse/confirmSchema/describeResults/
classifyFeedback すべてこの履歴を渡している。

**①L0の本格ルーター化** → **一部前進、まだ本命は未着手**。今回入ったのは
「復唱(confirmSchema)」「結果説明(describeResults)」「フィードバック自由文分類
(classifyFeedback)」の3つの新しいL0呼び出し（すべて`PROMPT_L0`の同じペルソナに
角括弧プレフィックスで認識モードを追加する形）。ただし「新規検索か／条件追加か／
雑談か／ミッション外か」という**intentそのものの意味分類**は7726f42で`converse()`
がJSON`{intent, reply}`を返すようになった時点で実質的にこれが本体。つまり①の
「本命」は**この時点でほぼ達成済み**——ただし`intent`の使われ方は限定的（chatter/
off_mission即返信の判定と、`_markFragmentaryAttempt`のoff_mission除外のみ）。
new_search/refineの区別自体がL1-2の`parseQuery`成否に実質委ねられている点は
変わっていない。次にやるなら「intentをもっと積極的に分岐に使う設計」を検討する
価値はあるが、決定性契約（design.md §2）を破らない範囲で、という制約は不変。

**⑤確度コメント（tier由来）** → **完了**（8173ac8, 21e2122, 4348ccc）。
`_computeConfidenceLabel(fullCount, partialCount)`でJSが決定的にdecisive/
ambiguous/tentative/noneを判定し、`_buildResultsSummary()`で上位5件の名前・
スコア・満たす条件・総件数をテキスト化、`LLMClient.describeResults()`が
自然文に言い換える。バグ修正済み：`describeResults`のmax_tokensが220では
「先に自然文の下書きを書いてからJSONに書き写す」パターンで打ち切られJSON破損
→バレアな固定文フォールバックが頻発、の問題を発見（Playwrightでネットワーク
インターセプトして`stop_reason:"max_tokens"`を確認）。max_tokens 220→500、
かつプロンプトに「JSONの前に下書きを書くな」を明記して解消（4348ccc）。
修正後、複数回の連続テストで`stop_reason:end_turn`・候補名を含む正常な返信を
確認済み。

**⑥処理ビュートグル** → **完了**（89e1a37, 58e60e4）。設定モーダル「一般」タブに
ON/OFFボタンを追加（`geonator_ui`localStorageキーに永続化）。OFF時：
- `tool-status`/`proc-note`吹き出しを非表示（`showProcessingNote`/`showRunStats`
  をガード。cap警告だけは常に表示）
- 候補パネル（静的地図込み）は`<details>`で折りたたみ、「▸ 候補を見る（N件）」を
  クリックすると展開（`_renderCandidatePanel`末尾に追加）
- 確度コメント（⑤）がL0の声で上位5件を語るため、パネルを畳んでも情報は失われない

**④の続き（フィードバックボタンのL0振り分け）** → **完了**（b94949a）。
フィードバックパネルの自由文入力を`classifyFeedback()`でdone/narrow/research
に振り分け（旧：常にresearch固定だった）。ボタンクリックは非変更（完全決定的の
まま）。`canNarrow`がfalseの時に`narrow`と判定された場合は`research`にフォール
バックする安全策あり。

**③choice panelの自由文フォールバック** → **未着手のまま**。前身メモの理由
（地名の実在検証が絡む）は変わらず有効。①の設計が進めば合わせて着手。

**②非同期分離の残り（AbortController等）** → **未着手のまま**（前身メモの通り、
ROI低いと判断し見送り継続）。

**⑦音声化（Phase 2）** → **未着手のまま**。

---

## 2. 今回新たに見つかった残務・保留事項

- **候補パネルのOFF時表示、既存セッションで古い状態が残る可能性**：ユーザーが
  「候補パネルの表示がオンのままかも（オフの時）」と一度指摘。折りたたみのロジック
  自体は`_renderCandidatePanel`のレンダリング時点で`this._processingViewOff`を見て
  分岐するため、新規レンダリングでは正しいはず。もし再現するなら「トグルを切り替えた
  タイミングと、既にDOMにレンダリング済みの過去の候補パネルとの整合」を疑うこと
  （過去パネルは再レンダリングされないので、トグル変更前に出たパネルは古い表示の
  ままなのが仕様なのか、バグとして遡って畳むべきかは未確認・要ユーザー確認）。
- **確度コメントのバレアフォールバック再発懸念**：ユーザーが4348ccc適用後も
  「確率順に並べましたが、正直つけがたいです。」が出るかもと懸念を表明。Playwright
  での複数回の再検証（`lastMsg.content.startsWith('[検索結果]')`で正しくフィルタ
  した版）では6回連続で`stop_reason:end_turn`・正常な候補名入り返信を確認できており、
  現状は再現しなかった。ただし以下は未確認：
  - もっと候補数・条件数が多いケース（500トークンでも足りない可能性）
  - ユーザー自身のブラウザがキャッシュ済みの古いJSを掴んでいた可能性
    （`http://localhost`でのハードリロードを依頼済み、回答待ち）
  再発する場合は具体的なクエリを聞いて再現・調査すること。

---

## 3. 次に着手するなら（推奨順、更新版）

前身メモの①④⑤⑥は完了。残る大きな柱：

1. **③choice panelの自由文対応**：地名実在検証（Search Box等）とセットで設計。
2. **候補/選択パネルの番号選択UI**（処理ビューOFF時向け、前身から繰り越し・
   ユーザーが明示的に「ボタンだけ後で」と保留にした項目）。
3. **①のintent活用を深める**：new_search/refineの区別など、まだL1-2の成否任せに
   なっている分岐をL0のintentでより積極的に扱うか検討。
4. ⑦音声化（Phase 2）は上記が固まってから。

軽微な保留（前身メモ4章から未対応のまま）：
`_debugPause`関連デッドコード、`.hint-question`デッドCSS、`roleTool`/`roleNote`
未参照キー——削除可否はユーザー確認待ち。
