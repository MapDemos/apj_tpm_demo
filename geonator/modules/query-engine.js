/**
 * QueryEngine — JS-driven orchestrator. Controls the entire location-finding flow.
 * LLM is called only at L1 (parseQuery) and L2 (filterCandidates).
 * Reference: systemdesign_20260704.md §3, flowdetail_20260704.md
 *
 * UI callbacks are injected via constructor so this module is DOM-independent.
 */

// 線（line）ジオメトリ条件：候補ごとに周囲のレイヤーを見る（point収集しない）。
// road=道路 / water=河川湖沼 / rail=線路（すべて streets-v8 の road/water レイヤー由来）。
const LINE_COND_TYPES = new Set(['road', 'water', 'rail']);
const isLineCond = (type) => LINE_COND_TYPES.has(type);

class QueryEngine {
  /**
   * @param {{ mcp: MapboxMCPClient, llm: LLMClient, ui: UICallbacks, config: object }} opts
   *
   * UICallbacks shape:
   *   showMessage(text: string): void
   *   showChoices(question: string, choices: string[]): Promise<string>
   *   showHintInput(prompt: string): Promise<string>
   *   showSearching(text: string): void
   *   showResults(full, partial, none, summary, conditionLabels, droppedNote): void
   *   showFeedback(): Promise<'done'|'continue'|'restart'>
   *   clearResults(): void
   */
  constructor({ mcp, llm, ui, config }) {
    this.mcp    = mcp;
    this.llm    = llm;
    this.ui     = ui;
    this.config = config;

    // Cache layers (K)
    this._cache = { bbox: null, mainCandidates: null, condCandidates: null, surfaced: null, schema: null };
    this._clarifyCount = 0;
    this._previousText = null;    // for L1 re-parse
    this._awaitingClarify = false; // last run ended asking for more info (main-input answer merges)
    this._ratingCache = new Map(); // L2-2 relevance cache: "intent||name" → definitely|probably|unknown|no (session stability)
    this._catCache    = new Map(); // L2-1 category cache: "intent||sortedCats" → { remove_poi_category:Set, remove_class:Set }
  }

  /** Localized message bundle for the current UI language. */
  _m() { return MESSAGES[this.ui.getLang?.() === 'en' ? 'en' : 'ja']; }

  /** エラー原因を推定して優しい文言に振り分ける（極力「通信エラー」の一言を避ける・デモ配慮）。
   *  タイムアウト/混雑(429)/サーバ(5xx)/長すぎ(切れ)/解釈不能 を区別し、無ければ穏当な既定。 */
  _friendlyError(err) {
    const s = String(err?.message || err || '');
    const M = this._m();
    if (/timeout/i.test(s))               return M.err_timeout;
    if (/HTTP\s*429|rate limit/i.test(s)) return M.err_busy;
    if (/HTTP\s*5\d\d/.test(s))           return M.err_server;
    if (/truncated|max_tokens/i.test(s))  return M.err_toolong;
    if (/unparseable|JSON/i.test(s))      return M.err_understand;
    return M.error_communication; // 穏当な既定（文言から「通信エラー」は撤去済み）
  }

  /** Debug-mode step gate: pause until the operator clicks "next" (no-op otherwise). */
  async _step(stepId, label, lines) {
    if (this.ui.isDebug?.()) await this.ui.debugStep?.(stepId, label, lines || []);
  }

  // ─────────────────────────────────────────────
  // Entry point
  // ─────────────────────────────────────────────

  async run(userText) {
    // If the previous run ended waiting for clarification (e.g. "池袋は複数あります"),
    // the user's main-input answer (「池袋駅」) is merged with the original query so
    // target/conditions are retained.
    const merged = (this._awaitingClarify && this._previousText)
      ? `${this._previousText}\n追加情報：${userText}`
      : userText;
    this._previousText = merged;
    this._awaitingClarify = false;
    this._clarifyCount = 0;
    this._dbgReport = { schema: null, proximity: null, target: null, conditions: [], categoryFilter: [], evaluation: null, excludedByHardFilter: [] };
    // 新規トップレベルクエリは毎回まっさらから。前クエリの候補/bbox/schemaを持ち越さない
    // （前セッションの候補が絞り込み提案に混ざる等のstaleを防ぐ）。絞り込み(refine)は run() を
    // 通らないので影響なし。
    this._cache = { bbox: null, mainCandidates: null, condCandidates: null, surfaced: null, schema: null };
    this.llm.resetStats?.();
    this.mcp.resetRequestCounts?.(); // per-query API caps
    this._runStart = Date.now();
    const gen = (this._runGen = (this._runGen || 0) + 1); // 実行世代（新クエリ/キャンセルで無効化）
    this.ui.clearResults();

    // 確認文を「真っ先に」出すため、軽量な確認文(Haiku)をフルのL1解析(Sonnet)と【並行】発行。
    // 先に返った方を表示（通常Haikuが速い）。L1側の confirmation はフォールバック。
    let confirmShown = false;
    this.llm.confirmInput?.(merged, this._langCode())
      ?.then(msg => {
        if (msg && !confirmShown) { confirmShown = true; this.ui.showMessage(msg); this.ui.thinking?.(); }
      })
      ?.catch(() => {});

    const schema = await this._parseAndValidate(merged, null);
    if (!schema) return; // clarification was handled inside
    if (this._aborted(gen)) return; // キャンセル/新クエリなら以降の描画をしない

    this._dbgReport.schema = schema;

    // 高速確認がまだ出ていなければ（Haiku失敗/解析の方が速かった等）L1の confirmation を表示。
    if (!confirmShown && schema.confirmation) { confirmShown = true; this.ui.showMessage(schema.confirmation); }

    // 除外事項は表示された確認文(Haiku/Sonnet いずれか)に載らないことがあるため、JS側で決定的に
    // 注記する。透明化 A=上限超過の地理条件 / B=非地理的な特徴(壁が赤い等)。両方を1吹き出しに。
    const exNote = this._exclusionNote(schema);
    if (exNote) this.ui.showMessage(exNote);

    // [STEP] QuerySchema — show the parsed intent early so the operator can sanity-check
    // L1's interpretation (target / conditions / distances) before any search runs.
    const anchors = (schema.proximity?.anchors || []).map(a => `${a.text}[${a.type}/${a.specificity}]`).join(', ');
    // Query Expansion (QE) の結果を可視化。展開語が text だけ（=未展開）なのか、同義語まで
    // 出ているのかをデバッグで確認できるようにする（「ラーメン屋」で当たらない等の切り分け用）。
    const qeStr = (o) => {
      const qs = Array.isArray(o?.queries) ? o.queries : [];
      if (!qs.length) return '  展開=（なし）';
      const expanded = qs.length > 1 || (qs.length === 1 && qs[0] !== o.text);
      return `  展開${expanded ? '' : '(未展開)'}=[${qs.join(', ')}]`;
    };
    await this._step('step-schema', '⓪ クエリ解釈 (QuerySchema)', [
      `proximity: ${anchors || '(なし)'}${schema.proximity?.bearing_filter ? ' 方角=' + schema.proximity.bearing_filter : ''}${(() => {
        const w = schema.proximity?.within; if (!w) return '';
        if (w.level) return `  範囲=${({ adjacent: '目の前', very_close: 'すぐ隣' })[w.level] || w.level}`;
        const mn = w.minMinutes ?? null, mx = w.maxMinutes ?? w.minutes ?? null, prof = w.profile || 'walking';
        if (mn != null && mx != null) return `  範囲=${prof} ${mn}〜${mx}分`;
        if (mn != null) return `  範囲=${prof} ${mn}分以上`;
        if (mx != null) return `  範囲=${prof} ${mx}分以内`;
        const met = w.maxMeters ?? w.meters ?? null;
        return met != null ? `  範囲=${met}m以内` : '';
      })()}${schema.proximity?.scope?.text ? `  scope=${schema.proximity.scope.text}` : '  scope=(なし)'}`,
      `target: ${schema.target?.text}  intent=${schema.target?.query_intent}${schema.target?.floors ? '  階数=' + JSON.stringify(schema.target.floors) : ''}${qeStr(schema.target)}`,
      ...(schema.conditions || []).map(c => {
        const d = c.distance || {};
        const qe = c.type === 'poi' ? qeStr(c) : '';
        return `condition: ${c.text ?? c.type} [${c.type}] 距離=${d.level ?? '-'}/${d.method ?? '-'}${d.minutes ? ' ' + d.minutes + '分' : ''}${qe}`;
      }),
    ]);
    this.ui.thinking?.(this._m().thinkingResolve); // 場所特定の計算中

    await this._executeSearch(schema, merged, gen);
  }

  /** この実行が中断されたか（キャンセル or より新しいクエリが開始）。 */
  _aborted(gen) { return gen !== this._runGen || !!this.ui.isCancelled?.(); }

  // ─────────────────────────────────────────────
  // [2] L1 parse + [A] structural checks + [II] validate
  // ─────────────────────────────────────────────

  async _parseAndValidate(userText, previousText, skipInterp = false) {
    // ブロークンな入力（音声等）は L1 が場所依頼を取りこぼすことがある。手がかりがありそうな
    // （＝それなりの長さの）入力で not_a_query/必須欠落になったら、注記を付けて再試行する。
    // 挨拶等の短い入力は1回で確定（無駄な再試行をしない）。temp=0でも注記でプロンプトが変わり
    // 出力が変わり得る＋一過性エラー(ネットワーク等)も拾える。デモでの取りこぼし対策。
    const MAX_TRY = Math.max(1, this.config.L1_PARSE_MAX_RETRY ?? 3);
    const substantial = (userText || '').trim().length >= 12;
    let schema = null, lastErr = null;
    for (let attempt = 0; attempt < MAX_TRY; attempt++) {
      const retryHint = attempt === 0 ? '' :
        '前回この入力から場所依頼を抽出できませんでした。壊れた音声入力の可能性があります。挨拶・相槌・脱線・言い直しの前半は無視し、地名/駅/施設/条件を丁寧に拾ってスキーマ化してください。手がかりが少しでもあれば not_a_query にしないこと。';
      try {
        schema = await this.llm.parseQuery(userText, previousText, this._langCode(), retryHint);
      } catch (e) {
        lastErr = e; schema = null;
        // 429(混雑)は投げ直しても悪化するだけ → 再試行せず即中断。
        if (/HTTP\s*429|rate limit/i.test(String(e?.message || e))) break;
        continue; // その他の一過性エラー → 次の試行へ
      }
      const noClue = !schema?.not_a_query && !schema?.proximity?.anchors?.length && !schema?.target?.text;
      if (!(schema?.not_a_query || noClue)) break;  // 使えるスキーマが取れた
      if (!substantial) break;                      // 短い入力＝本当に非クエリ。再試行しない
      schema = null;                                // substantial なら注記付きで再試行
    }
    if (!schema) {
      if (lastErr) {
        // デバッグモードでは根本原因（打ち切り・不正JSON・HTTP等）をそのまま可視化する。
        this.ui.showDebug?.(`⚠️ L1解析エラー\n${lastErr?.message || String(lastErr)}`);
        this.ui.showMessage(this._friendlyError(lastErr));
      } else {
        this.ui.showMessage(this._m().not_a_query); // 再試行しても場所依頼と取れなかった
      }
      return null;
    }

    // [II] schema validation — malformed structure = treat as a real parse/comm issue
    const validation = validateQuerySchema(schema);
    if (!validation.ok) {
      console.warn('[QueryEngine] L1 schema invalid:', validation.errors);
      // デバッグモードでは検証エラーの中身（どのフィールドが不正か）を可視化する。
      this.ui.showDebug?.(`⚠️ L1スキーマ検証エラー\n${(validation.errors || []).join('\n')}`);
      // If it lacks the essentials, it's more likely a non-query than a comm error.
      if (!schema?.proximity?.anchors?.length || !schema?.target?.text) {
        this.ui.showMessage(this._m().not_a_query);
      } else {
        this.ui.showMessage(this._m().err_understand); // 構造が崩れた＝解釈できなかった扱い
      }
      return null;
    }

    // [解釈の確認] 入力の"構造"（target/proximity/condition の役割・距離の帰属）が2通り以上に
    // 読める時、L1 が interpretations（完結した日本語文・最大3・先頭=最有力）を返す。JSがボタン＋
    // 自由入力で「どの意図か」を提示し、選択/入力された文で解釈し直す（＝確実）。UI制御はJS主導。
    // スキップ（何もせず送信）＝先頭(既定)スキーマで続行。skipInterp で再帰の二重確認を防止。
    if (!skipInterp) {
      const interps = Array.isArray(schema.interpretations)
        ? schema.interpretations.filter(s => s && typeof s === 'string' && s.trim()) : [];
      if (interps.length > 1 && this._clarifyCount < this.config.MAX_CLARIFY_TURNS) {
        this._clarifyCount++;
        const sugg = interps.slice(0, this.config.CLARIFY_MAX_CHOICES || 5).map(t => ({ text: t }));
        const pick = await this.ui.showHintInput(this._m().which_interpretation, sugg);
        if (pick) { // ボタン選択(obj) or 自由入力(str) → その文で解釈し直す（先頭既定はスキップ時）
          const hint = (typeof pick === 'object' && pick.text) ? pick.text : String(pick);
          return await this._parseAndValidate(hint, null, true);
        }
      }
    }
    if (schema.interpretations) delete schema.interpretations; // 以降に持ち越さない

    fillSchemaDefaults(schema, this.config.DEFAULT_LEVEL, this.config.MAX_CONDITIONS);

    // Fallback: L1 sometimes drops the structured target.floors, or mis-classifies a
    // building-height container ("タワマンの中の…") as a literal POI condition. Recover both.
    this._applyFloorsInference(schema, userText);

    // [A] structural checks
    const issues = structuralChecks(schema);
    for (const issue of issues) {
      const handled = await this._handleStructuralIssue(issue, schema);
      if (!handled) return null; // unresolvable
    }

    return schema;
  }

  async _handleStructuralIssue(issue, schema) {
    if (this._clarifyCount >= this.config.MAX_CLARIFY_TURNS) {
      this.ui.showMessage(this._m().clarify_limit);
      return false;
    }
    this._clarifyCount++;

    switch (issue.kind) {
      case 'proximity_missing': {
        // [DD] Mode2 — ask for location
        const answer = await this.ui.showHintInput(this._m().ask_proximity);
        if (!answer) return false;
        const newSchema = await this._reparseMerged(answer);
        if (!newSchema) return false;
        Object.assign(schema, newSchema);
        return true;
      }
      case 'target_missing': {
        const answer = await this.ui.showHintInput(this._m().ask_target);
        if (!answer) return false;
        const newSchema = await this._reparseMerged(answer);
        if (!newSchema) return false;
        Object.assign(schema, newSchema);
        return true;
      }
      case 'distance_too_far': {
        // [4] level=far → pushback
        this.ui.showMessage(this._m().distance_too_far);
        return false;
      }
      default:
        return true;
    }
  }

  async _reparseMerged(additionalText) {
    // Combine once here, then pass as the full text (previousText=null) so parseQuery
    // does NOT re-append and duplicate the hint.
    const combined = `${this._previousText}\n追加情報：${additionalText}`;
    this._previousText = combined;
    try {
      const schema = await this.llm.parseQuery(combined, null, this._langCode());
      if (!validateQuerySchema(schema).ok) return null;
      fillSchemaDefaults(schema, this.config.DEFAULT_LEVEL, this.config.MAX_CONDITIONS);
      // Same floors recovery as _parseAndValidate across clarify/refine re-parses.
      this._applyFloorsInference(schema, combined);
      return schema;
    } catch (e) {
      this.ui.showMessage(this._friendlyError(e));
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // [3-A] Primary search: proximity → bbox
  // ─────────────────────────────────────────────

  async _executeSearch(schema, originalText, gen = this._runGen) {
    // Clear previous map results/drawings on every (re)execution so follow-up
    // queries don't accumulate stale markers/bboxes on the map.
    this.ui.clearResults?.();

    // Determine which cache layers to reuse (K)
    const cacheInvalid = this._detectCacheInvalidation(schema);
    this._cache.schema = schema;

    // [3-A] resolve proximity → bbox (unless cached)
    if (cacheInvalid.bbox) {
      this.ui.showSearching(this._m().searching);
      const bboxResult = await this._resolveProximity(schema);
      if (!bboxResult) return;
      this._cache.bbox = bboxResult;
      // Visualize resolved anchor points
      this.ui.drawProximityPoints?.(bboxResult.resolvedPoints);
    }

    // [3-A4] compute dual bbox (C-2)
    const bboxes = this._computeDualBbox(this._cache.bbox, schema);

    // anchorScore の参照半径 = target収集bboxの外接半径（幅の半分）。候補の c.distance
    // (アンカー中心からの距離) をこの半径で正規化して「アンカーからの近さ」に使う。
    this._anchorRefM = Math.max(1, this._bboxWidthM(bboxes.targetBbox) / 2);
    this.ui.setResultBbox?.(bboxes.targetBbox); // 地図OFF時の静的地図の枠（within絞り込み反映済み）

    // Debug: proximity resolution info
    this._dbgReport.proximity = {
      anchors:      schema.proximity.anchors.map(a => `${a.text}(${a.type})`),
      pointCount:   this._cache.bbox.resolvedPoints?.length ?? 0,
      targetBboxM:  this._bboxWidthM(bboxes.targetBbox),
      condBboxM:    this._bboxWidthM(bboxes.condBbox),
      bearing:      schema.proximity.bearing_filter || null,
    };

    // Visualize search area (target = tight, condition = wide) + fit map
    this.ui.drawBBox?.(bboxes.condBbox);
    this.ui.drawBBox?.(bboxes.targetBbox);
    // proximity.within 到達圏の可視化（n分以内=iso、n分以上=除外する内側isoを表示）
    const reachDraw = [...(this._reachPolygons || []), ...(this._reachHole ? [this._reachHole] : [])];
    if (reachDraw.length) this.ui.drawPolygons?.(reachDraw);
    this.ui.fitToBBox?.(bboxes.condBbox);
    this.ui.refreshCounts?.();
    if (this._withinNote) this.ui.showMessage?.(this._withinNote); // 「範囲広すぎ→周辺で探索」通知

    // [STEP] proximity解決
    await this._step('step-proximity', '① 一次検索: proximity解決', [
      `アンカー: ${this._dbgReport.proximity.anchors.join(', ')}`,
      `target収集bbox 約${this._dbgReport.proximity.targetBboxM}m / condition収集bbox 約${this._dbgReport.proximity.condBboxM}m`,
    ]);
    this.ui.thinking?.(this._m().thinkingCollect); // 候補収集の計算中

    // [3-B] collect candidates (unless cached)
    if (cacheInvalid.candidates) {
      let collected = await this._collectCandidates(schema, bboxes);
      if (!collected) return;

      // [3-B-overflow] target overflowed the cap (too dense for the proximity bbox) →
      // re-anchor on a selective tight condition (promotion) or ask for a landmark.
      if (this._targetRaw > this.config.CANDIDATE_LIMIT) {
        const tight = await this._resolveOverflow(schema, bboxes, collected);
        if (tight && tight.bbox) {
          if (tight.note) this.ui.showMessage(tight.note);
          const re = await this._collectCandidates(schema, { targetBbox: tight.bbox, condBbox: bboxes.condBbox });
          if (re) collected = re;
        }
        // no resolution (user skipped / nothing found) → proceed with the capped set.
      }

      this._cache.mainCandidates = collected.main;
      this._cache.condCandidates = collected.conditions;
      // Visualize hits
      this.ui.drawHits?.(collected.main);
      Object.entries(collected.conditions).forEach(([label, items], ci) => this.ui.drawConditionHits?.(items, ci, label));
      this.ui.refreshCounts?.();
    }

    // [STEP] Step1 収集
    await this._step('step-collect', '② Step1: 候補収集', [
      `target「${this._dbgReport.target?.intent}」: 取得${this._dbgReport.target?.raw} → 除外${this._dbgReport.target?.excluded} → 残${this._dbgReport.target?.kept}`,
      ...(this._dbgReport.conditions || []).map(c => `条件 ${c.label}[${c.type}]: ${c.found}`),
    ]);
    this.ui.thinking?.(this._m().thinkingEval); // 距離評価（候補スコアリング）の計算中＝候補が出る前

    if (this._aborted(gen)) return; // 収集後キャンセル/新クエリ→評価/描画しない
    // [3-C] evaluate (collect reach polygons for visualization)
    this.mcp._evalPolygons = [];
    const results = await this._evaluate(schema, this._cache.mainCandidates, this._cache.condCandidates);
    this.ui.drawPolygons?.(this.mcp._evalPolygons);

    // Debug: evaluation breakdown (with score + tier)
    const dbgRow = c => ({ name: c.name || '(名前なし)', score: c._matchInfo?.score ?? 0, tier: c._tier, rel: c._relevance, hit: c._matchInfo?.hit ?? 0, total: c._matchInfo?.total ?? 0, labels: c._matchInfo?.labels ?? [], floors: c._matchInfo?.floors ?? null });
    this._dbgReport.evaluation = {
      full:    results.full.map(dbgRow),
      partial: results.partial.map(dbgRow),
      noneCount: results.none.length,
    };

    // [STEP] Step2 評価
    await this._step('step-eval', '③ Step2: 距離評価', [
      `全一致 ${results.full.length} / 部分一致 ${results.partial.length} / 参考 ${results.none.length}`,
    ]);

    if (this._aborted(gen)) return; // 評価後キャンセル/新クエリ→結果を描画しない
    // [4] show results
    this._showResults(results, schema);
    this.ui.refreshCounts?.();
    // Token/time telemetry for this search cycle
    this.ui.showRunStats?.({ ms: Date.now() - (this._runStart || Date.now()), llm: this.llm.stats });
    this.ui.showDebugReport?.(this._dbgReport);

    // [5] feedback
    await this._handleFeedback(schema, originalText);
  }

  _bboxWidthM(bbox) {
    if (!bbox) return 0;
    const cy = (bbox[1] + bbox[3]) / 2;
    return Math.round(Math.abs(bbox[2] - bbox[0]) * 111320 * Math.cos(cy * Math.PI / 180));
  }

  // ─────────────────────────────────────────────
  // [3-A] proximity resolution
  // ─────────────────────────────────────────────

  async _resolveProximity(schema) {
    const anchors = schema.proximity.anchors;
    let resolvedPoints = [];
    // within（到達距離/時間）指定時は、基準点を1点だけ解決すれば足りる（到達圏がbboxの正）。
    // 駅の出入口展開・既定半径(400m)は作らない＝出入口tilequeryも省く。ただし出口が明示
    // された場合だけは出入口が要るので単一点化しない。
    const w = schema.proximity.within;
    const wantSinglePoint = !!(w && (w.level || w.minMinutes != null || w.maxMinutes != null || w.minutes != null || w.meters != null || w.maxMeters != null));

    // Optional scope (broad area to locate/disambiguate a POI anchor within):
    // 「鎌倉市のコメダの前の…」→ scope=鎌倉市, anchor=コメダ.
    let scopeBbox = null;
    if (schema.proximity.scope?.text) {
      scopeBbox = await this._resolveScopeBbox(schema.proximity.scope);
    }

    for (const anchor of anchors) {
      // [B1] generic check — only for anchor, not target (§4-3)
      if (anchor.specificity === 'generic' && anchors.length === 1 && !scopeBbox) {
        await this._clarifyGenericAnchor(anchor);
        return null; // re-entry will happen from feedback loop
      }

      const points = await this._resolveAnchor(anchor, scopeBbox, wantSinglePoint, schema.proximity.scope?.text || null);
      if (points === null) return null; // clarification/disambiguation in progress or aborted
      if (points.length === 0) {
        this.ui.showMessage(this._m().anchorNotFound(anchor.text));
        this._awaitingClarify = true; // next answer merges with this query
        return null;
      }
      resolvedPoints.push(...points);
    }

    // proximity.within: explicit reach from the anchor drives the search area.
    //  - 時間(minutes) → Isochrone: 実際の等時間到達ポリゴンを引き、その外接bboxで収集＋
    //    ポリゴン内にハード足切り（徒歩n分“以内”を正確に反映）。
    //  - 距離(meters)  → 半径: アンカーの radiusM を上書きした矩形bbox（円フィルタはしない）。
    // 曖昧な「近く/付近」は within=null → 既定半径（意味が目印依存のため／設計方針）。
    // proximity.within: 基準点からの明示的な到達範囲で探索範囲を決める。
    //  level(目の前=adjacent/すぐ隣=very_close) → 半径 / maxMinutes(n分以内) → isochrone内 /
    //  minMinutes(+maxMinutes)(n分以上[m分以内]) → 内側isoの外(ドーナツ) / meters → 半径。
    const within = schema.proximity.within || null;
    const level  = within?.level ?? null;
    const minMin = within?.minMinutes ?? null;
    const maxMin = within?.maxMinutes ?? within?.minutes ?? null; // legacy: minutes = 以内(max)
    const maxMet = within?.maxMeters  ?? within?.meters  ?? null; // legacy: meters  = 以内(max)
    const prof   = within?.profile || 'walking';
    const active = !!(within && (level || minMin != null || maxMin != null || maxMet != null));
    this._reachPolygons = null;
    this._reachHole     = null;
    this._withinReachM  = null;
    this._withinNote    = null;
    let bbox = null;
    // within指定時は基準点を1点（出入口の重心）に集約（駅の出入口の広がりで範囲が膨らむのを防ぐ）。
    if (active && resolvedPoints.length > 1) {
      const cLng = resolvedPoints.reduce((s, p) => s + p.lng, 0) / resolvedPoints.length;
      const cLat = resolvedPoints.reduce((s, p) => s + p.lat, 0) / resolvedPoints.length;
      resolvedPoints = [{ lng: cLng, lat: cLat }];
    }
    const SPEED = { walking: 80, cycling: 250, driving: 500 }; // m/min（isochrone失敗時の半径近似）
    if (level) {
      const rm = DISTANCE_TABLE[level]?.radius_m;
      if (rm) { resolvedPoints.forEach(p => { p.radiusM = rm; }); this._withinReachM = rm; }
    } else if (minMin != null) {
      // n分以上（m分以内）: 内側isoの外を残す。外側は iso(m).bbox / 拡張bbox / 広すぎなら既定bbox。
      const defaultBbox = this.mcp.resolveBBox({ points: resolvedPoints, marginM: 0 });
      const reach = await this.mcp.computeWithinReach(resolvedPoints[0], { minMinutes: minMin, maxMinutes: maxMin, profile: prof }, defaultBbox);
      if (reach?.bbox) {
        bbox = reach.bbox; this._reachHole = reach.hole;
        if (reach.tooLarge) this._withinNote = this._m().reachTooLarge(minMin, prof, schema.proximity.anchors?.[0]?.text || '');
      }
    } else if (maxMin != null) {
      // n分以内: isochrone内に絞る
      const reach = await this.mcp.isochroneReach(resolvedPoints, maxMin, prof);
      if (reach.bbox) { bbox = reach.bbox; this._reachPolygons = reach.polygons; }
      else { const rm = maxMin * (SPEED[prof] || SPEED.walking); resolvedPoints.forEach(p => { p.radiusM = rm; }); this._withinReachM = Math.round(rm); }
    } else if (maxMet != null) {
      resolvedPoints.forEach(p => { p.radiusM = maxMet; }); this._withinReachM = maxMet;
    }

    // [near-extent] 曖昧な「近く」(within無指定)は anchorの種別で探索半径を変える（決定論・JS）。
    // 点ランドマーク(poi/address/intersection)=狭い / 駅=中 / 地名エリア=そのbbox＋広めマージン。
    // これは「どこまで候補を集めるか(収集extent)」の話で、conditionのマッチング距離(DISTANCE_TABLE)
    // とは別物。収集を広げても採点はアンカーからの実距離で並ぶので、遠いものが「近く」で上位に来ない。
    if (!active) {
      const nearR = this._nearExtentForType(schema.proximity.anchors?.[0]?.type);
      resolvedPoints = resolvedPoints.map(p =>
        p.bbox
          ? { bbox: this.mcp.expandBBox(p.bbox, this.config.LOCALITY_NEAR_MARGIN_M ?? 300) }
          : { ...p, radiusM: nearR });
    }

    // [AA] compute base bbox from all resolved points (unless within already set it)
    if (!bbox) bbox = this.mcp.resolveBBox({ points: resolvedPoints, marginM: 0 });

    // Upper-limit check (EE/§6-3): the dense building grid is infeasible over a
    // huge area, so only building-category targets get pushed back. General POI
    // targets (e.g. 鎌倉のコメダ珈琲) tolerate a large area — Search Box handles it.
    // [絶対前提] proximity は必ず有界サイズでなければならない。TQ実行可能性・anchor距離スコア・
    // 「近く」という意味づけが全てサイズ有界に依存する。target種別に関係なく（旧: 建物ターゲット
    // のみ弾いて一般POIは広域を許していた=前提違反）、広すぎる proximity は絞り込みへ回す。
    // 例:「鎌倉市」→ L1-3が鎌倉駅/北鎌倉/材木座…を提案＋自由入力で有界anchorに絞らせる。
    if (this._bboxExceedsLimit(bbox)) {
      const narrowed = await this._narrowBroadProximity(schema, bbox);
      if (!narrowed) return null;            // 絞り込み待ち/スキップ → 次の入力で再実行
      resolvedPoints = narrowed.resolvedPoints;
      bbox = narrowed.bbox;
    }

    // [3-A3] bearing filter
    if (schema.proximity.bearing_filter) {
      bbox = this._applyBearingCut(bbox, schema.proximity.bearing_filter);
    }

    return { bbox, resolvedPoints };
  }

  async _resolveAnchor(anchor, scopeBbox = null, singlePoint = false, scopeText = null) {
    switch (anchor.type) {
      case 'station':
        return await this._resolveStation(anchor, singlePoint);
      case 'locality':
      case 'address':
        // Area anchors (地名・丁目) — homonym disambiguation by municipality
        // (台東区入谷 vs 足立区入谷 are both 東京都 → must compare at 区/市 level).
        // scope(県/市区)があれば範囲内に限定（岩手県の青山→東京南青山を弾く）。
        return await this._resolveLocality(anchor, scopeBbox, scopeText);
      case 'intersection':
        // Named intersection as reference (「入谷二丁目の交差点」= the intersection
        // NAMED 入谷二丁目). Resolve its area, then find that named intersection.
        return await this._resolveIntersectionAnchor(anchor);
      case 'poi':
        return await this._resolvePoiOrAddress(anchor, scopeBbox);
      default:
        return null;
    }
  }

  /** Resolve a scope place/locality to a bbox (used to constrain POI anchor search). */
  async _resolveScopeBbox(scope) {
    const sb = await this.mcp.searchBox(scope.text, { types: 'place,locality,district' });
    const f = sb?.features?.[0];
    if (!f) return null;
    const bbox = f.properties?.bbox;
    if (bbox) return bbox;
    // no bbox → build a generous box around the point
    const [lng, lat] = f.geometry.coordinates;
    const r = 5000; // ~city-ish
    const dLng = r / (111320 * Math.cos(lat * Math.PI / 180)), dLat = r / 110540;
    return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
  }

  async _resolveStation(anchor, singlePoint = false) {
    // 1. Search Box → station coordinate (with homonym disambiguation)
    const sbResult = await this.mcp.searchBox(anchor.text, { types: 'poi,address,place' });
    if (!sbResult?.features?.length) return null;

    // Same station name in different municipalities is a genuine homonym (県庁前駅 exists
    // in 横浜/千葉/富山/那覇…). Prefer exact-name matches, group by municipality, and ask
    // "which area?" when more than one — otherwise features[0] silently picks the wrong city.
    const feats = sbResult.features;
    const q = MapboxMCPClient._normalizeName(anchor.text);
    const exact = feats.filter(f => MapboxMCPClient._normalizeName(f.properties?.name) === q);
    const pool = exact.length ? exact : feats;
    const byMuni = new Map();
    for (const f of pool) {
      const key = this._municipalityKey(f.properties?.full_address || f.properties?.name || '');
      if (!byMuni.has(key)) byMuni.set(key, f);
    }
    const reps = [...byMuni.values()];
    let chosenFeat = reps[0];
    if (reps.length > 1 && this._clarifyCount < this.config.MAX_CLARIFY_TURNS) {
      this._clarifyCount++;
      const choices = reps.map(f => f.properties.full_address || f.properties.name);
      const chosen = await this.ui.showChoices(this._m().whichArea(anchor.text), choices.slice(0, 4));
      const idx = choices.indexOf(chosen);
      chosenFeat = reps[idx >= 0 ? idx : 0];
    }
    const stationCoord = chosenFeat.geometry.coordinates; // [lng, lat]

    // proximity.within 指定時（出口指定なし）は駅中心の1点だけ返す。到達圏(within)がbboxの正
    // になるので、出入口のtilequery展開も既定半径(400m)も作らない（無駄を省く）。
    if (singlePoint && !anchor.subtype?.exit) {
      return [{ lng: stationCoord[0], lat: stationCoord[1] }];
    }

    // 2. Tilequery → all transit entrances
    const entrances = await this.mcp.tilequeryTransitEntrances(stationCoord[1], stationCoord[0], 500);

    // [C-2] exit-specified
    const exitName = anchor.subtype?.exit;
    if (exitName && entrances.length > 0) {
      const matched = entrances.find(e => e.name && e.name.includes(exitName));
      if (matched) {
        const radiusM = DISTANCE_TABLE.nearby.radius_m; // 700m default station extent
        return [{ lng: matched.lng, lat: matched.lat, radiusM }];
      }
    }

    // No exit specified → span all entrances with a modest station radius so the
    // "駅の近く" area stays reasonable (also bounds the dense building-grid cost).
    const STATION_RADIUS_M = 400;
    if (entrances.length > 0) {
      return entrances.map(e => ({ lng: e.lng, lat: e.lat, radiusM: STATION_RADIUS_M }));
    }

    // Fallback: use station representative coordinate
    return [{ lng: stationCoord[0], lat: stationCoord[1], radiusM: STATION_RADIUS_M }];
  }

  async _resolveLocality(anchor, scopeBbox = null, scopeText = null) {
    // 並列: (a) Search Box前方一致  (b) LLM一般常識での地名解釈（青山→東京都港区南青山/北青山）。
    // Search Box単独だと「青山」で南青山が結果に入らない（全国のマイナーな青山町ばかり）ため、
    // 常識(LLM)を併走させて裏取りマージする。並列なので追加レイテンシはほぼ無い。
    // scopeText(県/市区が明示された場合)はLLMに渡し「その中で解釈」させる（岩手県の青山→盛岡市青山）。
    const [sbResult, guessNames] = await Promise.all([
      this.mcp.searchBox(anchor.text, { types: 'place,locality,neighborhood,district,address' }),
      this.llm.interpretPlaceName(anchor.text, this._langCode(), scopeText),
    ]);
    let features = sbResult?.features || [];

    // scope(県/市区)が指定されていれば、その範囲内の候補に限定（岩手県の青山→東京南青山を弾く）。
    // scope内が0件なら生のまま残す（常識解釈(guess)がscope内で裏取りして救済する）。
    if (scopeBbox) {
      const inScope = features.filter(f => this._pointInBbox(f.geometry?.coordinates, scopeBbox));
      if (inScope.length) features = inScope;
    }

    // [もしかして] データ(SB変種)＋常識(LLM)をマージした候補。2件以上あればボタンで確定させる
    // （黙って片方を採らない）。既に具体的な地名(鎌倉市等)はLLM解釈が空＆SB完全一致で候補が立たず、
    // 後段の広すぎゲート(_narrowBroadProximity)や homonym グルーピングへ流れる。
    const dym = await this._buildDidYouMean(anchor.text, features, guessNames, scopeBbox);
    if (dym.length >= 2 && this._clarifyCount < this.config.MAX_CLARIFY_TURNS) {
      this._clarifyCount++;
      const choices = dym.map(d => d.text);
      const chosen = await this.ui.showChoices(this._m().didYouMean(anchor.text), choices);
      const idx = choices.indexOf(chosen);
      return [dym[idx >= 0 ? idx : 0]._point];
    }
    // Search Boxが空でも、常識解釈が1件だけ実在解決できたならそれを採用（救済）。
    if (!features.length) return dym.length ? [dym[0]._point] : null;

    // Group by MUNICIPALITY (都道府県+市区町村). A true homonym is the same name
    // in a different municipality — 台東区入谷 vs 足立区入谷 are BOTH 東京都, so
    // prefecture alone is too coarse; compare at the 区/市 level.
    const byMuni = new Map();
    for (const f of features) {
      const key = this._municipalityKey(f.properties?.full_address || f.properties?.name || '');
      if (!byMuni.has(key)) byMuni.set(key, []);
      byMuni.get(key).push(f);
    }
    // representative per municipality: prefer place-level, else the first
    const reps = [...byMuni.values()].map(group =>
      group.find(f => f.properties?.feature_type === 'place') || group[0]
    );

    // [B2] genuine homonym across municipalities → Mode1 button
    if (reps.length > 1 && this._clarifyCount < this.config.MAX_CLARIFY_TURNS) {
      this._clarifyCount++;
      const choices = reps.map(f => f.properties.full_address || f.properties.name);
      const chosen = await this.ui.showChoices(this._m().whichArea(anchor.text), choices.slice(0, 4));
      const idx = choices.indexOf(chosen);
      return [this._featureToBboxPoint(reps[idx >= 0 ? idx : 0])];
    }

    // Single municipality → use its representative, no buttons
    return [this._featureToBboxPoint(reps[0])];
  }

  /**
   * Resolve a named intersection as a proximity anchor.
   * 「入谷二丁目の交差点」→ resolve 入谷二丁目 area (with 台東/足立 disambiguation),
   * then find the intersection NAMED 入谷二丁目 within it.
   */
  async _resolveIntersectionAnchor(anchor) {
    // 1. Resolve the area (reuses municipality disambiguation)
    const areaPoints = await this._resolveLocality({ type: 'locality', text: anchor.text });
    if (!areaPoints || areaPoints.length === 0) return null;
    const areaBbox = this.mcp.resolveBBox({ points: areaPoints, marginM: 0 });

    // 2. Find intersections whose name matches (road layer, class=intersection)
    const items = await this.mcp.collectCondition({ type: 'intersection', text: anchor.text }, areaBbox);
    if (!items || items.length === 0) {
      this.ui.showMessage(this._m().intersectionNotFound(anchor.text));
      return null;
    }

    // Nearest matching intersection (items are distance-sorted from area center)
    const best = items[0];
    const radiusM = DISTANCE_TABLE.nearby.radius_m;
    return [{ lng: best.longitude ?? best.lng, lat: best.latitude ?? best.lat, radiusM }];
  }

  /** Municipality key: 都道府県 + 最初の市区町村 (e.g. 東京都台東区). Falls back to raw. */
  _municipalityKey(name) {
    const clean = (name || '').replace(/〒[\d-]*/g, '').trim();
    const m = clean.match(/(..[都道府県])((?:.+?郡)?.+?[市区町村])/);
    return m ? (m[1] + m[2]) : clean;
  }

  async _resolvePoiOrAddress(anchor, scopeBbox = null) {
    // If a scope is given (「鎌倉市のコメダ…」), BIAS by its center but do NOT pass
    // bbox as a hard filter (Search Box bbox-filtering silently drops valid hits).
    // Then filter results to the scope in JS.
    const opts = { types: 'poi,address,place,locality' };
    if (scopeBbox) {
      opts.proximity = [(scopeBbox[0] + scopeBbox[2]) / 2, (scopeBbox[1] + scopeBbox[3]) / 2];
    }
    const sbResult = await this.mcp.searchBox(anchor.text, opts);
    const rawFeatures = sbResult?.features || [];
    let features = rawFeatures;
    if (scopeBbox) {
      const filtered = rawFeatures.filter(f => this._pointInBbox(f.geometry?.coordinates, scopeBbox));
      // Safety net (recall priority): if the scope box drops EVERYTHING but the raw
      // search did find results, the scope was likely too tight/wrong (or the anchor
      // is actually outside it). Fall back to the proximity-biased raw results rather
      // than aborting with nothing.
      features = filtered.length ? filtered : rawFeatures;
    }
    if (!features.length) {
      // Genuinely nothing found — tell the user instead of aborting silently.
      this.ui.showMessage(this._m().anchorNotFound(anchor.text));
      this._awaitingClarify = true;
      return null;
    }

    const radiusM = DISTANCE_TABLE.nearby.radius_m; // default extent around the anchor

    // Distinct candidate locations (a POI anchor can resolve to several — e.g. 3
    // コメダ). proximity MUST be a single point → disambiguate to 1 via buttons.
    let distinct = this._dedupByCoord(features);

    // Prefer EXACT name matches: a unique landmark (東京タワー) shouldn't trigger a
    // "which one?" just because Search Box fuzzy-returned similar names (東京タワー水族館
    // 等). If exactly one exact-name match exists, use it without asking.
    const q = MapboxMCPClient._normalizeName(anchor.text);
    const exact = distinct.filter(f => MapboxMCPClient._normalizeName(f.properties?.name) === q);
    if (exact.length) distinct = exact;

    if (distinct.length > 1 && this._clarifyCount < this.config.MAX_CLARIFY_TURNS) {
      this._clarifyCount++;
      const choices = distinct.slice(0, 4).map(f =>
        `${f.properties.name}${f.properties.full_address ? '（' + f.properties.full_address + '）' : ''}`
      );
      const chosen = await this.ui.showChoices(this._m().whichPoi(anchor.text), choices);
      const idx = choices.indexOf(chosen);
      const f = distinct[idx >= 0 ? idx : 0];
      return [{ lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], radiusM }];
    }

    const feature = distinct[0];
    const ftype = feature.properties?.feature_type;
    // Only reject genuinely huge admin areas; a place (市/区) is acceptable as a
    // broad proximity (its bbox is used when available).
    if (['region', 'country'].includes(ftype)) {
      this.ui.showMessage(this._m().proximity_too_broad);
      this._awaitingClarify = true;
      return null;
    }
    if (feature.properties?.bbox) return [this._featureToBboxPoint(feature)];
    const coord = feature.geometry.coordinates;
    return [{ lng: coord[0], lat: coord[1], radiusM }];
  }

  _pointInBbox(coord, bbox) {
    if (!coord || !bbox) return false;
    return coord[0] >= bbox[0] && coord[0] <= bbox[2] && coord[1] >= bbox[1] && coord[1] <= bbox[3];
  }

  /** Dedup Search Box features by coordinate (~30m) — distinct physical locations. */
  _dedupByCoord(features) {
    const seen = new Map();
    const out = [];
    for (const f of features) {
      const c = f.geometry?.coordinates;
      if (!c) continue;
      const key = `${Math.round(c[0] * 3000)}|${Math.round(c[1] * 3000)}`; // ~30m grid
      if (!seen.has(key)) { seen.set(key, true); out.push(f); }
    }
    return out;
  }

  _featureToBboxPoint(feature) {
    // locality → use bbox if available, else coordinate
    const bbox = feature.properties?.bbox || feature.bbox;
    if (bbox) return { bbox }; // { bbox: [minX,minY,maxX,maxY] }
    const coord = feature.geometry.coordinates;
    return { lng: coord[0], lat: coord[1], radiusM: DISTANCE_TABLE.nearby.radius_m };
  }

  _filterDistinctLocalities(features) {
    // Distinct = different region context (different administrative area)
    const seen = new Map();
    const result = [];
    for (const f of features) {
      const region = f.properties?.context?.region?.name ?? f.properties?.place_formatted ?? f.properties?.name;
      if (!seen.has(region)) { seen.set(region, true); result.push(f); }
    }
    return result;
  }

  async _clarifyGenericAnchor(anchor) {
    if (this._clarifyCount >= this.config.MAX_CLARIFY_TURNS) {
      this.ui.showMessage(this._m().clarify_limit);
      return;
    }
    this._clarifyCount++;
    this.ui.showMessage(this._m().genericMulti(anchor.text));
    this._awaitingClarify = true; // next main-input answer merges with this query
  }

  // ─────────────────────────────────────────────
  // [L1-3] Broad proximity → narrow to a bounded sub-anchor（1次検索の前段）
  //   ゲート判定(広すぎ)はJS幾何(_bboxExceedsLimit)。列挙はLLM(世界知識)。裏取り・散らし・
  //   フロー制御はJS。会話制御は完全にJS主導（LLMは列挙に答えるだけ）。
  // ─────────────────────────────────────────────

  /**
   * proximity が広すぎる時、有界な下位anchorに絞らせる。LLM(L1-3)が知名度の高い下位エリアを
   * 列挙 → JSがSearch Boxで実在検証(エリア内限定)＋空間的に散らす＋上限 → ボタン＋自由入力で提示。
   * 選ばれた有界anchorの { bbox, resolvedPoints } を返す。待ち/スキップ時は null。
   */
  async _narrowBroadProximity(schema, areaBbox) {
    const en = this._langCode() === 'en';
    const areaText = schema.proximity?.anchors?.[0]?.text || (en ? 'this area' : 'この付近');
    if (this._clarifyCount >= this.config.MAX_CLARIFY_TURNS) {
      this.ui.showMessage(this._m().clarify_limit);
      this._awaitingClarify = true;
      return null;
    }
    this._clarifyCount++;

    const names = await this.llm.suggestProximityAnchors(areaText, this._langCode());
    const suggestions = await this._groundProximityAnchors(names, areaBbox);

    const hint = await this.ui.showHintInput(this._m().proximityNarrow(areaText), suggestions);
    if (!hint) { this._awaitingClarify = true; return null; } // スキップ → 次の入力を待つ

    // ボタン選択（実在検証済みの点を保持）/ 自由入力（改めて解決）
    let point = null;
    if (typeof hint === 'object' && hint._point) {
      point = hint._point;
    } else {
      const pts = await this._resolveClarifyAnchor(String(hint));
      if (pts && pts.length) {
        point = { lng: pts[0].longitude, lat: pts[0].latitude, radiusM: DISTANCE_TABLE.nearby.radius_m };
      }
    }
    if (!point) { this._awaitingClarify = true; return null; }

    const bbox = this.mcp.resolveBBox({ points: [point], marginM: 0 });
    return { bbox, resolvedPoints: [point] };
  }

  /** LLM提案の下位anchor名をSearch Boxで裏取り：エリアbbox内に解決できたものだけ残し、
   *  空間的に散らして上限適用。返り値 [{ text, _point, _coord }]（_point は showHintInput の
   *  ボタン選択時にそのまま proximity 点として使う）。 */
  async _groundProximityAnchors(names, areaBbox) {
    return this._spreadAndCap(await this._groundNames(names, areaBbox), this.config.CLARIFY_MAX_CHOICES || 5);
  }

  /** 名前一覧を Search Box で実在解決 → [{ text, _point, _coord }]。areaBbox 指定時はその中に
   *  解決できたものだけ（広域絞り込みのエリア内限定）。null 時は全国から先頭候補（地名解釈用）。 */
  async _groundNames(names, areaBbox = null) {
    const uniq = [...new Set((names || []).map(n => (n || '').trim()).filter(Boolean))];
    const settled = await Promise.all(uniq.map(async nm => {
      try {
        const sb = await this.mcp.searchBox(nm, { types: 'poi,place,locality,neighborhood,district,address' });
        const feats = sb?.features || [];
        const f = areaBbox ? feats.find(ft => this._pointInBbox(ft.geometry?.coordinates, areaBbox)) : feats[0];
        if (!f) return null; // 未解決/エリア外は捨てる（ハルシネ排除）
        return { text: nm, _point: this._featureToBboxPoint(f), _coord: f.geometry.coordinates };
      } catch { return null; }
    }));
    return settled.filter(Boolean);
  }

  /** [もしかして] データ(Search Box変種)＋常識(LLM地名解釈)を並列マージ。座標で重複排除し上限。
   *  LLM推測を先頭優先（青山→南青山/北青山 が Search Box生結果に無くても常識で出せる）。 */
  async _buildDidYouMean(text, features, guessNames, scopeBbox = null) {
    const guessGrounded = await this._groundNames(guessNames, scopeBbox); // scope内(あれば)で正式名を裏取り
    const sbVariants = this._detectMoreSpecific(text, features).map(f => ({
      text: `${f.properties.name}${f.properties.full_address ? '（' + f.properties.full_address + '）' : ''}`,
      _point: this._featureToBboxPoint(f),
      _coord: f.geometry.coordinates,
    }));
    const merged = this._dedupItemsByCoord([...guessGrounded, ...sbVariants]); // 常識を先頭優先
    return merged.slice(0, this.config.CLARIFY_MAX_CHOICES || 5);
  }

  /** items を座標(~30m)で重複排除（先頭優先）。 */
  _dedupItemsByCoord(items) {
    const seen = new Set(), out = [];
    for (const it of items) {
      const c = it._coord; if (!c) continue;
      const key = `${Math.round(c[0] * 3000)}|${Math.round(c[1] * 3000)}`;
      if (!seen.has(key)) { seen.add(key); out.push(it); }
    }
    return out;
  }

  /** 地理的に散らばった候補を優先して cap 件まで採る（近すぎる候補は間引く）。エリアの別々の
   *  場所を指す選択肢になるようにして、特定に使えるようにする。 */
  _spreadAndCap(items, cap) {
    const MIN_SEP_M = 800;
    const picked = [];
    for (const it of items) {
      if (picked.length >= cap) break;
      if (picked.some(p => this._coordDistM(p._coord, it._coord) < MIN_SEP_M)) continue;
      picked.push(it);
    }
    if (picked.length < cap) { // 散らしで足りなければ間引いた近接候補で埋める
      for (const it of items) {
        if (picked.length >= cap) break;
        if (!picked.includes(it)) picked.push(it);
      }
    }
    return picked;
  }

  _coordDistM(a, b) {
    if (!a || !b) return Infinity;
    const dLat = (b[1] - a[1]) * 110540;
    const dLng = (b[0] - a[0]) * 111320 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
    return Math.hypot(dLat, dLng);
  }

  /** 曖昧な「近く」の探索半径を anchor種別で返す（点ランドマーク=狭い / 駅=中 / 地名=広め）。
   *  収集extentの既定であって、conditionのマッチング距離(DISTANCE_TABLE)とは無関係。
   *  locality が bbox で解決した場合は半径でなく LOCALITY_NEAR_MARGIN_M でbboxを膨らませる（呼び出し側）。 */
  _nearExtentForType(type) {
    switch (type) {
      case 'station':  return this.config.NEAR_STATION_M  ?? 600;
      case 'locality': return this.config.NEAR_LOCALITY_M ?? 800; // 点解決時のフォールバック
      default:         return this.config.NEAR_POI_M      ?? 400; // poi/address/intersection = 点ランドマーク
    }
  }

  /** [もしかして] 口語/部分的な地名 → Search Box が返したより具体的な同義エリア。
   *  入力を含む別名（青山 ⊂ 南青山）だけを distinct で返す。入力と完全一致する候補が有れば
   *  （その場所を意図している）空配列＝もしかしては出さない。同名別市区の homonym は別処理。 */
  _detectMoreSpecific(text, features) {
    const q = MapboxMCPClient._normalizeName(text);
    if (!q) return [];
    if (features.some(f => MapboxMCPClient._normalizeName(f.properties?.name) === q)) return [];
    // 入力を含むより具体的な別名（青山 ⊂ 南青山）だけを候補に
    const seen = new Set();
    const cands = [];
    for (const f of features) {
      const nm = MapboxMCPClient._normalizeName(f.properties?.name);
      if (!nm || nm === q || !nm.includes(q)) continue;
      if (seen.has(nm)) continue;
      seen.add(nm);
      cands.push(f);
    }
    // 【重要】Search Box は全国に散った同名の別物（奈良/長崎/千葉…の「青山町」）を拾う。これらを
    // 「もしかして」に出すのはノイズ。同一市区内の変種（南青山・北青山＝港区）だけに限定する。
    // ※ 真に famous な候補を世界知識から出す（青山→南青山）のは L1-2(意味解釈)の役割で、この
    //   データ駆動の関数ではやらない。Search Box に南青山が入っていなければ空を返す。
    const byMuni = new Map();
    for (const f of cands) {
      const k = this._municipalityKey(f.properties?.full_address || f.properties?.name || '');
      if (!byMuni.has(k)) byMuni.set(k, []);
      byMuni.get(k).push(f);
    }
    let best = [];
    for (const g of byMuni.values()) if (g.length > best.length) best = g;
    return best.length >= 2 ? best : [];
  }

  // ─────────────────────────────────────────────
  // [3-A4] Dual bbox (C-2 / §7-4)
  // ─────────────────────────────────────────────

  _computeDualBbox(bboxResult, schema) {
    const targetBbox = bboxResult.bbox;
    const margin     = maxConditionRadiusM(schema.conditions, this.config.DEFAULT_LEVEL);
    const condBbox   = margin > 0
      ? this.mcp.expandBBox(targetBbox, margin)
      : targetBbox;
    return { targetBbox, condBbox };
  }

  _applyBearingCut(bbox, direction) {
    // Cut bbox in half along center line for the given cardinal direction.
    // Keeps the "direction" half.
    const [minX, minY, maxX, maxY] = bbox;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    switch (direction) {
      case 'north': return [minX, cy,   maxX, maxY];
      case 'south': return [minX, minY, maxX, cy  ];
      case 'east':  return [cx,   minY, maxX, maxY];
      case 'west':  return [minX, minY, cx,   maxY];
      default:      return bbox;
    }
  }

  /**
   * Deterministic JS name rules for building-category targets.
   * マンション/アパート（居住系）は「〜ビル」で終わる名前を除外する
   * （ビル＝オフィス/雑居/商業。居住系が「〜ビル」で終わることはほぼ無い。
   *  後方一致なので名前途中に"ビル"を含む居住系は残る）。
   * category_building（ビル探し）には適用しない。
   */
  _applyBuildingNameRules(target, candidates) {
    if (!['category_mansion', 'category_apartment'].includes(target?.query_intent)) return candidates;
    const BUILDING_SUFFIX = /(ビル|ビルヂング|ビルディング)$/;
    return candidates.filter(c => !(c.name && BUILDING_SUFFIX.test(c.name.trim())));
  }

  /** UI language code for LLM-generated user-facing text. */
  _langCode() { return this.ui.getLang?.() === 'en' ? 'en' : 'ja'; }

  /**
   * Pre-scoring dedup of Target candidates (too many dups inflate ties / hurt scoring).
   *  1) same normalized name (NFKC + strip spaces, case-insensitive) → keep one
   *     (prefer a 店-suffixed/branch name, else the one closer to the anchor).
   *  2) proximity dedup: when a candidate WITH a store suffix (…店) and one WITHOUT are
   *     within ~30m and share the brand (storeless name is a prefix), drop the storeless
   *     one — it's the same physical place with a less specific entry.
   */
  _dedupTargets(cands) {
    if (!cands || cands.length <= 1) return cands;
    const norm     = s => (s || '').normalize('NFKC').replace(/[\s　]+/g, '').toLowerCase();
    const hasStore = s => /店$/.test((s || '').trim());
    const distM = (a, b) => {
      const la = a.latitude ?? a.lat, lna = a.longitude ?? a.lng;
      const lb = b.latitude ?? b.lat, lnb = b.longitude ?? b.lng;
      if (la == null || lna == null || lb == null || lnb == null) return Infinity;
      const R = 6371000, toRad = d => d * Math.PI / 180;
      const dLat = toRad(lb - la), dLng = toRad(lnb - lna);
      const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(la)) * Math.cos(toRad(lb)) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
    };

    // pass 1: exact normalized-name dedup
    const byName = new Map();
    const unnamed = [];
    for (const c of cands) {
      const k = norm(c.name);
      if (!k) { unnamed.push(c); continue; }
      const ex = byName.get(k);
      if (!ex) { byName.set(k, c); continue; }
      const keep = (hasStore(c.name) && !hasStore(ex.name)) ? c
                 : (!hasStore(c.name) && hasStore(ex.name)) ? ex
                 : ((c.distance ?? 9e9) < (ex.distance ?? 9e9) ? c : ex);
      byName.set(k, keep);
    }
    const kept = [...byName.values(), ...unnamed];

    // pass 2: proximity + store-suffix
    const NEAR_M = 30;
    const removed = new Set();
    for (let i = 0; i < kept.length; i++) {
      for (let j = 0; j < kept.length; j++) {
        if (i === j) continue;
        const a = kept[i], b = kept[j];
        if (removed.has(a.id) || removed.has(b.id)) continue;
        if (hasStore(a.name) && !hasStore(b.name) && distM(a, b) <= NEAR_M) {
          const na = norm(a.name), nb = norm(b.name);
          if (nb && na.startsWith(nb)) removed.add(b.id);
        }
      }
    }
    const out = kept.filter(c => !removed.has(c.id));
    if (this.config.DEBUG && out.length < cands.length) {
      console.log(`[QueryEngine] target dedup: ${cands.length} → ${out.length}`);
    }
    return out;
  }

  /** Localized full-criteria summary shown on refine (narrow / research). */
  _criteriaSummary(schema) {
    const en   = this._langCode() === 'en';
    const px   = (schema.proximity?.anchors || []).map(a => a.text).filter(Boolean).join('・');
    const tgt  = schema.target?.text || '';
    const conds = (schema.conditions || []).map(c => c.text ?? c.type).filter(Boolean);
    if (en) {
      let s = `🔎 Searching${px ? ` around ${px}` : ''} for「${tgt}」`;
      if (conds.length) s += `\nConditions: ${conds.join(' / ')}`;
      return s;
    }
    let s = `🔎 ${px ? `${px}周辺で` : ''}「${tgt}」を検索`;
    if (conds.length) s += `\n条件: ${conds.join(' / ')}`;
    return s;
  }

  /**
   * 透明化の注記を組み立てる（早出し吹き出しと候補パネルで共通利用）。
   *   A: droppedConditionTexts — 上限超過で検索対象から外した地理条件
   *   B: unsupported_features  — 数値化・地図化できない非地理的な特徴（壁が赤い等）
   *   C: rail条件の申し送り     — 地下鉄など地下の路線と地上線路をデータ上区別できない旨
   * 該当が無ければ '' を返す。複数あれば改行で連結。
   */
  _exclusionNote(schema) {
    const M = this._m();
    const sep = this._langCode() === 'en' ? ', ' : '、';
    const parts = [];
    const dropped = schema?.droppedConditionTexts || [];
    if (dropped.length) parts.push(M.droppedConditions(dropped.join(sep)));
    const unsup = schema?.unsupported_features || [];
    if (unsup.length) parts.push(M.unsupportedFeatures(unsup.join(sep)));
    // rail は地下鉄も地上線路も区別できない → 「線路沿い」指定時は申し送り（検索ロジックは不変）。
    if ((schema?.conditions || []).some(c => c.type === 'rail')) parts.push(M.railSubwayNote());
    // ②assumption: 移動手段未指定の「n分」を徒歩と仮定した → 解釈内容を通知（探索には使う）。
    const walkAssumed = schema?.proximity?.within?.profile_inferred === true
      || (schema?.conditions || []).some(c => c.distance?.profile_inferred === true);
    if (walkAssumed) parts.push(M.walkAssumed());
    return parts.join('\n');
  }

  /** Basis pool for narrow suggestions = full-match candidates (else partial). */
  _basisTier(cands) {
    if (!cands?.length) return [];
    const full = cands.filter(c => ['full1', 'full2', 'full3', 'full'].includes(c._tier));
    if (full.length) return full;
    const partial = cands.filter(c => c._tier === 'partial');
    return partial.length ? partial : cands;
  }

  /**
   * [L3] Agent suggestions for narrowing: from the top-tier surfaced candidates, gather
   * each one's nearby poi_label landmarks and let L3 pick recognizable, DIFFERENTIATING
   * ones (near only some candidates). Returns short condition phrases (string[]).
   */
  async _computeSuggestions(schema) {
    try {
      const basis = this._basisTier(this._cache.surfaced || []);
      if (basis.length < 2 || !this._cache.bbox) return [];
      const norm = s => (s || '').normalize('NFKC').replace(/[\s　]+/g, '').toLowerCase();
      // Landmarks already used as conditions must not be re-suggested → exclude them from
      // the L3 input entirely (most efficient: no extra tokens, can't be picked).
      const usedCond = new Set((schema?.conditions || []).map(c => norm(c.text ?? c.type)).filter(Boolean));
      // 目印の探索半径・文言・選択時の適用条件を1つのレベルで統一（ズレ防止）。
      // very_close=150m「すぐ近く」。nearby=400m「近く」に緩めたい場合はここだけ変える。
      const SUGGEST_LEVEL = 'very_close';
      const ASSIGN_MAX = DISTANCE_TABLE[SUGGEST_LEVEL].radius_m; // この距離以内の候補にだけ割り当てる
      const MARGIN     = 60;  // 最寄り候補が2番目より これ以上近い＝その候補固有と判定
      // poi_label grid over the basis candidates' area (+margin), no Search Box.
      const lats = basis.map(c => c.latitude ?? c.lat).filter(v => v != null);
      const lngs = basis.map(c => c.longitude ?? c.lng).filter(v => v != null);
      if (!lats.length) return [];
      const mLat = ASSIGN_MAX / 111000, mLng = ASSIGN_MAX / (111000 * Math.cos(Math.min(...lats) * Math.PI / 180) || 1);
      const bbox = [Math.min(...lngs) - mLng, Math.min(...lats) - mLat, Math.max(...lngs) + mLng, Math.max(...lats) + mLat];
      const grid = await this.mcp.buildPoiLabelGrid(bbox, 65);
      if (!grid?.length) return [];
      const distM = (aLat, aLng, bLat, bLng) => {
        const R = 6371000, toRad = d => d * Math.PI / 180;
        const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
        const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
      };
      // 役割分担: JS が「幾何的に区別できる目印」を各候補へ機械的に割り当て、LLM は
      // 「その中でどれを使うか（知名度）」を選ぶだけ。
      // 割り当ては固定半径の二値ではなく「最も近い候補＋マージン」で行う：poi_labelは密なので
      // 固定150m内“ちょうど1候補”だと、候補が近接していると全目印が複数圏に入り全滅する。
      // 代わりに各目印を最寄り候補に割り当て、2番目の候補よりMARGIN以上近い時だけ「その候補固有」
      // として採用（＝どの候補にも同程度に近い曖昧な目印だけを捨てる）。
      // 目印は「ユーザーが実際に見て選ぶ候補」を区別するためのもの。対話パネルは上位5件表示
      // （index.js _renderCandidatePanel の LIMIT=5）なので、その5件に揃える。
      const TOP_N = 5;
      const pts = basis.slice(0, TOP_N)
        .map((c, i) => ({ i, id: c.id, name: c.name || `候補${i + 1}`, lat: c.latitude ?? c.lat, lng: c.longitude ?? c.lng }))
        .filter(p => p.lat != null && p.lng != null);
      if (pts.length < 2) return [];
      const byCand = new Map(pts.map(p => [p.i, []]));   // 候補index → 固有目印名[]
      const nameToCandIdx = new Map();                   // 目印key → 割り当て候補index（どの候補の目印か）
      const seenName = new Set();
      for (const g of grid) {
        if (!g.name) continue;
        const key = norm(g.name);
        if (!key || usedCond.has(key) || seenName.has(key)) continue; // 既存条件・同名は除外
        const gl = g.latitude ?? g.lat, gn = g.longitude ?? g.lng;
        if (gl == null || gn == null) continue;
        const ds = pts.map(p => ({ i: p.i, d: distM(p.lat, p.lng, gl, gn) })).sort((a, b) => a.d - b.d);
        if (ds[0].d > ASSIGN_MAX) continue;               // どの候補からも遠い → 目印にしない
        if (ds[1] && ds[1].d - ds[0].d < MARGIN) continue; // 複数候補に同程度に近い → 区別に使えない
        seenName.add(key);
        const arr = byCand.get(ds[0].i);                  // 最寄り候補固有の目印として割り当て
        // class(cls/maki) も同梱：LLMが「ガソスタ>マンション」のような目印の質を判断できる。
        if (arr.length < 15) { arr.push({ name: g.name, cls: g.cls || g.maki || null }); nameToCandIdx.set(key, ds[0].i); }
      }
      const candList = pts.map(p => ({ name: p.name, nearby: byCand.get(p.i) })).filter(c => c.nearby.length);
      if (!candList.length) return []; // 幾何的に区別できる目印が無い → 出さない（絞り込めないので）

      // LLM は「区別できる候補群」の中から知名度・目印の分かりやすさで選ぶだけ。allowed 以外は不採用。
      const allowed = new Set(candList.flatMap(c => c.nearby.map(n => norm(n.name))));
      const names = await this.llm.suggestLandmarks(candList, this._langCode());
      if (!names.length) return [];
      const idxToId = new Map(pts.map(p => [p.i, p.id])); // 候補index → 候補id（candId 付与用）
      const out = [];
      const usedNames = new Set();
      for (const nm of names) {
        const key = norm(nm);
        if (!key || usedNames.has(key) || !allowed.has(key)) continue; // 区別済みリスト外/重複は拒否
        const items = grid.filter(g => g.name && norm(g.name) === key);
        if (!items.length) continue; // unresolvable → skip (no re-query)
        usedNames.add(key);
        // candId: この目印がどの候補のものか。_handleFeedback が「目印の付いた候補」を判定し、
        // 目印の無い候補にだけ階数サジェストを足す（併用）ために使う。
        out.push({ text: this._landmarkPhrase(nm, SUGGEST_LEVEL), landmark: nm, items, level: SUGGEST_LEVEL, candId: idxToId.get(nameToCandIdx.get(key)) });
      }
      return out;
    } catch { return []; }
  }

  /**
   * [フォールバック] 近傍に区別できるPOI目印が無い時、候補の建物階数(height÷3)で区別する提案を作る。
   * ルール: 「その階数を持つ候補が1つだけ（＝一意）」の階数のみ提案する。同じ階数が2候補以上ある場合
   * その階数では絞り込めないので出さない。全候補が同階数/階数不明なら [] を返す（＝提案なし）。
   * 選択時は _narrowByFloors がその階数の候補だけに絞る。
   * @param {Set} coveredIds 既に目印サジェストが付いた候補id（それらには階数を出さない＝目印を優先）。
   *   ※一意判定は「全候補」に対して行う（_narrowByFloors は全候補を階数でフィルタするため、
   *     coveredな候補と階数が衝突すると一意に絞れない）。
   */
  async _computeFloorSuggestions(schema, coveredIds = new Set()) {
    try {
      const basis = this._basisTier(this._cache.surfaced || []).slice(0, 5);
      if (basis.length < 2) return [];
      // 階数を取得（初回評価で c._floors 済みなら再利用。_getBuildingId と同一URLでキャッシュ共有）。
      await Promise.all(basis.map(async c => {
        if (c._floors === undefined) {
          const lat = c.latitude ?? c.lat, lng = c.longitude ?? c.lng;
          c._floors = (lat != null && lng != null) ? await this.mcp._getBuildingFloors(lat, lng) : null;
        }
      }));
      // 各階数を持つ候補数を数え（全候補対象）、一意（=1件）な階数だけを差別化候補にする。
      const countByFloor = new Map();
      for (const c of basis) {
        if (c._floors == null) continue;
        countByFloor.set(c._floors, (countByFloor.get(c._floors) || 0) + 1);
      }
      const out = [];
      const seen = new Set();
      for (const c of basis) {
        const f = c._floors;
        if (f == null || seen.has(f)) continue;
        if (countByFloor.get(f) !== 1) continue; // 同じ階数が2候補以上 → 区別に使えないので出さない
        if (coveredIds.has(c.id)) continue;       // 既に目印が付いた候補は階数を出さない（目印優先）
        seen.add(f);
        out.push({ text: this._floorPhrase(f), floors: f });
      }
      return out; // 一意かつ目印なしの階数が1つも無ければ [] ＝提案なし
    } catch { return []; }
  }

  /** Localized floor-count phrasing for a floor suggestion button. */
  _floorPhrase(f) {
    return this._langCode() === 'en' ? `About ${f} floors` : `約${f}階建て`;
  }

  /** Localized "right nearby" phrasing for a resolved landmark suggestion. */
  _landmarkPhrase(name, level = 'very_close') {
    const en = this._langCode() === 'en';
    // adjacent/very_close → 「すぐ近く」、それ以上（nearby等）→ 「近く」
    const tight = level === 'adjacent' || level === 'very_close';
    if (en) return tight ? `${name} is right nearby` : `${name} is nearby`;
    return tight ? `すぐ近くに${name}がある` : `近くに${name}がある`;
  }

  /** Infer a target floor constraint from raw text (fallback when L1 omits target.floors). */
  _inferFloors(text) {
    if (!text) return null;
    let m;
    if ((m = text.match(/(\d{1,3})\s*階以上/)))            return { min: parseInt(m[1], 10) };
    if ((m = text.match(/(\d{1,3})\s*階以下/)))            return { max: parseInt(m[1], 10) };
    // 「12階建て/12階建/12階だて/12階立て(建ての誤記)/12階の」→ value:12
    if ((m = text.match(/(\d{1,3})\s*階\s*(建て|建|だて|立て|の)/))) return { value: parseInt(m[1], 10) };
    // タワマン系（「タマワン」等のよくある表記ゆれ／タイプミスも吸収）
    if (/(タワマン|タマワン|タワーマンション|タワマンション|超高層|高層(マンション|ビル|階|階建)?)/.test(text)) return { min: 20 };
    if (/(背の高い|(高い|でかい)(建物|ビル|マンション))/.test(text))                    return { min: 10 };
    if (/(低層|背の低い|平屋)/.test(text))                                              return { max: 3 };
    return null;
  }

  /** floorsハード判定: 実階数 f が spec を満たすか（value は丸め誤差を FLOORS_HARD_TOL で許容）。 */
  _floorPass(f, spec) {
    if (!spec) return true;
    const tol = this.config.FLOORS_HARD_TOL ?? 2;
    let ok;
    if (spec.value != null)      ok = Math.abs(f - spec.value) <= tol;
    else if (spec.min != null && f < spec.min) ok = false;
    else if (spec.max != null && f > spec.max) ok = false;
    else ok = true;
    return spec.negate ? !ok : ok; // negate:「N階建てではない」→ 判定を反転
  }

  /** floors spec を日本語ラベルに（除外理由の表示用）。 */
  _floorSpecLabel(spec) {
    if (!spec) return '階数';
    if (spec.value != null) return `${spec.value}階`;
    if (spec.min != null)   return `${spec.min}階以上`;
    if (spec.max != null)   return `${spec.max}階以下`;
    return '階数';
  }

  /** floors spec を「N階建て(以上/以下)」形式に（候補理由の表示用）。 */
  _floorReasonLabel(spec) {
    if (!spec) return '階数';
    if (spec.value != null) return `${spec.value}階建て`;
    if (spec.min != null)   return `${spec.min}階建て以上`;
    if (spec.max != null)   return `${spec.max}階建て以下`;
    return '階数';
  }

  /**
   * 候補ごとの「なぜこの候補か」理由リスト（✔️付き文字列の配列）を組み立てる。
   * - target.floors を満たす → 「✔️ 5階建て以上（7階相当）」
   * - 満たした各 condition → 「✔️ すぐ近くにセブンイレブン」（level で近さ表現を出し分け）
   * - 反転条件(negate) → POI系は「（がない）」、道路/水域系は「（ではない）」を付す
   * ハード同ビル条件は _matchInfo.labels に載らないが、生存候補は必ず満たしているので別途加える。
   */
  _candidateReasons(schema, c) {
    const out = [];
    const fs = schema?.target?.floors;
    if (fs && c._floors != null && this._floorPass(c._floors, fs)) {
      const neg = fs.negate ? 'ではない' : '';
      out.push(`✔️ ${this._floorReasonLabel(fs)}${neg}（${c._floors}階相当）`);
    }
    const sameBuildingHard = (this.config.SAME_BUILDING_MODE ?? 'hard') === 'hard';
    const hitSet = new Set(c._matchInfo?.labels ?? []);
    for (const cond of (schema?.conditions ?? [])) {
      const label = cond.text ?? cond.type;
      const lvl = cond.distance?.level;
      const isHardSame = sameBuildingHard && lvl === 'same_building';
      // ハード同ビル条件は生存＝満たしている。それ以外はヒット集合で判定。
      if (!(isHardSame || hitSet.has(label))) continue;
      const near = lvl === 'same_building' ? '同じビルに'
                 : (lvl === 'adjacent' || lvl === 'very_close') ? 'すぐ近くに'
                 : '近くに';
      const suffix = cond.negate ? (cond.type === 'poi' ? '（がない）' : '（ではない）') : '';
      out.push(`✔️ ${near}${cond.text ?? cond.type}${suffix}`);
    }
    return out;
  }

  // Recover building-height intent that L1 didn't emit as target.floors:
  //  (1) a "〜の中(same_building)" poi condition whose text is a height keyword
  //      ("タワマンの中の…") is really about the target's OWN building → fold into
  //      target.floors and drop the bogus POI search;
  //  (2) otherwise infer from the raw query text.
  // Nearby/adjacent towers ("すぐ近くのタワマン") stay as real conditions — only
  // same_building containers are folded.
  _applyFloorsInference(schema, text) {
    if (!schema?.target) return;
    if (Array.isArray(schema.conditions)) {
      schema.conditions = schema.conditions.filter(c => {
        if (c?.type === 'poi' && c.distance?.level === 'same_building') {
          const f = this._inferFloors(c.text || '');
          if (f) { if (!schema.target.floors) schema.target.floors = f; return false; }
        }
        return true;
      });
    }
    if (!schema.target.floors) {
      const f = this._inferFloors(text);
      if (f) schema.target.floors = f;
    }
  }

  // ─────────────────────────────────────────────
  // Overflow handling: target too dense for the proximity bbox (raw > CANDIDATE_LIMIT).
  // Reactive (data-driven): re-anchor on a selective tight condition, else clarify.
  // ─────────────────────────────────────────────

  /** Bounding box enclosing the given points, expanded by radiusM (meters). */
  _bboxFromPoints(points, radiusM = 250) {
    const lls = (points || [])
      .map(p => [p.longitude ?? p.lng, p.latitude ?? p.lat])
      .filter(([a, b]) => a != null && b != null);
    if (!lls.length) return null;
    const lats = lls.map(x => x[1]), lngs = lls.map(x => x[0]);
    const cLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const mLat = radiusM / 111000;
    const mLng = radiusM / (111000 * Math.cos(cLat * Math.PI / 180) || 1);
    return [Math.min(...lngs) - mLng, Math.min(...lats) - mLat, Math.max(...lngs) + mLng, Math.max(...lats) + mLat];
  }

  /** A condition worth promoting to the search anchor: specific poi + tight distance + few resolved points. */
  _findPromotableAnchor(schema, condResults) {
    const TIGHT = new Set(['same_building', 'adjacent', 'very_close']);
    let best = null;
    for (const c of (schema.conditions || [])) {
      if (c.type !== 'poi' || !TIGHT.has(c.distance?.level)) continue;
      const items = condResults[c.text ?? c.type] || [];
      if (items.length < 1 || items.length > 10) continue; // selective enough to anchor on
      if (!best || items.length < best.items.length) {
        const dp = resolveDistanceParams(c.distance, this.config.DEFAULT_LEVEL);
        best = { label: c.text ?? c.type, items, radiusM: dp.radiusM || 250 };
      }
    }
    return best;
  }

  /** Prominent nearby landmarks (for the overflow clarify) as {text, landmark, items} buttons. */
  async _computeAreaSuggestions(targetBbox) {
    try {
      const grid = await this.mcp.buildPoiLabelGrid(targetBbox, 65);
      if (!grid?.length) return [];
      const norm = s => (s || '').normalize('NFKC').replace(/[\s　]+/g, '').toLowerCase();
      const names = [], seen = new Set();
      for (const g of grid) { const k = norm(g.name); if (g.name && !seen.has(k)) { seen.add(k); names.push(g.name); } }
      if (!names.length) return [];
      const picked = await this.llm.suggestProminentLandmarks(names.slice(0, 60), this._langCode());
      const out = [], used = new Set();
      for (const nm of picked) {
        const k = norm(nm); if (!k || used.has(k)) continue;
        const items = grid.filter(g => g.name && norm(g.name) === k);
        if (!items.length) continue;
        used.add(k);
        out.push({ text: nm, landmark: nm, items });
      }
      return out;
    } catch { return []; }
  }

  /** Resolve a clarify-supplied landmark name to coordinate points (no re-query loop). */
  async _resolveClarifyAnchor(text) {
    try {
      const sb = await this.mcp.searchBox(text, { types: 'poi,address,place' });
      return (sb?.features || []).slice(0, 5)
        .map(f => { const c = f.geometry?.coordinates; return c ? { longitude: c[0], latitude: c[1] } : null; })
        .filter(Boolean);
    } catch { return null; }
  }

  /**
   * Overflow resolution. Returns { bbox, note } to re-collect the target in a tighter
   * area, or null to proceed with the capped set.
   */
  async _resolveOverflow(schema, bboxes, collected) {
    const en = this._langCode() === 'en';
    const tgt = schema.target?.text || '';

    // 1) Promote a selective tight condition (e.g. すぐ隣にドミノピザ) → its area.
    const anchor = this._findPromotableAnchor(schema, collected.conditions);
    if (anchor) {
      const bbox = this._bboxFromPoints(anchor.items, anchor.radiusM);
      if (bbox) return { bbox, note: en
        ? `Too many「${tgt}」here — narrowing to the area around「${anchor.label}」.`
        : `「${tgt}」が多すぎるため「${anchor.label}」周辺に絞って探します。` };
    }

    // 2) No selective anchor → ask the user for a distinguishing landmark (+ suggestions).
    const suggestions = await this._computeAreaSuggestions(bboxes.targetBbox);
    const prompt = en
      ? `There are too many「${tgt}」in this area. Tell me a nearby landmark (store / facility / park) to pinpoint it — or pick one below.`
      : `この辺りは「${tgt}」が多すぎます。近くの目印（店・施設・公園など）を教えてください（下から選んでもOK）。`;
    const hint = await this.ui.showHintInput(prompt, suggestions);
    if (!hint) return null; // skipped → accept the capped set

    let points, label;
    if (typeof hint === 'object' && hint.landmark) { points = hint.items; label = hint.landmark; }
    else { label = String(hint); points = await this._resolveClarifyAnchor(label); }
    if (!points || !points.length) return null;

    const bbox = this._bboxFromPoints(points, 250);
    if (!bbox) return null;
    return { bbox, note: en ? `Narrowing to the area around「${label}」.` : `「${label}」周辺に絞って探します。` };
  }

  _bboxExceedsLimit(bbox) {
    if (!bbox) return false;
    const [minX, minY, maxX, maxY] = bbox;
    const latDiff  = Math.abs(maxY - minY);
    const lngDiff  = Math.abs(maxX - minX);
    const halfM    = Math.max(latDiff, lngDiff) * 111000 / 2;
    return halfM > this.config.BBOX_MAX_HALF_M;
  }

  // ─────────────────────────────────────────────
  // [3-B] Step1: collect candidates
  // ─────────────────────────────────────────────

  async _collectCandidates(schema, { targetBbox, condBbox }) {
    const { target, conditions } = schema;

    // Build ONE shared poi_label grid over the widest (condition) bbox, reused by the
    // target and every poi condition — they all query poi_label, so one dense (65)
    // pass replaces N per-query grids (fixes latency; keeps full recall). Skip only
    // for huge general-target areas (buildings are bounded earlier by push-back).
    const targetIsBuilding = ['category_mansion', 'category_apartment', 'category_building']
      .includes(target?.query_intent);
    const useGrid = targetIsBuilding || this.mcp._bboxToRadius(condBbox) <= 1500;
    // proximity.within の穴（内側isochrone内）はグリッド点をskip（「n分以上」ドーナツのTQ削減）
    const sharedGrid = useGrid ? await this.mcp.buildPoiLabelGrid(condBbox, 65, this._reachHole || null) : null;

    // Target collection (partition shared grid to the tight target bbox)
    let mainRaw = await this.mcp.collectTarget(target, targetBbox, sharedGrid);
    mainRaw = this._applyBuildingNameRules(target, mainRaw);
    mainRaw = this._dedupTargets(mainRaw); // [pre-scoring] drop duplicate candidates (see method)

    // proximity.within=isochrone: hard-limit targets to the reachable polygon ("徒歩n分以内")。
    // reachRaw: 到達圏内に絞ったあとの生件数。過密(overflow)判定はこの数で行う（膨らんだ
    // bbox全体の生件数ではなく、実際に到達圏内にある候補数で判断させる）。
    let reachRaw = null;
    if (this._reachPolygons?.length || this._reachHole) {
      const { kept, excluded } = this.mcp.filterInsidePolygons(mainRaw, this._reachPolygons, this._reachHole);
      excluded.forEach(c => this._dbgReport.excludedByHardFilter.push({
        name: c.name || '(名前なし)', reason: `到達圏（proximity.within）外のため除外`,
      }));
      mainRaw = kept;
      reachRaw = mainRaw.length;
    }

    // Conditions collection (partition shared grid to the wide condition bbox) — parallel
    const condResults = {};
    const condDebug   = [];
    if (conditions?.length) {
      await Promise.all(conditions.map(async (c) => {
        const key = c.text ?? c.type;
        // road/water/rail are evaluated per-candidate against the road/water layer
        // (they're lines, not points) — no item collection here.
        if (isLineCond(c.type)) {
          condDebug.push({ label: key, type: c.type, level: c.distance?.level, method: c.distance?.method, found: '候補ごと評価' });
          return;
        }
        const items = await this.mcp.collectCondition(c, condBbox, sharedGrid);
        condResults[key] = items;
        condDebug.push({ label: key, type: c.type, level: c.distance?.level, method: c.distance?.method, found: items.length });
        // [S] note if condition returned 0 items
        if (!items || items.length === 0) {
          this.ui.showMessage(this._m().condNotFound(key));
        }
      }));
    }

    // [3-B0] L2-1 category validity filter (通常クエリ collections only): drop candidates
    // whose poi_category/class is clearly different from the intent. Runs BEFORE the
    // reach-polygon build (conditions) and BEFORE L2-2 (target) so noise (e.g. コンビニ
    // named "セブンイレブン天神中央公園") never pollutes downstream geometry/scoring.
    mainRaw = await this._applyCategoryFilter(schema, mainRaw, condResults);

    // [3-B1] L2-2 relevance rating: remove 'no', tag kept as definitely/probably/unknown
    const { kept, excludedNames } = await this._rateMain(target, mainRaw);

    // [3-B1'] poi条件にも同じ名前ベース関連性(L2-2)を適用し「no」を除外。
    // L2-1（カテゴリ）は同分野を残す方針のため、スーパー条件に八百屋が残る等が起きる。
    // 通常クエリの一部（target/condition）として挙動を揃えるため、条件も名前で弾く。
    await Promise.all((schema.conditions || []).filter(c => c.type === 'poi').map(async c => {
      const key = c.text ?? c.type;
      const items = condResults[key];
      if (!items?.length) return;
      const { kept: keptCond } = await this._rateMain({ text: c.text, query_intent: c.query_intent || 'specific' }, items);
      condResults[key] = keptCond;
    }));

    // Debug: target + condition collection breakdown
    const tdbg = this.mcp._lastTargetDebug || null;
    // Pre-slice raw count → overflow signal (target too dense for the proximity bbox).
    // 到達圏(within)で絞った場合はその件数を使う（膨らんだbbox全体の生件数で誤判定しない）。
    this._targetRaw = reachRaw != null ? reachRaw : (tdbg?.raw_count ?? mainRaw.length);
    this._dbgReport.target = {
      intent:        this._buildIntentLabel(target),
      queries:       Array.isArray(target?.queries) ? target.queries : (target?.text ? [target.text] : []),
      raw:           mainRaw.length,
      excluded:      excludedNames.length,
      excludedNames: excludedNames.slice(0, 40),
      kept:          kept.length,
      keptNames:     kept.map(c => c.name).slice(0, 50),
      // Raw collection lists (before L2 rating): what each API returned + what the
      // name/class filter dropped. Surfaced so the collection stage is inspectable.
      sbCount:       tdbg?.sb_count ?? null,
      tqCount:       tdbg?.tq_count ?? null,
      tqDroppedCount: tdbg?.tq_dropped_count ?? null,
      wantClasses:   tdbg?.want_classes ?? null,
      sbItems:       tdbg?.sb_items ?? [],
      tqItems:       tdbg?.tq_items ?? [],
      tqDropped:     tdbg?.tq_dropped ?? [],
    };
    this._dbgReport.conditions = condDebug;

    return { main: kept, conditions: condResults };
  }

  /**
   * L2-1 category validity filter. Applies to 通常クエリ collections only:
   *   - target when query_intent === 'specific' (general_poi search via Search Box)
   *   - conditions of type 'poi'
   * For each such group: dedupe candidate poi_category(SB)/class(TQ), ask the LLM which
   * categories are clearly-wrong (remove-set), then drop matching candidates.
   * Soft: candidates with no category are kept; a removal that would empty a group is skipped.
   * Mutates condResults[key] in place; returns the (possibly filtered) target list.
   */
  async _applyCategoryFilter(schema, mainRaw, condResults, opts = {}) {
    // opts.includeTarget=false → skip the target group (e.g. narrow, where the pool is fixed).
    // opts.condKeys (Set) → only process these condition keys (e.g. narrow: new conditions
    // only, so already-filtered old conditions aren't re-filtered/shrunk).
    const { includeTarget = true, condKeys = null } = opts;
    const target = schema.target;
    const TARGET_KEY = '__target__';
    const groups = [];

    // target group (general_poi search only)
    if (includeTarget && target && target.query_intent === 'specific' && mainRaw?.length) {
      groups.push(this._buildCatGroup(TARGET_KEY, target.text || this._buildIntentLabel(target), mainRaw));
    }
    // poi condition groups
    for (const c of (schema.conditions || [])) {
      if (c.type !== 'poi') continue;
      const key   = c.text ?? c.type;
      if (condKeys && !condKeys.has(key)) continue; // limited to the requested keys
      const items = condResults[key];
      if (items?.length) groups.push(this._buildCatGroup(key, c.text || key, items));
    }

    // only groups that actually carry a category vocabulary can be judged
    const judgeable = groups.filter(g => g.poi_category.length || g.class.length);
    if (judgeable.length === 0) return mainRaw;

    const cacheKeyOf = g => `${g.intent}||${[...g.poi_category].sort().join(',')}||${[...g.class].sort().join(',')}`;

    // send only un-cached groups to the LLM (one batched call). Use simple ASCII keys
    // (g0,g1,…) for the LLM payload so it doesn't have to echo Japanese keys back.
    const uncached = judgeable.filter(g => !this._catCache.has(cacheKeyOf(g)));
    if (uncached.length) {
      const res = await this.llm.filterCategories(uncached.map((g, i) => ({
        key: `g${i}`, intent: g.intent, poi_category: g.poi_category, class: g.class,
      })));
      if (res) {
        uncached.forEach((g, i) => {
          if (res[`g${i}`]) this._catCache.set(cacheKeyOf(g), res[`g${i}`]);
        });
      }
    }

    // null-category handling (setting): false = drop candidates with no category at all.
    const excludeNull = this.config.L2_1_KEEP_NULL_CATEGORY === false;

    // apply removals (soft + never-empty)
    const dbg = [];
    let outMain = mainRaw;
    for (const g of judgeable) {
      const removeSet = this._catCache.get(cacheKeyOf(g));
      if (!removeSet) continue; // uncached (LLM failed) → keep all
      const { remove_poi_category, remove_class } = removeSet;
      const hasRemovals = remove_poi_category.size || remove_class.size;
      if (!hasRemovals && !excludeNull) continue; // nothing to do for this group
      const survivors = g.items.filter(it => {
        if (this._catMatchesRemove(it, remove_poi_category, remove_class)) return false; // clearly-wrong category
        if (excludeNull && !this._hasCategory(it)) return false;                          // no category → strict drop
        return true;
      });
      const after = survivors.length ? survivors : g.items; // never-empty guard
      dbg.push({
        label:       g.key === TARGET_KEY ? 'target' : g.key,
        removePoi:   [...remove_poi_category],
        removeClass: [...remove_class],
        nullDropped: excludeNull,
        before:      g.items.length,
        after:       after.length,
      });
      if (g.key === TARGET_KEY) outMain = after;
      else condResults[g.key] = after;
    }
    if (dbg.length) this._dbgReport.categoryFilter = dbg;
    return outMain;
  }

  /** Build a category group: dedupe poi_category(SB) and class/maki(TQ) across items. */
  _buildCatGroup(key, intent, items) {
    const poiCat = new Set();
    const cls    = new Set();
    for (const it of items) {
      if (Array.isArray(it.poi_category)) it.poi_category.forEach(c => { if (c) poiCat.add(String(c)); });
      if (it.cls)  cls.add(String(it.cls));
      if (it.maki) cls.add(String(it.maki));
    }
    return { key, intent, items, poi_category: [...poiCat], class: [...cls] };
  }

  /** True if the item carries any category signal (poi_category / class / maki). */
  _hasCategory(it) {
    return (Array.isArray(it.poi_category) && it.poi_category.length > 0) || !!it.cls || !!it.maki;
  }

  /** True if the item's own categories intersect the remove-set (→ drop). */
  _catMatchesRemove(it, removePoi, removeClass) {
    if (Array.isArray(it.poi_category) && it.poi_category.some(c => removePoi.has(String(c)))) return true;
    if (it.cls  && removeClass.has(String(it.cls)))  return true;
    if (it.maki && removeClass.has(String(it.maki))) return true;
    return false;
  }

  async _rateMain(target, candidates) {
    if (!candidates || candidates.length === 0) return { kept: [], excludedNames: [] };

    // L2 relevance rating (all target types). 4-level ordinal for stability:
    // definitely / probably / unknown(default) / no(removed). Cached by intent||name
    // for the session so repeated queries stay stable (LLM rating is nondeterministic).
    const intentLabel = this._buildIntentLabel(target);
    const keyOf = c => `${intentLabel}||${(c.name || '').trim()}`;

    // Only send un-cached (and named) candidates to the LLM
    const uncached = candidates.filter(c => c.name && !this._ratingCache.has(keyOf(c)));
    if (uncached.length) {
      const BATCH = 40;
      const batches = [];
      for (let i = 0; i < uncached.length; i += BATCH) batches.push(uncached.slice(i, i + BATCH));
      const results = await Promise.all(batches.map(b =>
        this.llm.rateCandidates(intentLabel, b.map(c => ({ id: c.id, name: c.name })))
      ));
      batches.forEach((b, bi) => {
        const r = results[bi];
        if (!r) return; // failed batch → leave uncached (retry next time), default 'unknown' this run
        for (const c of b) {
          const id = String(c.id);
          const rel = r.no.has(id)         ? 'no'
                    : r.definitely.has(id) ? 'definitely'
                    : r.probably.has(id)   ? 'probably'
                    : 'unknown';
          this._ratingCache.set(keyOf(c), rel);
        }
      });
    }

    const kept = [], excludedNames = [];
    for (const c of candidates) {
      const rel = this._ratingCache.get(keyOf(c)) ?? 'unknown';
      if (rel === 'no') { excludedNames.push(c.name || '(名前なし)'); continue; }
      c._relevance = rel;
      kept.push(c);
    }
    return { kept, excludedNames };
  }

  /**
   * Decide how to match a road condition from its text.
   * - 大通り/幹線/国道等の一般語 → 幹線道路のみ (majorOnly)
   * - ○○通り/○○街道 等の固有名 → 名前一致
   * - それ以外 → 任意の道路
   */
  _roadOpts(text) {
    if (!text) return {};
    const t = text.trim();
    const MAJOR = ['大通り', '大通', '幹線', '幹線道路', '幹線道', '国道', '都道', '県道', '主要道路', '産業道路', '大道り'];
    if (MAJOR.includes(t)) return { majorOnly: true };
    if (/(通り|街道|バイパス|ライン|道路)$/.test(t) && t.length >= 3) return { name: t };
    return {};
  }

  _buildIntentLabel(target) {
    switch (target.query_intent) {
      case 'category_mansion':   return 'マンション（分譲・賃貸マンション等の中高層集合住宅）';
      case 'category_apartment': return 'アパート（木造・軽量鉄骨等の低層集合住宅。ハイツ・コーポ・荘・メゾン等を含む）';
      case 'category_building':  return 'ビル（オフィスビル・商業ビル・雑居ビル等の建物）';
      default:                   return target.text;
    }
  }

  // ─────────────────────────────────────────────
  // [3-C] Step2: evaluate distances
  // ─────────────────────────────────────────────

  async _evaluate(schema, mainCandidates, condCandidates, frozenLabels = null) {
    if (!mainCandidates || mainCandidates.length === 0) {
      return { full: [], partial: [], none: [] };
    }

    // frozenLabels: condition labels already evaluated in a previous run (「更に絞り込む」).
    // Their per-candidate result is reused from c._condEval instead of re-evaluated, so
    // the confirmed evaluation (e.g. distance to 天神中央公園) is never recomputed — this
    // keeps narrow results consistent with the initial search (no reach-origin flip).
    const isFrozen = label => !!(frozenLabels && frozenLabels.has(label));

    const allConditions = schema.conditions ?? [];

    // ── 絶対条件フィルタ（ハードフィルタ・スコアリング前に候補を除外）──
    // same_building(method=building_id) は SAME_BUILDING_MODE='hard' のときだけハード。
    // 'soft' のときは下の採点ループで「同ビル=closeness1」の条件として扱う（除外しない）。
    // 評価不能なら除外しない(graceful)。除外候補は excludedByHardFilter に記録。
    const sameBuildingHard = (this.config.SAME_BUILDING_MODE ?? 'hard') === 'hard';
    const isAbsolute = c => sameBuildingHard && resolveDistanceParams(c.distance, this.config.DEFAULT_LEVEL).useBuildingId;
    const hardConds  = allConditions.filter(isAbsolute);
    const conditions = allConditions.filter(c => !isAbsolute(c)); // ← 採点対象（ハードは除く）
    for (const hc of hardConds) {
      const label = hc.text ?? hc.type;
      if (isFrozen(label)) continue; // already applied on the confirmed pool
      const items = condCandidates[label] ?? [];
      // 0件: positive は評価不能で全員残す。negate（同ビルに無い）は対象が存在しない＝全員満たすので全員残す。→ どちらも残す。
      if (items.length === 0) continue;
      const { kept, excluded } = await this.mcp.filterSameBuilding(mainCandidates, items);
      // negate（例:「同じビルにファミマが無い」）→ 同ビル該当(kept)を落とし、非該当(excluded)を残す。
      const survivors = hc.negate ? excluded : kept;
      const removed   = hc.negate ? kept    : excluded;
      removed.forEach(c => this._dbgReport.excludedByHardFilter.push({
        name: c.name || '(名前なし)', reason: `絶対条件「${label}」(同じビル${hc.negate ? 'に無い' : ''})を満たさない`,
      }));
      mainCandidates = survivors;
    }
    if (mainCandidates.length === 0) return { full: [], partial: [], none: [] };

    // ── [floors] 建物階数を全候補分まとめて取得（streets-v8 building層・_getBuildingId と
    // 同一Tilequery URLでキャッシュ共有）。ハード/ソフト両方でここで一度だけ取る。──
    const floorSpec  = schema.target?.floors || null;
    const floorsHard = !!floorSpec && (this.config.FLOORS_MODE ?? 'hard') === 'hard';
    const floorsSoft = !!floorSpec && (this.config.FLOORS_MODE ?? 'hard') === 'soft';
    if (floorSpec) {
      await Promise.all(mainCandidates.map(async c => {
        const lat = c.latitude ?? c.lat, lng = c.longitude ?? c.lng;
        c._floors = (lat != null && lng != null) ? await this.mcp._getBuildingFloors(lat, lng) : null;
      }));
    }
    // floorsハード: fail-closed。仕様を「証明できた」候補だけ残す。階数が取れない候補は
    // 満たすと確認できない以上、ハードでは不合格（除外）にする（例: 20階以上指定で高さ不明の
    // カフェが素通りして検証済みの高層より上位に来る不具合を防ぐ）。緩めたい場合はソフトへ。
    if (floorsHard) {
      const specLabel = this._floorSpecLabel(floorSpec) + (floorSpec.negate ? 'ではない' : '');
      const kept = [];
      for (const c of mainCandidates) {
        if (c._floors != null && this._floorPass(c._floors, floorSpec)) { kept.push(c); continue; }
        // negate（「N階建てではない」）で階数不明なら fail-open で残す：大半の建物は該当高さ
        // ではないので、不明を一律除外すると候補が空になりやすい（positive は従来どおり fail-closed）。
        if (c._floors == null && floorSpec.negate) { kept.push(c); continue; }
        this._dbgReport.excludedByHardFilter.push({
          name: c.name || '(名前なし)',
          reason: c._floors == null
            ? `階数を取得できず「${specLabel}」を確認できないため除外（ハード）`
            : `絶対条件「${specLabel}」を満たさない（${c._floors}階相当）`,
        });
      }
      mainCandidates = kept;
      if (mainCandidates.length === 0) return { full: [], partial: [], none: [] };
    }

    // conditionTracker: candidateId → { total, hit, closenessSum }
    const tracker = new Map();
    for (const c of mainCandidates) {
      tracker.set(String(c.id), { candidate: c, total: conditions.length, hit: 0, hitLabels: [], closenessSum: 0 });
    }

    // 3要素の重み付き和: score = normalize(w_rel×relScore + w_cond×condScore + w_anchor×anchorScore)。
    // 利用可能な要素の重みだけで割る（条件なし→condを除外、距離不明→anchorを除外）。
    // relScore は4段階(絶対そう/多分そう/わからない、「違う」は_rateMainで除外済み)。
    const wRel    = Math.max(0, this.config.SCORE_WEIGHT_RELEVANCE ?? 0.3);
    const wCond   = Math.max(0, this.config.SCORE_WEIGHT_CONDITION ?? 0.5);
    const wAnchor = Math.max(0, this.config.SCORE_WEIGHT_ANCHOR    ?? 0.2);
    const relScore = c => {
      switch (c._relevance) {
        case 'definitely': return this.config.SCORE_REL_DEFINITELY ?? 1.0;
        case 'probably':   return this.config.SCORE_REL_PROBABLY   ?? 0.7;
        default:           return this.config.SCORE_REL_UNKNOWN    ?? 0.4; // unknown
      }
    };
    // anchorScore = proximityアンカーからの近さ。c.distance(アンカー中心からの距離) と
    // this._anchorRefM(target収集bbox半径) から算出。距離不明なら null（重みから除外）。
    const anchorScore = c => {
      const d = c.distance;
      if (d == null || !this._anchorRefM) return null;
      return Math.max(0, Math.min(1, 1 - d / this._anchorRefM));
    };
    // 利用可能な要素だけで正規化した重み付き和
    const weighted = (parts) => {
      let num = 0, den = 0;
      for (const [w, v] of parts) if (v != null && w > 0) { num += w * v; den += w; }
      return den > 0 ? num / den : 0;
    };

    // [floors] soft mode only: fuzzy score (|Δ| decay). _floors was already fetched above
    // (used by hard filter too). In hard mode floorsSoft=false → floorScore()===null → term omitted.
    const wFloors = Math.max(0, this.config.SCORE_WEIGHT_FLOORS ?? 0.4);
    const floorScore = (c) => {
      if (!floorsSoft || c._floors == null) return null; // no constraint / hard mode / no height → neutral
      const TOL = 6, f = c._floors;
      let d;
      if (floorSpec.value != null)                          d = Math.abs(f - floorSpec.value);
      else if (floorSpec.min != null && f < floorSpec.min)  d = floorSpec.min - f;
      else if (floorSpec.max != null && f > floorSpec.max)  d = f - floorSpec.max;
      else                                                  d = 0; // inside min/max range
      return Math.max(0, 1 - d / TOL);
    };

    if (conditions.length === 0) {
      // No conditions — score = relevance + anchor closeness (+ floors if soft-scored).
      mainCandidates.forEach(c => {
        const score = weighted([[wRel, relScore(c)], [wAnchor, anchorScore(c)], [wFloors, floorScore(c)]]);
        c._matchInfo = { hit: 0, total: 0, labels: [], score: +score.toFixed(3), relevance: c._relevance, floors: c._floors ?? null };
        c._matchInfo.reasons = this._candidateReasons(schema, c);
      });
      this._assignTiers(mainCandidates, [], []);
      mainCandidates.sort((a, b) => b._matchInfo.score - a._matchInfo.score);
      return { full: mainCandidates, partial: [], none: [] };
    }

    // reference reach per profile (m/min) for isochrone closeness approximation
    const speed = { walking: 80, cycling: 250, driving: 500 };

    // [FF] isochrone optimization: compute polygon once per anchor+level
    const isoCache = new Map();

    // Track which conditions were hit by ≥1 candidate. A condition hit by NOBODY
    // (0件/データ未収録/周辺に実在しない) carries zero ranking info and only drags
    // every candidate down uniformly — so it's excluded from the effective total below
    // (treated like 'unsupported': 注記のみ・非採点)。condNotFound already notified.
    const conditionHit = new Set();
    // addHit records the hit on the tracker AND freezes the per-candidate result on the
    // candidate (c._condEval[label]) so a later 「更に絞り込む」 can reuse it verbatim.
    const addHit = (t, label, closeness) => {
      t.hit++;
      t.hitLabels.push(label);
      conditionHit.add(label);
      t.closenessSum += closeness;
      (t.candidate._condEval ||= {})[label] = closeness;
    };
    const closenessOf = (nearestM, refM) => nearestM != null ? Math.max(0, Math.min(1, 1 - nearestM / refM)) : 0.5;

    for (const cond of conditions) {
      const label = cond.text ?? cond.type;

      // Frozen condition → reuse the confirmed per-candidate result (no re-evaluation).
      if (isFrozen(label)) {
        for (const main of mainCandidates) {
          const stored = main._condEval && main._condEval[label];
          if (stored != null) {
            const t = tracker.get(String(main.id));
            if (t) addHit(t, label, stored);
          }
        }
        continue;
      }

      const distParams = resolveDistanceParams(cond.distance, this.config.DEFAULT_LEVEL);
      const refM = distParams.radiusM
        ?? (distParams.minutes ? distParams.minutes * (speed[distParams.profile] || 80) : 250);

      // same_building as a SOFT scored condition (SAME_BUILDING_MODE='soft'): same building
      // → closeness 1, otherwise miss. (hard mode never reaches here — filtered out above.)
      if (distParams.useBuildingId) {
        const items = condCandidates[label] ?? [];
        if (items.length === 0) {
          // 0件: negate（同じビルにX無い）は対象が存在しない＝全員満たす。positive は評価不能でスキップ。
          if (cond.negate) for (const main of mainCandidates) { const t = tracker.get(String(main.id)); if (t) addHit(t, label, 1); }
          continue;
        }
        const { kept } = await this.mcp.filterSameBuilding(mainCandidates, items);
        const inSame = new Set(kept.map(k => String(k.id)));
        for (const main of mainCandidates) {
          const isSame = inSame.has(String(main.id));
          if (cond.negate ? isSame : !isSame) continue; // negate は非該当のみ満たす
          const t = tracker.get(String(main.id));
          if (t) addHit(t, label, 1);
        }
        continue;
      }

      // road / water / rail: per-candidate layer check (streets-v8 road/water layers).
      // 候補ごとに独立なので並列化（結果は候補順に同期適用するので挙動は同一）。
      if (isLineCond(cond.type)) {
        const roadOpts = cond.type === 'road' ? this._roadOpts(cond.text) : null;
        const results = await Promise.all(mainCandidates.map(main => {
          const lat = main.latitude ?? main.lat, lng = main.longitude ?? main.lng;
          if (cond.type === 'road') return this.mcp.roadNear(lat, lng, refM, roadOpts);
          if (cond.type === 'rail') return this.mcp.railNear(lat, lng, refM);
          return this.mcp.waterNear(lat, lng, refM);
        }));
        mainCandidates.forEach((main, i) => {
          const res = results[i];
          const near = res.matched && res.nearestM != null && res.nearestM <= refM;
          const t = tracker.get(String(main.id));
          if (!t) return;
          if (cond.negate) { if (!near) addHit(t, label, 1); }        // negate: 近くに無ければ満たす
          else if (near)   addHit(t, label, closenessOf(res.nearestM, refM));
        });
        continue;
      }

      // point-based conditions (poi / bus stop / intersection / signal)
      const condItems = condCandidates[label] ?? [];
      if (condItems.length === 0) {
        // 0件: negate（近くにX無い）は対象が存在しない＝全員満たす。positive は評価不能でスキップ。
        if (cond.negate) for (const main of mainCandidates) { const t = tracker.get(String(main.id)); if (t) addHit(t, label, 1); }
        continue;
      }
      const dir = cond.direction || null; // 「南側にアパホテル」→ item must be south of candidate
      // Build reach polygons on the fewer-cardinality side (fewer isochrone calls,
      // and centers the reach on the fixed reference — correct for "X分以内 from anchor").
      const matches = await this.mcp.evaluateDistanceBatch(mainCandidates, condItems, distParams, isoCache, dir);
      if (cond.negate) {
        // negate: 近くに該当POIがある候補を除外し、無い候補が満たす。
        for (const main of mainCandidates) {
          if (matches.has(String(main.id))) continue;
          const t = tracker.get(String(main.id));
          if (t) addHit(t, label, 1);
        }
      } else {
        for (const [mid, nearestM] of matches) {
          const t = tracker.get(mid);
          if (t) addHit(t, label, closenessOf(nearestM, refM));
        }
      }
    }

    // 有効条件数 = 少なくとも1候補がヒットした条件のみ。全員0ヒットの条件（0件/データ
    // 未収録/周辺に実在しない）は分母から除外する。こうしないと評価不能な条件が全候補を
    // 一律 partial(bronze) に落とし、condScore も薄める。type を問わず適用（poi/road/水域/
    // 出口/バス停…）。除外条件は condNotFound で既に注記済み。
    const effTotal = conditions.filter(c => conditionHit.has(c.text ?? c.type)).length;

    // Classify (OR — all displayed) + attach continuous score.
    // score = normalize(w_rel×relScore + w_cond×condScore + w_anchor×anchorScore + w_floors×floorScore)。
    const full = [], partial = [], none = [];
    for (const [, t] of tracker) {
      // condScore = 有効条件での平均closeness（分母=effTotal、非ヒット条件は0算入）。
      // hit で割る条件付き平均は partial を楽観評価するため effTotal で割る（統計レビュー §4）。
      // effTotal===0（有効条件なし）は null にして weighted の重みから除外＝relevance/anchorのみ。
      const condScore = effTotal > 0 ? t.closenessSum / effTotal : null;
      const c = t.candidate;
      const score = weighted([[wRel, relScore(c)], [wCond, condScore], [wAnchor, anchorScore(c)], [wFloors, floorScore(c)]]);
      c._matchInfo = { hit: t.hit, total: effTotal, labels: t.hitLabels, score: +score.toFixed(3), relevance: c._relevance, floors: c._floors ?? null };
      c._matchInfo.reasons = this._candidateReasons(schema, c);
      // effTotal===0 のとき hit(0)===effTotal(0) で full 扱い（＝条件なしと同じ挙動）。
      if (t.hit === effTotal)     full.push(c);
      else if (t.hit > 0)         partial.push(c);
      else                        none.push(c);
    }

    // Tiering (JS, deterministic): 絶対ゲート＋マージン。絶対水準を満たし単独突出のときのみ
    // gold、僅差なら "同程度"(match)、全件低スコアなら gold なし。詳細は _assignTiers。
    this._assignTiers(full, partial, none);

    // Sort each class by score desc (best first)
    const byScore = (a, b) => (b._matchInfo.score - a._matchInfo.score);
    full.sort(byScore); partial.sort(byScore);

    return { full, partial, none };
  }

  /**
   * Rank-based tiers (clearer than score-distribution). Within full-match, rank by score:
   *   #1 → full1 (最有力), #2 → full2, #3 → full3, #4+ → full (全一致).
   *   partial → partial (部分一致), none → none (参考).
   * (Decisiveness/margin no longer used — the top is always declared as 最有力.)
   */
  _assignTiers(full, partial, none) {
    const sorted = [...full].sort((a, b) => (b._matchInfo?.score ?? 0) - (a._matchInfo?.score ?? 0));
    sorted.forEach((c, i) => {
      c._rank = i + 1;
      c._tier = i === 0 ? 'full1' : i === 1 ? 'full2' : i === 2 ? 'full3' : 'full';
    });
    partial.forEach(c => { c._tier = 'partial'; });
    none.forEach(c => { c._tier = 'none'; });
  }

  // ─────────────────────────────────────────────
  // [4] Show results
  // ─────────────────────────────────────────────

  _showResults({ full, partial, none }, schema) {
    const totalMain = full.length + partial.length + none.length;

    if (totalMain === 0) {
      // [L] main 0 → ask for more info
      this.ui.showMessage(this._m().mainZero(schema.proximity?.anchors?.[0]?.text || '', schema.target?.text || ''));
      return;
    }

    const hasMatch = full.length > 0 || partial.length > 0;

    // 参考(none) is only shown when there is NO full/partial match (else too many).
    const displayNone = hasMatch ? [] : none;

    // Remember the MATCHED candidates (full+partial) so that "更に絞り込む" narrows within
    // these. 参考(none) is excluded on purpose — it matched no condition and is only a
    // fallback display, so it must not become part of the narrow pool.
    this._cache.surfaced = [...full, ...partial];

    // Summary shown as the header INSIDE the candidate-list bubble (not a separate message).
    // 全一致(F)の件数でMECEに分岐。条件の有無で語を出し分け。
    const M = this._m();
    const hasCond = (schema.conditions?.length || 0) > 0;
    const F = full.length;
    let summary;
    if (F === 1)                summary = M.resultPinpoint(hasCond);
    else if (F >= 2 && F <= 5)  summary = M.resultFew(F, hasCond);
    else if (F >= 6 && F <= 10) summary = M.resultSomewhat(F, hasCond);
    else if (F >= 11)           summary = M.resultMany(hasCond);
    else if (partial.length > 0 || displayNone.length > 0)
                                summary = M.resultNoExact(partial.length + displayNone.length);
    else                        summary = M.resultNone(hasCond);

    const conditionLabels = (schema.conditions ?? []).map(c => c.text ?? c.type);
    // 除外事項(A:上限超過の地理条件 / B:非地理的な特徴)を結果の場所でも透明化（早出し吹き出しに加えパネルにも併記）。
    const droppedNote = this._exclusionNote(schema);
    this.ui.showResults(full, partial, displayNone, summary, conditionLabels, droppedNote);

    // [大体の位置] area result: draw an approximate area (convex hull) around the
    // surfaced candidates when the query asked for a rough location, not a pinpoint.
    if (schema.result_area) {
      const areaPts = (hasMatch ? [...full, ...partial] : displayNone)
        .filter(c => (c.longitude ?? c.lng) != null && (c.latitude ?? c.lat) != null);
      if (areaPts.length) {
        this.ui.showProbableArea?.(areaPts, this._langCode() === 'en' ? 'Roughly this area' : 'だいたいこの辺りです');
      }
    }
  }

  // ─────────────────────────────────────────────
  // [5][6] Feedback handling
  // ─────────────────────────────────────────────

  async _handleFeedback(schema, originalText) {
    const proximityLabel = (schema?.proximity?.anchors || []).map(a => a.text).filter(Boolean).join('・') || null;
    // 「更に絞り込む」は現在の候補プール(surfaced=full+partial)の中で絞る操作。プールが1件以下なら
    // 絞り込む対象が無い＝無意味なのでボタンを隠す。
    const canNarrow = (this._cache.surfaced?.length || 0) > 1;
    const action = await this.ui.showFeedback(proximityLabel, { canNarrow });

    if (action === 'done') {
      this.ui.showMessage(this._m().confirmed);
      this._resetCache();
      return;
    }

    if (action !== 'narrow' && action !== 'research') return;

    // Reset telemetry for this refine cycle BEFORE computing suggestions, so the L3
    // suggestion call is counted (otherwise the reset would wipe its stats).
    this.llm.resetStats?.();
    this._runStart = Date.now();

    // [L3] Agent suggestions (narrow only): differentiating landmarks near the top-tier
    // candidates, offered as buttons alongside free input. Each carries its resolved
    // poi_label items so choosing one never re-queries.
    // 目印サジェスト（候補ごと）＋ 目印が付かなかった候補には階数サジェストを併用。
    // 例）A は離れていて固有の目印あり、B/C は目印なし → A=目印, B/C=階数（一意なら）。
    let suggestions = [];
    if (action === 'narrow') {
      const landmarks = await this._computeSuggestions(schema);
      const covered = new Set(landmarks.map(s => s.candId).filter(id => id != null));
      const floors  = await this._computeFloorSuggestions(schema, covered);
      suggestions = [...landmarks, ...floors];

      // デバッグ: なぜサジェストが出た/出ないのかを可視化（プール・各候補の階数・目印割り当て）。
      if (this.ui.isDebug?.()) {
        const basis = this._basisTier(this._cache.surfaced || []).slice(0, 5);
        const rows = basis.map(c => {
          const lm = landmarks.find(s => s.candId === c.id);
          const fl = c._floors == null ? '階数不明' : `${c._floors}階`;
          return `・${c.name || '(名前なし)'}: ${fl} / ${lm ? '目印=' + lm.landmark : '目印なし'}`;
        });
        this.ui.showDebug?.([
          '🔍 絞り込みサジェスト (narrow)',
          `プール(surfaced) ${this._cache.surfaced?.length ?? 0}件 / basis ${basis.length}件`,
          ...rows,
          `→ 目印サジェスト ${landmarks.length}件 / 階数サジェスト ${floors.length}件${floors.length ? '（' + floors.map(s => s.text).join('、') + '）' : ''}`,
        ].join('\n'));
      }
    }

    const hint = await this.ui.showHintInput(this._m().ask_hint, suggestions);
    if (!hint) return;
    this.ui.thinking?.(this._m().thinkingNarrow); // 絞り込み計算中も考え中表示

    // 階数サジェスト選択 → その階数の候補だけに絞る（再検索せず表示中の候補をフィルタ）。
    if (hint && typeof hint === 'object' && hint.floors != null) {
      await this._narrowByFloors(schema, hint.floors);
      return;
    }

    // Chosen agent suggestion → use the KNOWN poi items directly (no parse, no re-query).
    if (hint && typeof hint === 'object' && hint.landmark) {
      const cond = {
        type: 'poi', text: hint.landmark, query_intent: 'specific', queries: [hint.landmark],
        direction: null,
        // 探索・文言と同じレベルで条件化（ズレ防止。既定 very_close=150m）
        distance: { method: 'radius', level: hint.level || 'very_close', profile: null, minutes: null, meters: null },
      };
      await this._narrowWithin(schema, [cond], { [hint.landmark]: hint.items });
      return;
    }

    const delta = await this.llm.parseRefinement(schema, hint, this._langCode());
    if (!delta) { this.ui.showMessage(this._m().err_understand); return; }
    const validTypes = SCHEMA_ENUMS.condition_type;
    const addConds = delta.add_conditions.filter(c => c && validTypes.includes(c.type));

    // ── narrow: filter WITHIN the already-surfaced Target candidates (pool fixed,
    // target NOT re-collected). Purely additive — only new conditions apply. ──
    if (action === 'narrow') {
      if (!addConds.length) { this.ui.showMessage(this._m().err_understand); return; }
      if (delta.confirmation) this.ui.showMessage(delta.confirmation);
      await this._narrowWithin(schema, addConds);
      return;
    }

    // ── research: surgically apply the full delta (add/remove/target/proximity) to
    // the existing schema and RE-SEARCH around the proximity (target re-collected). ──
    const merged = {
      ...schema,
      proximity:  schema.proximity,
      target:     schema.target,
      conditions: [...(schema.conditions || [])],
    };
    if (delta.new_target && delta.new_target.text) merged.target = { ...schema.target, ...delta.new_target };
    if (delta.new_proximity) merged.proximity = delta.new_proximity;
    if (delta.remove_condition_texts.length) {
      const rm = new Set(delta.remove_condition_texts);
      merged.conditions = merged.conditions.filter(c => !rm.has(c.text));
    }
    merged.conditions = [...merged.conditions, ...addConds];
    merged.confirmation = delta.confirmation;
    fillSchemaDefaults(merged, this.config.DEFAULT_LEVEL, Math.max(merged.conditions.length, this.config.MAX_CONDITIONS));

    if (!validateQuerySchema(merged).ok) { this.ui.showMessage(this._m().err_understand); return; }

    this._previousText = `${this._previousText}\n追加情報：${hint}`;
    this._dbgReport.schema = merged;
    if (delta.confirmation) this.ui.showMessage(delta.confirmation);
    // [④] show the FULL criteria being searched (not just the user's added input)
    this.ui.showMessage(this._criteriaSummary(merged));

    await this._executeSearch(merged, this._previousText);
  }

  /**
   * 階数サジェスト適用: 表示中の候補(surfaced)を、選ばれた階数の候補だけに絞って出し直す。
   * 提案階数は一意（その階数を持つ候補は1つ）なので通常1件＝ピンポイントになる。再検索せず、
   * 提案生成時に取得済みの c._floors でフィルタするだけ（安全・低コスト）。
   */
  async _narrowByFloors(schema, floorValue) {
    const pool = (this._cache.surfaced && this._cache.surfaced.length)
      ? this._cache.surfaced
      : this._cache.mainCandidates;
    if (!pool || !pool.length) {
      this.ui.showMessage(this._m().mainZero(schema.proximity?.anchors?.[0]?.text || '', schema.target?.text || ''));
      return;
    }
    const keep = pool.filter(c => c._floors === floorValue);
    this._previousText = `${this._previousText}\n絞り込み：${this._floorPhrase(floorValue)}`;
    this.ui.clearResults?.();
    // 選ばれた階数の候補を結果として提示（_showResults が surfaced を keep に更新する）。
    this._showResults({ full: keep, partial: [], none: [] }, schema);
    this.ui.showRunStats?.({ ms: Date.now() - (this._runStart || Date.now()), llm: this.llm.stats });
    await this._handleFeedback(schema, this._previousText);
  }

  /**
   * "更に絞り込む": narrow WITHIN the candidates that REMAINED from the previous attempt
   * (the surfaced full+partial results — NOT the full pre-evaluation pool). Target is
   * NOT re-collected; only the new conditions are collected and this fixed subset is
   * re-evaluated/re-tiered. Consecutive narrows keep shrinking the previous remainder.
   */
  async _narrowWithin(schema, addConds, preItems = null) {
    // preItems: { [condKey]: items } for conditions whose poi_label items are already
    // known (agent suggestions) — used directly, skipping the query AND the L2-1 filter.
    // Pool = last surfaced results (remaining candidates). Fall back to mainCandidates
    // only if surfaced wasn't captured (shouldn't happen after a normal run).
    const pool = (this._cache.surfaced && this._cache.surfaced.length)
      ? this._cache.surfaced
      : this._cache.mainCandidates;
    if (!pool || !pool.length) { this.ui.showMessage(this._m().mainZero(schema.proximity?.anchors?.[0]?.text || '', schema.target?.text || '')); return; }

    const merged = { ...schema, conditions: [...(schema.conditions || []), ...addConds] };
    fillSchemaDefaults(merged, this.config.DEFAULT_LEVEL, Math.max(merged.conditions.length, this.config.MAX_CONDITIONS));
    this._cache.schema = merged;
    this._previousText = `${this._previousText}\n絞り込み：${addConds.map(c => c.text ?? c.type).join('、')}`;
    this._dbgReport = { schema: merged, proximity: this._dbgReport.proximity, target: this._dbgReport.target, conditions: [], categoryFilter: [], evaluation: null, excludedByHardFilter: [] };

    // [④] show the FULL criteria being narrowed on (accumulated old + new conditions)
    this.ui.showMessage(this._criteriaSummary(merged));

    this.ui.clearResults?.();

    // Reuse the cached bbox; collect ONLY the new conditions (poi/point types).
    const bboxes = this._computeDualBbox(this._cache.bbox, merged);
    this._anchorRefM = Math.max(1, this._bboxWidthM(bboxes.targetBbox) / 2);

    // Collect ONLY the newly-added conditions (old conditions' items come from cache).
    const condResults = { ...(this._cache.condCandidates || {}) };
    const newKeys = new Set();
    for (const c of addConds) {
      const key = c.text ?? c.type;
      if (preItems && preItems[key]) { condResults[key] = preItems[key]; continue; } // known poi → no query, no L2-1
      newKeys.add(key);
      if (isLineCond(c.type)) continue; // per-candidate eval, no collection
      condResults[key] = await this.mcp.collectCondition(c, bboxes.condBbox, null);
    }
    // L2-1 category validity ONLY on the new poi conditions (target pool is fixed;
    // old conditions are already filtered — don't re-filter/shrink them).
    await this._applyCategoryFilter(merged, pool, condResults, { includeTarget: false, condKeys: newKeys });
    const keptPool = pool; // pool is fixed (target not re-collected)
    this._cache.condCandidates = condResults;
    // Debug: show ALL conditions (old + new) with item counts so it's clear the score
    // considers the accumulated conditions, not just the newly added one.
    this._dbgReport.conditions = (merged.conditions || []).map(c => {
      const key = c.text ?? c.type;
      const isLine = isLineCond(c.type);
      return { label: key, type: c.type, level: c.distance?.level, method: c.distance?.method, found: isLine ? '候補ごと評価' : (condResults[key]?.length ?? 0) };
    });

    // Evaluate with the FIXED pool. FREEZE the existing conditions (reuse each candidate's
    // confirmed per-condition result from the previous run) and evaluate ONLY the newly
    // added conditions — so the confirmed evaluation (e.g. distance to 天神中央公園) is
    // never recomputed and narrow stays consistent with the initial search.
    const frozenLabels = new Set((schema.conditions || []).map(c => c.text ?? c.type));
    this.mcp._evalPolygons = [];
    const results = await this._evaluate(merged, keptPool, condResults, frozenLabels);
    this.ui.drawHits?.(keptPool);
    Object.entries(condResults).forEach(([label, items], ci) => this.ui.drawConditionHits?.(items, ci, label));
    this.ui.drawPolygons?.(this.mcp._evalPolygons);
    this.ui.fitToBBox?.(bboxes.condBbox);
    this.ui.refreshCounts?.();

    const dbgRow = c => ({ name: c.name || '(名前なし)', score: c._matchInfo?.score ?? 0, tier: c._tier, rel: c._relevance, hit: c._matchInfo?.hit ?? 0, total: c._matchInfo?.total ?? 0, labels: c._matchInfo?.labels ?? [], floors: c._matchInfo?.floors ?? null });
    this._dbgReport.evaluation = { full: results.full.map(dbgRow), partial: results.partial.map(dbgRow), noneCount: results.none.length };

    this._showResults(results, merged);
    this.ui.showRunStats?.({ ms: Date.now() - (this._runStart || Date.now()), llm: this.llm.stats });
    this.ui.showDebugReport?.(this._dbgReport);

    await this._handleFeedback(merged, this._previousText);
  }

  // ─────────────────────────────────────────────
  // Cache (K — 3+1 granularity)
  // ─────────────────────────────────────────────

  _detectCacheInvalidation(newSchema) {
    const old = this._cache.schema;
    if (!old) return { bbox: true, candidates: true };

    const proximityChanged  = JSON.stringify(old.proximity)  !== JSON.stringify(newSchema.proximity);
    const targetChanged     = JSON.stringify(old.target)     !== JSON.stringify(newSchema.target);
    const conditionsChanged = JSON.stringify(old.conditions) !== JSON.stringify(newSchema.conditions);

    return {
      bbox:       proximityChanged,
      candidates: proximityChanged || targetChanged || conditionsChanged,
    };
  }

  _resetCache() {
    this._cache = { bbox: null, mainCandidates: null, condCandidates: null, surfaced: null, schema: null };
    this._clarifyCount = 0;
    this._previousText = null;
  }
}

// ─────────────────────────────────────────────
// Fixed UI text (systemdesign §5-3)
// ─────────────────────────────────────────────

const MESSAGES = {
  ja: {
    searching:            '候補を検索しています…',
    ask_proximity:        'どのあたりをお探しですか？地名や駅名を教えてください。',
    ask_target:           '何をお探しですか？',
    which_interpretation: 'どの意図に近いですか？下から選ぶか、言い方を変えて教えてください。',
    ask_hint:             'さらに絞り込む情報を教えてください（例：出口番号、近くの交差点名、建物の特徴など）。',
    confirmed:            'ありがとうございました。またお気軽にご相談ください。',
    welcome:              '探している場所を教えてください。近くの駅名・施設名・住所と、条件（近くのお店・道路など）を一緒に伝えていただくと絞り込めます。',
    no_condition_match:   '条件に完全一致する候補はありませんでしたが、候補を参考として地図に表示しています。',
    distance_too_far:     'その範囲は広すぎます。もっと近い目印を教えてください。',
    bbox_too_large:       'その範囲は広すぎます。もっと絞れる情報を教えてください。',
    proximity_too_broad:  'もう少し具体的な地名（町名・丁目等）か駅名を教えてください。',
    error_communication:  'うまくいきませんでした。もう一度お試しください。',
    err_timeout:          '応答に少し時間がかかっています。もう一度お試しください。',
    err_busy:             'ただいま混み合っているようです。少し待ってからもう一度お試しください。',
    err_server:           'サーバーが一時的に不安定なようです。少し待ってお試しください。',
    err_toolong:          '情報が多くてうまくまとめきれませんでした。条件を少し減らすか、言い方を変えてお試しください。',
    err_understand:       'うまく聞き取れませんでした。探している場所（駅・地名・施設）と、探しているものを教えていただけますか？',
    clarify_limit:        '情報が不足しています。分かる範囲で場所を教えてください。',
    not_a_query:          '場所の情報が読み取れませんでした。駅名・施設名・住所などと、探しているものを教えてください。（例：西大島駅の近くのマンション、バス停が目の前）',
    anchorNotFound:  t => `${t}が見つかりませんでした。別の地名や駅名をお試しください。`,
    whichArea:       t => `「${t}」はどちらですか？`,
    whichPoi:        t => `「${t}」はどれですか？`,
    didYouMean:      t => `もしかして「${t}」はこちらのことですか？`,
    proximityNarrow: t => `「${t}」は範囲が広すぎます。もう少し狭いエリア（駅名・町名など）で絞ってください。下の候補から選ぶか、直接入力できます。`,
    genericMulti:    t => `「${t}」は複数あります。地名や駅名も一緒に教えてください。`,
    intersectionNotFound: t => `「${t}」という名前の交差点が見つかりませんでした。`,
    condNotFound:    k => `「${k}」はこのエリアで見つかりませんでした（地図データ未収録の可能性があります）。`,
    mainZero:        (anchor, target) => `${anchor || 'この付近'}の近くに${target ? `「${target}」` : '候補'}は見つかりませんでした。追加の情報を教えていただけますか？`,
    resultPinpoint: hc => hc ? '条件を1つに絞り込めました！' : '候補を1つに特定できました！',
    resultFew:      (n, hc) => `${hc ? '条件に合う候補' : '候補'}が ${n}件 見つかりました。`,
    resultSomewhat: (n, hc) => `${hc ? '条件に合う候補' : '候補'}が少し多めに（${n}件）見つかりました。上位5件を表示します。`,
    resultMany:     hc => `${hc ? '条件に合う候補' : '候補'}が多数見つかりました。上位5件を表示します。`,
    resultNoExact:  n => `条件に完全一致する候補はありませんでした。近い候補を${n}件表示します。`,
    resultNone:     hc => hc ? '条件に合う候補を見つけられませんでした。' : '候補が見つかりませんでした。',
    reachTooLarge:  (min, prof, anchor) => `${({ walking: '徒歩', cycling: '自転車', driving: '車' })[prof] || '徒歩'}${min}分以上は範囲が広すぎるため、${anchor || 'この地点'}の周辺で探します。`,
    thinkingResolve: '場所を特定しています',
    thinkingCollect: '候補を集めています',
    thinkingEval:    '条件との距離を評価しています',
    thinkingNarrow:  '絞り込んでいます',
    droppedConditions: list => `なお、条件が多いため「${list}」は今回の検索には含めていません。`,
    unsupportedFeatures: list => `「${list}」は地図データから判定できないため条件に含めず、それ以外の分かる範囲で探索します。`,
    railSubwayNote: () => `「線路沿い」は地下鉄など地下を通る路線も線路とみなして検索します（地上の線路だけには限定できません）。`,
    walkAssumed: () => `移動手段の指定が無い所要時間は「徒歩」として扱いました（自転車・車の場合はお知らせください）。`,
  },
  en: {
    searching:            'Searching for candidates…',
    ask_proximity:        'Where should I look? Please give a place or station name.',
    ask_target:           'What are you looking for?',
    which_interpretation: 'Which did you mean? Pick one below, or rephrase it.',
    ask_hint:             'Add details to narrow it down (e.g. exit number, nearby intersection, building features).',
    confirmed:            'Thank you. Feel free to ask anytime.',
    welcome:              'Tell me the location you are looking for. Share a nearby station, facility, or address, plus conditions (nearby stores, roads, etc.).',
    no_condition_match:   'No candidate fully matched the conditions, but candidates are shown on the map for reference.',
    distance_too_far:     'That range is too wide. Please give a closer landmark.',
    bbox_too_large:       'That area is too large. Please provide something more specific.',
    proximity_too_broad:  'Please give a more specific place (town/block) or a station name.',
    error_communication:  'That did not go through. Please try again.',
    err_timeout:          'This is taking a little longer than usual. Please try again.',
    err_busy:             'Things are a bit busy right now. Please wait a moment and try again.',
    err_server:           'The server seems temporarily unstable. Please try again shortly.',
    err_toolong:          'That was a lot to take in. Try removing a condition or rephrasing.',
    err_understand:       "I couldn't quite catch that. Could you tell me the place (station / area / facility) and what you're looking for?",
    clarify_limit:        'Not enough information. Please tell me the location as best you can.',
    not_a_query:          "I couldn't read a location. Please give a station/facility/address and what you are looking for (e.g. a condo near Nishi-ojima station with a bus stop right in front).",
    anchorNotFound:  t => `Couldn't find "${t}". Please try another place or station name.`,
    whichArea:       t => `Which "${t}" do you mean?`,
    whichPoi:        t => `Which "${t}"?`,
    didYouMean:      t => `Did you mean one of these for "${t}"?`,
    proximityNarrow: t => `"${t}" covers too wide an area. Please narrow it to a smaller area (a station or town name). Pick one below or type it in.`,
    genericMulti:    t => `There are several "${t}". Please add a place or station name.`,
    intersectionNotFound: t => `No intersection named "${t}" was found.`,
    condNotFound:    k => `"${k}" wasn't found in this area (it may not be in the map data).`,
    mainZero:        (anchor, target) => `No ${target ? `"${target}"` : 'candidates'} found near ${anchor || 'this area'}. Could you give more information?`,
    resultPinpoint: hc => hc ? 'Narrowed down to a single match!' : 'Pinpointed a single candidate!',
    resultFew:      (n, hc) => `Found ${n} ${hc ? 'matching candidates' : 'candidates'}.`,
    resultSomewhat: (n, hc) => `Found quite a few ${hc ? 'matching candidates' : 'candidates'} (${n}). Showing the top 5.`,
    resultMany:     hc => `Found many ${hc ? 'matching candidates' : 'candidates'}. Showing the top 5.`,
    resultNoExact:  n => `No exact match; showing ${n} close candidate(s).`,
    resultNone:     hc => hc ? 'No matching candidates found.' : 'No candidates found.',
    reachTooLarge:  (min, prof, anchor) => `${min}+ min by ${prof || 'walking'} covers too wide an area; searching around ${anchor || 'this point'} instead.`,
    thinkingResolve: 'Locating the area',
    thinkingCollect: 'Gathering candidates',
    thinkingEval:    'Evaluating distances & conditions',
    thinkingNarrow:  'Narrowing down',
    droppedConditions: list => `Note: to keep the search focused, "${list}" ${/,/.test(list) ? 'are' : 'is'} not included in this search.`,
    unsupportedFeatures: list => `"${list}" cannot be determined from map data, so ${/,/.test(list) ? 'they are' : 'it is'} excluded — I search using the rest of what you gave.`,
    railSubwayNote: () => `For "along a railway", underground lines such as subways are also treated as railways (surface-only lines cannot be isolated).`,
    walkAssumed: () => `A travel time given without a mode was treated as walking (let me know if you meant cycling or driving).`,
  },
};
