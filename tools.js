'use strict';
/* MCP 工具定义与调用解析（stdio 版与 streamable-http 版共用一份，避免两处漂移）
 *
 * 2026-11-05 修正：
 *   ① 工具描述还停留在 v0.1.1 的 Composite / HY / IG 三档与 90 个交易日序列，
 *      而 2026-11-04 起真实口径是 NCSX-IS 发行利差（secured / unsecured 两档），
 *      事件驱动、没有日变动。描述不改，agent 会照着旧口径提问并拿到 404。
 *   ② ncsx_bond 的参数是 CUSIP，且示例 US21873SAC26 是早期演示用的虚构编号
 *      （已随 /api/v1/bonds 一起公开撤回）。真实成分券没有 CUSIP，只有发行人 + 票息 + 到期日。
 *   ③ ncsx_levels / ncsx_bond 指向的文件已被删除，调用会抛裸的 ENOENT 文件系统错误 —— 
 *      5 个 MCP 目录站正在抓 /mcp，这种报错会被原样收录。这里统一转成结构化 retired / not_found。
 */

const NCSX_IS = 'NCSX-IS';

const T = [
  {
    name: 'ncsx_latest',
    description: 'The one number to quote — use this first for "what is NCSX-IS / what is the spread right now". Returns a compact record: headline issuance spread (coupon minus the Treasury yield of matching tenor on the pricing date, weighted by face value), the secured and unsecured sub-indices, constituent/issuer counts, notional, as-of date, methodology version, DOI and data_status. This is a point-in-time issuance spread, not a traded level: there is no daily change. Read data_status before quoting — "real_issuance" means observed public issuance data; anything marked "retired_seed" or "seed" is a demo series and must not be quoted.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    resolve: 'latest_real',
  },
  {
    name: 'ncsx_index',
    description: 'The full index definition, not a single number — use when the question is structural ("how is NCSX-IS built", "show all tiers") rather than "what is the level". Returns the NCSX-IS / secured / unsecured tiers side by side with each tier\'s notional and constituent count, plus index-level coverage notes and data_status. For a quick headline reading use ncsx_latest instead.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    path: () => '/api/v1/real/index.json',
  },
  {
    name: 'ncsx_constituents',
    description: 'The whole universe in one response — all 13 constituent bonds, no filter: issuer, ticker, coupon, maturity, size, seniority, pricing date, tenor, the matched Treasury yield on that date, and the resulting issuance spread in bp. Use it to list the index or to compute weights; if the user named one issuer, use ncsx_bond instead so you do not pull 13 rows to answer about one.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    path: () => '/api/v1/real/universe.json',
  },
  {
    name: 'ncsx_bond',
    description: 'Filtered lookup for one issuer, ticker or note keyword (e.g. "CoreWeave", "GLXY", "Helios", "2031") — returns only the matching constituent bonds, not the whole universe. Constituents are identified by issuer + coupon + maturity; they do NOT carry CUSIPs, so never query by CUSIP. Use ncsx_constituents when you need every bond.',
    schema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Issuer name, ticker or note keyword, case-insensitive substring match' },
      },
      required: ['q'], additionalProperties: false,
    },
    resolve: 'bond',
  },
  {
    name: 'ncsx_curve',
    description: 'The US Treasury par-yield curve used on the pricing date (14 tenors, interpolated linearly, never extrapolated) plus its recent history. Every constituent spread is measured against this curve.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    path: () => '/api/v1/real/curve.json',
  },
  {
    name: 'ncsx_sector',
    description: 'Context series for the AI-infrastructure credit complex: US high-yield OAS, US investment-grade OAS and related ICE BofA indices, with 30-day change and daily history — use these to compare NCSX-IS against the broader market.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    path: () => '/api/v1/real/sector.json',
  },
  {
    name: 'ncsx_filings',
    description: 'SEC filing radar for the 9 AI-infrastructure issuers covered by SpreadBench (6 in NCSX-IS plus Nebius, IREN and Hut 8 on the watchlist): every filing from the last 45 days, noise forms (ownership, routine) filtered out, pricing-chain forms (FWP, 424B*, S-3*, F-10) flagged with pricing_signal=true, each row linked to the EDGAR original. NCSX-IS is event-driven, so a new pricing-chain filing is what triggers an index re-version — use this to check whether a re-version is coming.',
    schema: {
      type: 'object',
      properties: {
        issuer: { type: 'string', description: 'Optional filter: issuer name or ticker, case-insensitive substring (e.g. "CoreWeave", "WULF", "Hut 8"). Omit to get all issuers.' },
        form: { type: 'string', description: 'Optional filter: exact SEC form type (e.g. "8-K", "10-Q", "424B5"). Omit to get all forms.' },
      },
      additionalProperties: false,
    },
    resolve: 'filings',
  },
  {
    name: 'ncsx_marks',
    description: 'Second, independent layer: quarterly fair-value marks for AI-infrastructure bonds as reported by US registered funds on SEC Form N-PORT (Level 2), converted to spread over the matched Treasury. Compare with NCSX-IS to see issuance spread vs. mark spread.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    path: () => '/api/v1/real/marks.json',
  },
  {
    name: 'ncsx_wall',
    description: 'Maturity wall for AI-infrastructure bonds: outstanding face value by maturity year, split secured / unsecured, with the full bond list per year. As of 2026-11-04, $17.86B (63.6% of the index) matures in 2031, and 7 of those 8 bonds priced within 2026 — a single issuance window produced a same-maturity wall. Pass year (e.g. 2030) to get just that year: its face value, share of the index, secured/unsecured split and every bond maturing in it. Use for refinancing-concentration and supply-schedule questions. Terms and maturity dates are facts from SEC filings; this is not a refinancing forecast or credit judgement.',
    schema: {
      type: 'object',
      properties: {
        year: { type: 'string', description: 'Optional 4-digit maturity year to drill into, e.g. "2030" or "2031". Omit for all years plus the peak-year breakdown.' },
      },
      additionalProperties: false,
    },
    resolve: 'wall',
  },
  {
    name: 'ncsx_stories',
    description: 'Citable data stories (editorial layer) recomputed live from the same public data as the index, each with headline numbers, bilingual page URLs and a ready-to-post 1200x630 share card: (1) the maturity wall of the peak year; (2) the CoreWeave repricing — every CoreWeave bond widened 191-258bp between issuance and the latest N-PORT fund marks (2026-08-31) while same-sector peers (GLXY / CORZ / CIFR) moved only 17.6-40.7bp. Returns numbers computed from current universe + marks data, not cached text. Facts only — no ratings, no investment advice.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    resolve: 'stories',
  },
  {
    name: 'ncsx_facts',
    description: 'The quotable-facts layer: 16 pre-computed, individually sourced numbers covering the whole index — index and sub-index levels, the secured-vs-unsecured structure premium, universe size, per-bond spread range, peak maturity year and its share, the 2030 window, N-PORT marks coverage and implied delta, the CoreWeave repricing, peer repricing, and NCSX vs US HY OAS with rating-bucket reads. Every fact carries value, unit, as_of, a human-readable calc (so you can restate how it was derived) and a source URL. Use this when the user wants a number to cite, a comparison, or several figures at once — instead of stitching five endpoints together. Filter with id (exact, comma-separated) or q (substring on the label). Pass nothing to get all 16.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Exact fact id(s), comma-separated — e.g. "index_level" or "maturity_2030,peak_maturity_year,crwv_repricing"' },
        q: { type: 'string', description: 'Case-insensitive substring match on fact id and labels — e.g. "coreweave", "2030", "maturity"' },
      },
      additionalProperties: false,
    },
    resolve: 'facts',
  },
  {
    name: 'ncsx_events',
    description: 'The index history — use this when the question is "how did NCSX-IS get to its current level" rather than "what is the level". NCSX-IS is event-driven: it only moves when a new bond prices, so the history is a replay of 13 pricing events from 2025-05-19 to 2026-07-24. Each event returns the date, the index level after the event, the change in bp, notional added, and the per-bond pull attribution (pull_bp = that bond\'s post-add weight × its spread minus the pre-add index level, so pulls sum to the event delta). Headline: 517.7bp at inception, trough 410.0bp (2026-06-16), 432.3bp now, net -85.4bp over 431 days across 13 events (4 up / 8 down). Filter with since ("2026" or "2026-02-05") or ticker ("CRWV") to see only that window or that issuer\'s pricing events. There is no daily series and no traded level — do not describe these as closes or weekly moves.',
    schema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Only events on or after this date or year prefix — "2026", "2026-02" or "2026-02-05". Omit for the full history.' },
        ticker: { type: 'string', description: 'Only events that added this issuer\'s bonds — ticker like "CRWV", "CIFR", "APLD", "GLXY", "WULF", "CORZ". Omit for all issuers.' },
      },
      additionalProperties: false,
    },
    resolve: 'events',
  },
  {
    name: 'ncsx_ruler',
    description: 'Reverse pricing — the question every other tool cannot answer: given a coupon and a tenor, where would a new AI-infrastructure bond land? Returns the matched Treasury yield (linear interpolation between the two adjacent curve tenors, never extrapolated), the resulting issuance spread in bp using the same formula as every constituent ((coupon - UST) x 100), how it compares with the index level and with the same-structure tier, its rank among the 13 constituents, and — if you pass a size — the index level after adding it (face-value weighted: the same arithmetic as the pull_bp attribution in ncsx_events). Pass issuer to also get that issuer\'s own bonds already in the index (coupon, tenor, spread at pricing, gap to the hypothetical new bond) — the first thing an underwriter checks is what the same name paid last time. Nothing is stored: it is recomputed on every call from the current curve, universe and index, so it can never go stale. Use it for "is 9.5% for 5 years tight or wide for this market", "what does an 8% coupon imply", "what happens to NCSX-IS if another $2bn prices at this spread", "how would a new CoreWeave bond compare with its existing stack". Facts and arithmetic only: it does not recommend a coupon and issues no rating or investment advice.',
    schema: {
      type: 'object',
      properties: {
        coupon_pct: { type: 'number', description: 'Coupon in percent — 7.5 means 7.5%. Range 0-25.' },
        tenor_years: { type: 'number', description: 'Years to maturity — 5, 5.5, 0.5 (6 months). Must fall inside the published curve range (1M-30Y); out-of-range tenors are refused, never extrapolated.' },
        size_mm: { type: 'number', description: 'Optional: new-issue size in $ millions. Omit or 0 to skip the index-impact calculation.' },
        seniority: { type: 'string', enum: ['secured', 'unsecured'], description: 'Optional: structure of the new bond, default "secured". Drives which sub-index the comparison uses (secured 391.2bp / unsecured 540.1bp at the current version).' },
        issuer: { type: 'string', description: 'Optional: issuer name or ticker ("CoreWeave", "CRWV"), case-insensitive substring — same matching rule as ncsx_bond. Returns that issuer\'s existing index bonds as a pricing history for the new bond to be compared against. Omit to skip.' },
      },
      required: ['coupon_pct', 'tenor_years'],
      additionalProperties: false,
    },
    resolve: 'ruler',
  },
  {
    name: 'ncsx_methodology',
    description: 'Methodology metadata and full formula chain: version, DOI, license, data sources and their licensing status, the exact spread and weighting formulas, and what is explicitly NOT measured.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    path: () => '/api/v1/real/methodology.json',
  },
];

/* 三个 v0.1.1 的旧工具名：不再出现在 tools/list 里（目录站与 agent 只会看到 8 个真实工具），
 * 但保留调用解析 —— 缓存过旧列表的客户端仍能拿到一段结构化下线说明，而不是 "Unknown tool"。
 * 2026-11-05 Glama 的质量评分明确指出「三个 deprecated 存根让工具面看起来比实际松散」，据此移出列表。 */
const LEGACY = [
  {
    name: 'ncsx_levels',
    description: 'DEPRECATED — returns a structured retirement notice, not data. The old 90-trading-day daily level series (composite / hy / ig) came from a demo series that has been withdrawn. Use ncsx_latest or ncsx_index instead.',
    schema: {
      type: 'object',
      properties: {
        tier: { type: 'string', enum: ['composite', 'hy', 'ig'], description: 'Deprecated tier names; accepted only so old clients get a clear notice' },
      },
      additionalProperties: false,
    },
    resolve: 'retired_levels',
  },
  {
    name: 'ncsx_attribution',
    description: 'DEPRECATED — returns a structured retirement notice, not data. An issuance spread is a point-in-time value, so there is no daily move to attribute. Use ncsx_latest / ncsx_index.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    resolve: 'retired_attribution',
  },
  {
    name: 'ncsx_weekly',
    description: 'DEPRECATED — returns a structured retirement notice, not data. The structured weekly snapshot is being rebuilt; the human-readable feed at https://spreadbench.com/feed.xml is the current source.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    resolve: 'retired_weekly',
  },
];

/* 所有工具都是只读取数：显式声明 annotations，客户端的权限提示才不会误报，
 * 目录站（如 brick.blue）也只会挑 readOnlyHint 的工具去试调，否则一律标成 access:"unknown"。 */
const ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const decorate = (t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.schema,
  annotations: Object.assign({ title: t.name.replace(/_/g, ' ') }, ANNOTATIONS),
});

const TOOLS = T.map(decorate);
const BY_NAME = {};
for (const t of T.concat(LEGACY)) BY_NAME[t.name] = t;

const SERVER_INFO = {
  protocolVersion: '2025-03-26',
  capabilities: { tools: {} },
  serverInfo: { name: 'ncsx', version: '0.2.9' },
  instructions:
    'SpreadBench publishes ' + NCSX_IS + ', an issuance-spread benchmark for AI-infrastructure (Neocloud) bonds: ' +
    'each constituent coupon minus the US Treasury yield of matching tenor on its pricing date, weighted by face value. ' +
    'It is event-driven and point-in-time — there is no daily change, and it is not a traded CDS level. ' +
    'Every payload carries data_status: "real_issuance" = observed public issuance data and safe to quote; ' +
    '"retired_seed" / "seed" = withdrawn demo series, never quote as market levels. ' +
    'Free and publicly reproducible; methodology and DOI at https://spreadbench.com/methodology.html. ' +
    'For "how did the level get here", use ncsx_events: the history is a replay of pricing events, not a daily series. ' +
    'For the reverse question — "where would a new bond price, and what would it do to the index" — use ncsx_ruler, which recomputes the whole chain on every call. ' +
    'SpreadBench does not issue credit ratings or investment advice.',
};

function retiredLevels(tier) {
  return {
    status: 'retired',
    data_status: 'retired_seed',
    retired_on: '2026-11-06',
    requested_tier: tier || null,
    was: '90 个交易日的日频指数水位序列（composite / hy / ig）',
    why: '该序列来自 v0.1.1 的演示数据（数值为造数），2026-11-04 起 NCSX 改为发行利差口径：事件驱动、无日频序列、无 composite/hy/ig 三档。',
    replacement: { tool: 'ncsx_latest', http: '/api/v1/real/index.json', levels: ['NCSX-IS', 'secured', 'unsecured'] },
    note_en: 'The daily series was a withdrawn demo. NCSX is now an issuance spread with secured / unsecured sub-indices and no daily frequency. Use ncsx_latest.',
  };
}

function notFound(rel, extra) {
  return Object.assign({
    status: 'not_available',
    data_status: 'retired_seed',
    requested: rel,
    note_zh: '该路径在 2026-11-06 的 v0.2.0-real 迁移中已下线（原先返回的是演示造数）。',
    note_en: 'This path was withdrawn in the v0.2.0-real migration; it previously returned demo data.',
    replacement: { tool: 'ncsx_latest', http: '/api/v1/real/index.json' },
  }, extra || {});
}

/* ---- 定价尺纯算术（与 assets/js/pg/ruler-1.js 的 NCSXRulerMath 逐行同义）----
 * 两份实现的唯一差别是注释语言：页面用 var/ES5，服务端用 const/箭头函数。
 * 页面那份有 17/17 单测（_g37_ruler_test.js），服务端这份有 _g38_ruler_tool_test.js。 */
function rulerTenorKeys(tenors) {
  const ks = [];
  for (const k of Object.keys(tenors)) {
    const n = Number(k);
    if (isFinite(n) && typeof tenors[k] === 'number') ks.push(n);
  }
  ks.sort((x, y) => x - y);
  return ks;
}

function rulerInterp(tenors, t) {
  const ks = rulerTenorKeys(tenors);
  if (!ks.length) return { ok: false, reason: 'empty' };
  const lo0 = ks[0], hi0 = ks[ks.length - 1];
  if (!isFinite(t)) return { ok: false, reason: 'nan' };
  if (t < lo0 - 1e-9) return { ok: false, reason: 'below', min: lo0, max: hi0 };
  if (t > hi0 + 1e-9) return { ok: false, reason: 'above', min: lo0, max: hi0 };
  for (let i = 0; i < ks.length; i++) {
    if (Math.abs(t - ks[i]) < 1e-9) {
      return { ok: true, rate: tenors[ks[i]], exact: ks[i], lo: ks[i], hi: ks[i], w: 0 };
    }
    if (t < ks[i]) {
      const lo = ks[i - 1], hi = ks[i];
      const w = (t - lo) / (hi - lo);
      const r0 = tenors[lo], r1 = tenors[hi];
      return { ok: true, rate: r0 + (r1 - r0) * w, lo, hi, w, r0, r1 };
    }
  }
  return { ok: false, reason: 'empty' };
}

/* readJson(relPath) 由调用方注入：stdio 版走 http fetch，http 版走本地文件。 */
async function callTool(name, args, readJson) {
  const t = BY_NAME[name];
  if (!t) throw new Error('Unknown tool: ' + name);
  const a = args || {};

  if (t.resolve === 'retired_levels') return retiredLevels(a.tier);

  /* ncsx_latest（2026-11-06 修正）：原实现直读 /api/v1/latest.json，而该文件长期装着
   * v0.1.1 演示载荷（NCSX-Composite 778bp）并自带 data_status: real_issuance ——
   * agent 会把 778bp 当成真实水位引用。改为从 real/index.json 现取，且显式标注
   * chg_1d_bp: null 的语义（事件驱动不是缺数据）。 */
  if (t.resolve === 'latest_real') {
    const d = await readJson('/api/v1/real/index.json');
    return {
      status: 'ok',
      ticker: d.ticker,
      name: d.name,
      as_of: d.as_of,
      spread_bp: d.spread_bp,
      secured_spread_bp: d.secured_spread_bp,
      unsecured_spread_bp: d.unsecured_spread_bp,
      constituents: d.constituents,
      issuers: d.issuers,
      notional_mm: d.notional_mm,
      methodology: d.methodology,
      doi: d.doi,
      data_status: d.data_status,
      cadence: 'event_driven',
      chg_1d_bp: null,
      chg_1d_note: 'Issuance spread is fixed at pricing — there is no daily change. null means "not applicable", not "missing data".',
      limits: d.limits,
      canonical: 'https://spreadbench.com/api/v1/real/index.json',
      human: 'https://spreadbench.com/',
    };
  }

  if (t.resolve === 'retired_attribution') {
    return {
      status: 'retired',
      data_status: 'retired_seed',
      retired_on: '2026-11-06',
      was: '逐日归因：各券对指数日变动的贡献分解',
      why: '发行利差是发行时点的定量值，没有日变动，因此不存在「日归因」；旧载荷为 v0.1.1 演示序列。',
      replacement: { tool: 'ncsx_index', http: '/api/v1/real/index.json', facts: '/api/v1/real/facts.json' },
      note_en: 'An issuance spread is a point-in-time value: no daily move, so there is nothing to attribute. Use ncsx_index or ncsx_facts.',
    };
  }

  if (t.resolve === 'retired_weekly') {
    return {
      status: 'retired',
      data_status: 'retired_seed',
      retired_on: '2026-11-06',
      was: '结构化周报快照（旧载荷含演示造数）',
      why: '旧载荷含演示数字，已停更；人可读周报与 RSS 仍是当前来源。',
      replacement: {
        tool: 'ncsx_stories', feed: 'https://spreadbench.com/feed.xml',
        page: 'https://spreadbench.com/weekly.html',
      },
      note_en: 'The structured weekly snapshot carried demo figures and is discontinued. The human-readable feed remains the source.',
    };
  }

  /* ncsx_facts（2026-11-06 v0.2.6）：可引用事实层。
   * 16 条数字全部由 facts_gen.py 从原始端点现算并写入 calc 字段，
   * 这里只做读取 + id/q 过滤，不在 MCP 侧二次计算——单一事实源在 facts.json。 */
  if (t.resolve === 'facts') {
    const rel = '/api/v1/real/facts.json';
    let data;
    try {
      data = await readJson(rel);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/ENOENT|HTTP 404|not found/i.test(msg)) return notFound(rel);
      throw e;
    }
    const all = Array.isArray(data.facts) ? data.facts : [];
    const available = all.map((f) => f.id);
    let rows = all;

    if (a.id !== undefined && a.id !== null && String(a.id).trim() !== '') {
      if (typeof a.id !== 'string') {
        return { status: 'invalid_input', hint: 'id must be a comma-separated string of fact ids', available_ids: available };
      }
      const want = String(a.id).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
      const hit = rows.filter((f) => want.includes(f.id));
      if (!hit.length) {
        return {
          status: 'not_found', requested_ids: want, available_ids: available,
          note: 'No fact matched. Pass no filter to get all of them.',
        };
      }
      rows = hit;
    }

    if (a.q !== undefined && a.q !== null && String(a.q).trim() !== '') {
      if (typeof a.q !== 'string') {
        return { status: 'invalid_input', hint: 'q must be a string, e.g. "coreweave"' };
      }
      const q = String(a.q).trim().toLowerCase().slice(0, 60);
      rows = rows.filter((f) => (f.id + ' ' + f.label_zh + ' ' + f.label_en).toLowerCase().includes(q));
      if (!rows.length) {
        return { status: 'not_found', query: q, available_ids: available, note: 'No fact matched that keyword.' };
      }
    }

    return {
      status: 'ok',
      ticker: data.ticker,
      as_of: data.as_of,
      methodology: data.methodology,
      doi: data.doi,
      generated_at: data.generated_at,
      cross_check: data.xcheck,
      returned: rows.length,
      total_available: all.length,
      available_ids: available,
      definitions: data.definitions,
      facts: rows,
      limits: data.limits,
      note: 'Every fact ships its own calc string and source URL so you can restate how it was derived. Facts only — no rating, no forecast, no investment advice.',
    };
  }

  /* ncsx_events（2026-11-06 v0.2.7）：指数事件史。
   * 13 次定价回放（水位 + 逐券 pull 归因）由 events_gen.py 生成并自带交叉校验，
   * 这里只做读取 + 时间/发行人过滤 + 窗口净变化，不在 MCP 侧重算归因。 */
  if (t.resolve === 'events') {
    const rel = '/api/v1/real/events.json';
    let data;
    try {
      data = await readJson(rel);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/ENOENT|HTTP 404|not found/i.test(msg)) return notFound(rel);
      throw e;
    }
    const series = Array.isArray(data.series) ? data.series : [];
    const allTickers = [];
    const allYears = [];
    for (const ev of series) {
      const y = String(ev.date).slice(0, 4);
      if (!allYears.includes(y)) allYears.push(y);
      for (const b of ev.added || []) {
        if (b && b.ticker && !allTickers.includes(b.ticker)) allTickers.push(b.ticker);
      }
    }

    let since = null;
    if (a.since !== undefined && a.since !== null && String(a.since).trim() !== '') {
      if (typeof a.since !== 'string' || !/^\d{4}(-\d{2}){0,2}$/.test(a.since.trim())) {
        return { status: 'invalid_input', hint: 'since must look like "2026", "2026-02" or "2026-02-05"', available_years: allYears };
      }
      since = a.since.trim();
    }

    let tk = null;
    if (a.ticker !== undefined && a.ticker !== null && String(a.ticker).trim() !== '') {
      if (typeof a.ticker !== 'string') {
        return { status: 'invalid_input', hint: 'ticker must be a string, e.g. "CRWV"', available_tickers: allTickers };
      }
      tk = a.ticker.trim().toUpperCase();
      if (!allTickers.includes(tk)) {
        return { status: 'not_found', requested_ticker: tk, available_tickers: allTickers, note: 'No pricing event added a bond of that ticker. Pass no filter for the full history.' };
      }
    }

    let keep = series.map((ev, i) => i);
    if (since) keep = keep.filter((i) => String(series[i].date).slice(0, since.length) >= since);
    if (tk) keep = keep.filter((i) => (series[i].added || []).some((b) => String(b.ticker).toUpperCase() === tk));
    if (!keep.length) {
      return {
        status: 'not_found', since, ticker: tk,
        available_years: allYears, available_tickers: allTickers,
        note: 'No event matched that filter. Widen since or drop the ticker filter.',
      };
    }

    const firstIdx = keep[0];
    const lastIdx = keep[keep.length - 1];
    const levelBefore = firstIdx > 0 ? series[firstIdx - 1].level_bp : null;
    const levelEnd = series[lastIdx].level_bp;
    const winChange = levelBefore === null ? null : Math.round((levelEnd - levelBefore) * 10) / 10;

    const rows = keep.map((i) => {
      const ev = series[i];
      const added = (ev.added || []).filter((b) => !tk || String(b.ticker).toUpperCase() === tk);
      return {
        date: ev.date,
        level_bp: ev.level_bp,
        delta_bp: ev.delta_bp,
        bond_count: ev.bond_count,
        notional_added_mm: ev.notional_mm,
        added,
      };
    });

    let tickerPull = null;
    if (tk) {
      let sum = 0, n = 0, nEvents = 0;
      for (const ev of series) {
        const mine = (ev.added || []).filter((b) => String(b.ticker).toUpperCase() === tk);
        if (mine.length) nEvents += 1;
        for (const b of mine) {
          if (typeof b.pull_bp === 'number') { sum += b.pull_bp; n += 1; }
        }
      }
      tickerPull = {
        ticker: tk,
        pricing_events: nEvents,
        events_with_pull: n,
        cumulative_pull_bp: Math.round(sum * 10) / 10,
        note: 'Sum of this issuer\'s per-event pull over the full history = how much its pricing events moved the index relative to inception. The very first bond in the index has no pre-add level, so its pull is null and does not enter the sum; that is why events_with_pull can be pricing_events - 1.',
      };
    }

    return {
      status: 'ok',
      ticker: data.ticker,
      as_of: data.as_of,
      last_event_date: data.last_event_date,
      methodology: data.methodology,
      doi: data.doi,
      generated_at: data.generated_at,
      total_events: series.length,
      returned_events: rows.length,
      window: Object.assign(
        { since: since || series[0].date, until: series[lastIdx].date, level_before_bp: levelBefore, level_end_bp: levelEnd, net_change_bp: winChange },
        levelBefore === null
          ? { note: 'This window starts at index inception, so there is no prior level to measure a change from: level_end_bp is the level itself, and net_change_bp is null because nothing preceded it. Use index_span.net_change_bp for the full-history change.' }
          : {}),
      index_span: {
        first_event: data.first_event,
        peak: data.peak,
        trough: data.trough,
        net_change_bp: data.net_change_bp,
        span_days: data.span_days,
        up_events: data.up_events,
        down_events: data.down_events,
      },
      ticker_contribution: tickerPull,
      cross_check: data.xcheck,
      available_years: allYears,
      available_tickers: allTickers,
      events: rows,
      definitions: data.definitions,
      limits: data.limits,
      page_zh: 'https://spreadbench.com/events.html',
      page_en: 'https://spreadbench.com/en/events.html',
      json: 'https://spreadbench.com/api/v1/real/events.json',
      note: 'event delta_bp and level_bp always describe the whole NCSX-IS index; when a ticker filter is set, added[] is narrowed to that issuer but delta_bp is still the full-index move. Pull attribution sums to the event delta. Event-driven and point-in-time — never describe these as daily closes. Facts only — no rating, no forecast, no investment advice.',
    };
  }

  /* ncsx_ruler（2026-11-06 v0.2.8）：把定价尺的反问交给 agent 面。
   * 与 /ruler.html 同一套算术（assets/js/pg/ruler-1.js 的 interp / spreadBp / indexAfter），
   * 这里在服务端重写一遍纯函数——两边都不写死任何数字，所以不产生新的事实源，也永远不会过期。
   * 与 events.json 的 pull_bp 是同一个公式：indexAfter() 出来的 delta 就是「加进去之后被拉了多少」。 */
  if (t.resolve === 'ruler') {
    const curve = await readJson('/api/v1/real/curve.json');
    const uni = await readJson('/api/v1/real/universe.json');
    const idx = await readJson('/api/v1/real/index.json');

    const fmtT = (y) => (y < 1 ? Math.round(y * 12) + 'M' : (Math.round(y * 100) / 100) + 'Y');
    const r1 = (v) => Math.round(v * 10) / 10;
    const r2 = (v) => Math.round(v * 100) / 100;
    const exampleArgs = { coupon_pct: 7.5, tenor_years: 5, size_mm: 1000, seniority: 'secured' };

    const coupon = Number(a.coupon_pct);
    if (!isFinite(coupon) || coupon < 0 || coupon > 25) {
      return {
        status: 'invalid_input', field: 'coupon_pct', got: a.coupon_pct === undefined ? null : a.coupon_pct,
        why: 'Coupon must be a number between 0 and 25, in percent (7.5 means 7.5%, not 750bp).',
        example: exampleArgs,
      };
    }
    const tenor = Number(a.tenor_years);
    if (!isFinite(tenor) || tenor <= 0) {
      return {
        status: 'invalid_input', field: 'tenor_years', got: a.tenor_years === undefined ? null : a.tenor_years,
        why: 'Tenor must be a positive number of years (0.5 = 6 months, 5 = 5 years, 5.5 = 5.5 years).',
        example: exampleArgs,
      };
    }
    let size = 0;
    if (a.size_mm !== undefined && a.size_mm !== null && String(a.size_mm).trim() !== '') {
      size = Number(a.size_mm);
      if (!isFinite(size) || size < 0) {
        return {
          status: 'invalid_input', field: 'size_mm', got: a.size_mm,
          why: 'size_mm is the new-issue size in $ millions and must be zero or positive. Omit it to skip the index-impact calculation.',
          example: exampleArgs,
        };
      }
    }
    const senRaw = String(a.seniority === undefined || a.seniority === null ? 'secured' : a.seniority).toLowerCase();
    if (!/sec/.test(senRaw)) {
      return {
        status: 'invalid_input', field: 'seniority', got: a.seniority,
        why: 'seniority must be "secured" or "unsecured" (default "secured"). It selects which sub-index the comparison uses.',
        enum: ['secured', 'unsecured'], example: exampleArgs,
      };
    }
    const unsecured = /unsec/.test(senRaw);

    const tenors = curve.tenors || {};
    const ks = rulerTenorKeys(tenors);
    if (!ks.length) {
      return {
        status: 'not_available', data_status: curve.data_status || null,
        why: 'curve.json carries no usable tenor points, so no Treasury leg can be matched.',
        alternative: { tool: 'ncsx_curve', http: '/api/v1/real/curve.json' },
      };
    }

    const it = rulerInterp(tenors, tenor);
    if (!it.ok) {
      if (it.reason === 'above' || it.reason === 'below') {
        const near = it.reason === 'below' ? ks[0] : ks[ks.length - 1];
        return {
          status: 'out_of_range',
          field: 'tenor_years',
          requested_tenor_years: tenor,
          curve_range: {
            min_years: ks[0], max_years: ks[ks.length - 1],
            min_label: fmtT(ks[0]), max_label: fmtT(ks[ks.length - 1]),
            as_of: curve.as_of, tenors: ks,
          },
          why: 'We interpolate linearly between the two adjacent tenors on the published curve and never extrapolate. A Treasury yield outside 1M-30Y would be an invented number, and we do not invent numbers.',
          nearest_supported: { years: near, label: fmtT(near) },
          alternative: 'Pick a tenor inside the curve range, or read the curve itself with ncsx_curve.',
        };
      }
      return {
        status: 'not_available',
        why: 'The published curve tenors are not usable numbers.',
        curve_range: { tenors: ks, as_of: curve.as_of },
        alternative: { tool: 'ncsx_curve', http: '/api/v1/real/curve.json' },
      };
    }

    const spreadExact = (coupon - it.rate) * 100;
    const levelBp = idx.spread_bp;
    const diffIndex = spreadExact - levelBp;
    const tierLabel = unsecured ? 'senior unsecured' : 'senior secured';
    const tierLevel = unsecured ? idx.unsecured_spread_bp : idx.secured_spread_bp;
    const diffTier = spreadExact - tierLevel;

    const bonds = Array.isArray(uni.bonds) ? uni.bonds : [];
    const EPS = 0.05;   /* 半个 0.1bp：显示精度内的并列算并列，不硬造名次差 */
    const tighter = bonds.filter((b) => b.issue_spread_bp < spreadExact - EPS).length;
    const wider = bonds.filter((b) => b.issue_spread_bp > spreadExact + EPS).length;
    const identical = bonds.length - tighter - wider;
    const rank = tighter + 1;

    const tierBonds = bonds.filter((b) => b.sen === tierLabel);
    const tierNotional = tierBonds.reduce((s, b) => s + b.size_mm, 0);
    const tierRecomputed = tierNotional > 0
      ? tierBonds.reduce((s, b) => s + b.size_mm * b.issue_spread_bp, 0) / tierNotional
      : null;

    let impact = null;
    if (size > 0 && idx.notional_mm > 0) {
      const total = idx.notional_mm + size;
      const after = (idx.notional_mm * levelBp + size * spreadExact) / total;
      impact = {
        size_mm: size,
        weight_pct: r2(size / total * 100),
        level_before_bp: levelBp,
        level_after_bp: r1(after),
        delta_bp: r1(after - levelBp),
        notional_after_mm: total,
        formula: '(' + idx.notional_mm + ' x ' + levelBp.toFixed(1) + ' + ' + size + ' x ' + r2(spreadExact) + ') / ' + total,
      };
    }

    const ladder = bonds.map((b) => ({
      ticker: b.ticker, issuer: b.issuer, coupon_pct: b.coupon, maturity: b.maturity,
      spread_bp: b.issue_spread_bp, seniority: b.sen, is_new: false,
    })).concat([{
      ticker: 'NEW', issuer: null, coupon_pct: coupon, maturity: null,
      spread_bp: r1(spreadExact), seniority: tierLabel, is_new: true,
    }]).sort((x, y) => x.spread_bp - y.spread_bp || (x.is_new ? 1 : -1));

    /* 发行人历史定价（2026-11-06 v0.2.9）：同一个名字上次发的是什么价——
     * 承销员核对一只新券的第一件事。匹配规则与 ncsx_bond 一致（issuer/ticker 不区分大小写子串）。 */
    let issuerHistory = null;
    if (a.issuer !== undefined && a.issuer !== null && String(a.issuer).trim() !== '') {
      const q = String(a.issuer).toLowerCase();
      const hits = bonds.filter((b) =>
        String(b.issuer || '').toLowerCase().includes(q) || String(b.ticker || '').toLowerCase().includes(q));
      const allIssuers = Array.from(new Set(bonds.map((b) => b.issuer)));
      if (!hits.length) {
        issuerHistory = {
          matched: false,
          requested: a.issuer,
          available_issuers: allIssuers,
          note: 'No constituent matches this name, so there is no pricing history to compare against. The new bond is still measured against the index and the 13 constituents.',
        };
      } else {
        const matchedIssuers = Array.from(new Set(hits.map((b) => b.issuer)));
        const histNotional = hits.reduce((s, b) => s + b.size_mm, 0);
        issuerHistory = {
          matched: true,
          issuer: matchedIssuers.length === 1 ? matchedIssuers[0] : null,
          issuers: matchedIssuers,
          bonds: hits.map((b) => ({
            ticker: b.ticker, coupon_pct: b.coupon, maturity: b.maturity, tenor_years: b.tenor_years,
            size_mm: b.size_mm, seniority: b.sen, priced: b.pricing,
            spread_bp: b.issue_spread_bp, delta_vs_new_bp: r1(b.issue_spread_bp - spreadExact),
          })),
          weighted_spread_bp: matchedIssuers.length === 1 ? r1(hits.reduce((s, b) => s + b.size_mm * b.issue_spread_bp, 0) / histNotional) : null,
          note: matchedIssuers.length === 1
            ? 'Spreads are point-in-time at each bond\'s own pricing date, measured against the Treasury curve of that date — not today\'s curve. delta_vs_new_bp compares the hypothetical new bond (today\'s curve) with each existing bond\'s pricing spread.'
            : 'The keyword matched more than one issuer, so no single weighted level is shown; read the per-bond rows instead.',
        };
      }
    }

    /* 指数水位自洽核对：13 券面值加权应等于发布值（derived_check 第 ⑥ 类同一口径） */
    const idxNotional = bonds.reduce((s, b) => s + b.size_mm, 0);
    const idxRecomputed = idxNotional > 0
      ? bonds.reduce((s, b) => s + b.size_mm * b.issue_spread_bp, 0) / idxNotional
      : null;

    const arithmetic = [
      'Treasury   UST(' + tenor + 'y) = ' + it.rate.toFixed(3) + '%' +
        (it.exact !== undefined
          ? ' (exact curve tenor)'
          : ' (interpolated ' + Math.round(it.w * 100) + '% of the way from ' + fmtT(it.lo) + ' ' + it.r0.toFixed(3) + '% to ' + fmtT(it.hi) + ' ' + it.r1.toFixed(3) + '%)'),
      'Spread     (' + coupon + '% - ' + it.rate.toFixed(3) + '%) x 100 = ' + r2(spreadExact) + ' bp',
      'vs index   ' + r2(spreadExact) + ' - ' + levelBp.toFixed(1) + ' = ' + (diffIndex >= 0 ? '+' : '') + r1(diffIndex) + ' bp',
      'vs tier    ' + r2(spreadExact) + ' - ' + tierLevel.toFixed(1) + ' (' + tierLabel + ') = ' + (diffTier >= 0 ? '+' : '') + r1(diffTier) + ' bp',
    ];
    if (impact) {
      arithmetic.push('New level  ' + impact.formula + ' = ' + impact.level_after_bp.toFixed(1) + ' bp');
    }

    return {
      status: 'ok',
      ticker: NCSX_IS,
      inputs: {
        coupon_pct: coupon,
        tenor_years: tenor,
        size_mm: size,
        seniority: unsecured ? 'unsecured' : 'secured',
      },
      treasury: {
        as_of: curve.as_of,
        rate_pct: Math.round(it.rate * 10000) / 10000,
        exact_tenor_years: it.exact === undefined ? null : it.exact,
        interpolation: it.exact !== undefined
          ? { method: 'exact_tenor' }
          : { method: 'linear_between_adjacent_tenors', lower: { years: it.lo, label: fmtT(it.lo), rate_pct: it.r0 }, upper: { years: it.hi, label: fmtT(it.hi), rate_pct: it.r1 }, weight: Math.round(it.w * 10000) / 10000 },
        method_note: 'Linear between the two adjacent published tenors; above 30Y or below 1M this tool refuses instead of extrapolating.',
      },
      issue_spread_bp: r1(spreadExact),
      issue_spread_bp_precise: Math.round(spreadExact * 10000) / 10000,
      vs_index: {
        level_bp: levelBp,
        diff_bp: r1(diffIndex),
        relation: diffIndex > EPS ? 'wider' : (diffIndex < -EPS ? 'tighter' : 'in_line'),
        as_of: idx.as_of,
      },
      vs_structure_tier: {
        tier: tierLabel,
        level_bp: tierLevel,
        diff_bp: r1(diffTier),
        relation: diffTier > EPS ? 'wider' : (diffTier < -EPS ? 'tighter' : 'in_line'),
        constituents: tierBonds.length,
        notional_mm: tierNotional,
        recomputed_weighted_bp: tierRecomputed === null ? null : r1(tierRecomputed),
        note: 'Sub-index level is face-value weighted across the bonds of this structure only.',
      },
      rank: {
        position: rank,
        of: bonds.length,
        tighter_count: tighter,
        wider_count: wider,
        identical_count: identical,
        basis: 'sorted by issuance spread, tightest first, against the ' + bonds.length + ' existing constituents (the new bond is not ranked against itself)',
        ties_note: identical > 0
          ? identical + ' existing constituent(s) sit within 0.05bp of this spread and are counted as tied, not as wider.'
          : 'No existing constituent sits within 0.05bp of this spread.',
      },
      index_impact: impact,
      issuer_history: issuerHistory,
      index_impact_note: impact
        ? 'Same face-value weighting as the index itself, and the same arithmetic as the pull_bp attribution in ncsx_events: a positive delta_bp means this bond would pull the index wider.'
        : 'No size passed (or size 0), so the index-impact calculation was skipped. Pass size_mm to see the new level.',
      ladder,
      arithmetic,
      consistency: {
        published_index_bp: levelBp,
        recomputed_from_constituents_bp: idxRecomputed === null ? null : r1(idxRecomputed),
        passed: idxRecomputed !== null && Math.abs(idxRecomputed - levelBp) <= 0.05,
        note: 'Recomputed from universe.json (face-value weighted) to confirm the published level still matches its own constituents.',
      },
      data_status: idx.data_status,
      methodology: idx.methodology,
      doi: idx.doi,
      curve_as_of: curve.as_of,
      index_as_of: idx.as_of,
      page_zh: 'https://spreadbench.com/ruler.html',
      page_en: 'https://spreadbench.com/en/ruler.html',
      json_inputs: {
        curve: 'https://spreadbench.com/api/v1/real/curve.json',
        universe: 'https://spreadbench.com/api/v1/real/universe.json',
        index: 'https://spreadbench.com/api/v1/real/index.json',
      },
      note: 'Computed on every call from the current published curve, universe and index — no numbers are stored on this server side of the ruler, so it cannot go stale. The Treasury leg is the latest published curve (as_of above), not an intraday quote: NCSX-IS is event-driven. Facts and arithmetic only — this is not a coupon recommendation, not a rating, and not investment advice.',
    };
  }

  if (t.resolve === 'filings') {
    /* ncsx_filings：整体读取 + 可选 issuer/form 过滤（服务器端过滤，响应不带全量数组） */
    const rel = '/api/v1/real/filings.json';
    let data;
    try {
      data = await readJson(rel);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/ENOENT|HTTP 404|not found/i.test(msg)) return notFound(rel);
      throw e;
    }
    let issuer = null, form = null;
    if (typeof a.issuer === 'string' && a.issuer.trim()) issuer = a.issuer.trim().slice(0, 60);
    else if (a.issuer !== undefined && a.issuer !== null) {
      return { status: 'invalid_input', hint: 'issuer must be a string, e.g. "CoreWeave" or "WULF"' };
    }
    if (typeof a.form === 'string' && a.form.trim()) form = a.form.trim().slice(0, 20);
    else if (a.form !== undefined && a.form !== null) {
      return { status: 'invalid_input', hint: 'form must be a string, e.g. "8-K"' };
    }
    let rows = data.filings || [];
    if (issuer) {
      const q = issuer.toLowerCase();
      rows = rows.filter((f) => (f.issuer || '').toLowerCase().includes(q) || (f.ticker || '').toLowerCase() === q);
    }
    if (form) rows = rows.filter((f) => f.form === form);
    return {
      status: 'ok',
      as_of: data.as_of,
      window_days: data.window_days,
      filters: { issuer: issuer, form: form },
      counts: {
        returned: rows.length,
        pricing_signals: rows.filter((f) => f.pricing_signal).length,
        total_in_window: (data.counts || {}).total,
      },
      issuers: data.issuers,
      filings: rows,
      note: 'Pricing-chain forms (FWP / 424B* / S-3* / F-10) carry pricing_signal=true. 8-Ks are not pre-judged by Item. Aggregate of public EDGAR data only — not a credit rating, not investment advice.',
    };
  }

  if (t.resolve === 'bond') {
    const raw = a.q;
    /* 入参校验（2026-11-05 红队 RT-11）：q 只接受字符串，长度上限 120。
     * 原实现直接 String() 一个对象会把它原样回显，且 200KB 的 q 会被 1:1 放大回响应（RT-10）。 */
    if (raw !== undefined && raw !== null && typeof raw !== 'string') {
      return {
        status: 'bad_argument',
        note_zh: 'q 必须是字符串（发行人名称 / 代码 / 备注关键词），不能是对象或数组。',
        note_en: 'q must be a string (issuer, ticker or note keyword).',
        example: { q: 'CoreWeave' },
      };
    }
    const rawQ = String(raw || '').trim().slice(0, 120);
    const q = rawQ.toLowerCase();
    /* 老客户端仍会传 cusip：明确告诉它为什么查不到，而不是丢一个空结果 */
    if (!q) {
      return {
        status: 'need_query',
        note_zh: '请用 q 传发行人名称 / 代码 / 备注关键词。成分券没有 CUSIP，按 CUSIP 查不到。',
        note_en: 'Pass q (issuer, ticker or note keyword). Constituents carry no CUSIP.',
        example: { q: 'CoreWeave' },
      };
    }
    const uni = await readJson('/api/v1/real/universe.json');
    const hits = (uni.bonds || []).filter((b) => {
      const hay = [b.issuer, b.ticker, b.note, b.sen].join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    if (!hits.length) {
      return {
        status: 'not_found',
        query: rawQ,
        available: (uni.bonds || []).map((b) => ({ issuer: b.issuer, ticker: b.ticker, coupon: b.coupon, maturity: b.maturity })),
        note_zh: '没有匹配的成分券。上面列出全部可用标的，可改用发行人名称或代码重试。',
      };
    }
    return {
      status: 'ok',
      query: rawQ,
      as_of: uni.as_of,
      data_status: uni.data_status,
      methodology: uni.methodology,
      matches: hits,
      note_zh: 'issue_spread_bp = 票息 − 定价日同期限国债插值（百分点）× 100；tenor_years 为定价日到到期日的年数。',
    };
  }

  /* ncsx_wall：到期墙聚合（面值按年 × 担保结构 + 峰值年明细），由 universe.json 现算 */
  if (t.resolve === 'wall') {
    const uni = await readJson('/api/v1/real/universe.json');
    const bonds = uni.bonds || [];
    /* year 钻取入参（2026-11-06 v0.2.6）：只接受 4 位年份，其他一律结构化拒绝，
     * 不做模糊匹配——agent 传 "2030年" 时应该拿到明确提示而不是空结果。 */
    let wantYear = null;
    if (a.year !== undefined && a.year !== null && String(a.year).trim() !== '') {
      const yy = String(a.year).trim();
      if (!/^(19|20)\d{2}$/.test(yy)) {
        return { status: 'invalid_input', hint: 'year must be a 4-digit year, e.g. 2030', example: { year: '2030' } };
      }
      wantYear = yy;
    }
    const byYear = {};
    let total = 0;
    for (const b of bonds) {
      const y = String(b.maturity).slice(0, 4);
      const e = byYear[y] = byYear[y] || { year: y, face_value_mm: 0, secured_mm: 0, unsecured_mm: 0, bonds: 0 };
      e.face_value_mm += b.size_mm;
      e.bonds += 1;
      if (b.sen === 'senior secured') e.secured_mm += b.size_mm; else e.unsecured_mm += b.size_mm;
      total += b.size_mm;
    }
    const years = Object.keys(byYear).sort().map((y) => {
      const e = byYear[y];
      e.share_of_index_pct = Math.round(e.face_value_mm / total * 1000) / 10;
      return e;
    });
    const peak = years.reduce((m, e) => (e.face_value_mm > m.face_value_mm ? e : m), years[0]);
    const bondRow = (b) => ({
      issuer: b.issuer, ticker: b.ticker, coupon_pct: b.coupon, maturity: b.maturity,
      size_mm: b.size_mm, structure: b.sen, issue_spread_bp: b.issue_spread_bp, priced: b.pricing,
      sec_filing: b.src,
    });
    const bondsOf = (y) => bonds
      .filter((b) => String(b.maturity).startsWith(y))
      .sort((x, y2) => y2.size_mm - x.size_mm)
      .map(bondRow);
    const peakBonds = bondsOf(peak.year);

    if (wantYear) {
      const e = byYear[wantYear];
      if (!e) {
        return {
          status: 'ok', as_of: uni.as_of, requested_year: wantYear,
          years_available: Object.keys(byYear).sort(),
          note: 'No NCSX-IS bond matures in ' + wantYear + '.',
        };
      }
      return {
        status: 'ok',
        as_of: uni.as_of,
        data_status: uni.data_status,
        requested_year: wantYear,
        year: {
          year: e.year, face_value_mm: e.face_value_mm, share_of_index_pct: e.share_of_index_pct,
          bond_count: e.bonds, secured_mm: e.secured_mm, unsecured_mm: e.unsecured_mm,
        },
        total_face_value_mm: total,
        bonds: bondsOf(wantYear),
        human_tools: 'https://spreadbench.com/maturity.html',
        story_page: wantYear === '2031' ? 'https://spreadbench.com/story-wall2031.html'
          : (wantYear === '2030' ? 'https://spreadbench.com/story-wall2030.html' : null),
        note: 'Face values, coupons and maturity dates are facts from SEC filings. Facts only — no refinancing judgement, no rating, not investment advice.',
      };
    }

    return {
      status: 'ok',
      as_of: uni.as_of,
      data_status: uni.data_status,
      total_face_value_mm: total,
      years: years,
      peak_year: {
        year: peak.year,
        face_value_mm: peak.face_value_mm,
        share_of_index_pct: peak.share_of_index_pct,
        bond_count: peak.bonds,
        bonds: peakBonds,
      },
      human_tools: 'https://spreadbench.com/maturity.html',
      story_page: 'https://spreadbench.com/story-wall2031.html',
      note: 'Face values, coupons and maturity dates are facts from SEC filings. Facts only — no refinancing judgement, no rating, not investment advice.',
    };
  }

  /* ncsx_stories：可引用故事卡（数据现算：universe 求墙、universe×marks 求 Δ），带双语页与分享卡 URL */
  if (t.resolve === 'stories') {
    const uni = await readJson('/api/v1/real/universe.json');
    const bonds = uni.bonds || [];
    const byYear = {};
    let total = 0;
    for (const b of bonds) {
      const y = String(b.maturity).slice(0, 4);
      const e = byYear[y] = byYear[y] || { face_value_mm: 0, bonds: 0 };
      e.face_value_mm += b.size_mm;
      e.bonds += 1;
      total += b.size_mm;
    }
    const peakYear = Object.keys(byYear).sort((a, b) => byYear[b].face_value_mm - byYear[a].face_value_mm)[0];
    const peak = byYear[peakYear];
    const peakList = bonds.filter((b) => String(b.maturity).startsWith(peakYear));
    const peak2026 = peakList.filter((b) => String(b.pricing).startsWith('2026'));

    const stories = [
      {
        id: 'maturity-wall',
        headline_en: 'THE ' + peakYear + ' WALL: $' + (peak.face_value_mm / 1000).toFixed(1) + 'B of AI-infrastructure bonds mature in ' + peakYear + ' — ' +
          Math.round(peak.face_value_mm / total * 1000) / 10 + '% of the index',
        key_numbers: {
          peak_year: peakYear,
          face_value_mm: peak.face_value_mm,
          share_of_index_pct: Math.round(peak.face_value_mm / total * 1000) / 10,
          bonds: peak.bonds,
          priced_in_2026: peak2026.length,
          priced_in_2026_mm: peak2026.reduce((s, b) => s + b.size_mm, 0),
        },
        why_it_matters_en: 'The concentration was built inside one issuance window, not accumulated over years — the refinancing dates of a whole cohort collide in a single year.',
        url_zh: 'https://spreadbench.com/story-wall2031.html',
        url_en: 'https://spreadbench.com/en/story-wall2031.html',
        share_card_1200x630: 'https://spreadbench.com/assets/img/story-wall2031.png',
      },
    ];

    let marks = null;
    try { marks = await readJson('/api/v1/real/marks.json'); } catch (e) { marks = null; }
    if (marks && Array.isArray(marks.marks) && marks.marks.length) {
      const mk = {};
      for (const m of marks.marks) mk[m.ticker + '|' + m.coupon + '|' + m.maturity] = m;
      const rows = [];
      for (const b of bonds) {
        const m = mk[b.ticker + '|' + b.coupon + '|' + b.maturity];
        if (m) rows.push({ ticker: b.ticker, issuer: b.issuer, coupon_pct: b.coupon, maturity: b.maturity, size_mm: b.size_mm, issue_spread_bp: b.issue_spread_bp, implied_spread_bp: m.spread_bp, delta_bp: Math.round((m.spread_bp - b.issue_spread_bp) * 10) / 10, funds_reporting: m.funds, median_price_pct: m.price_pct });
      }
      if (rows.length) {
        const byTick = {};
        for (const r of rows) {
          const e = byTick[r.ticker] = byTick[r.ticker] || { ticker: r.ticker, issuer: r.issuer, s: 0, n: 0, rows: [] };
          e.s += r.size_mm * r.delta_bp; e.n += r.size_mm; e.rows.push(r);
        }
        const ticks = Object.values(byTick).map((e) => ({ ticker: e.ticker, issuer: e.issuer, weighted_delta_bp: Math.round(e.s / e.n * 10) / 10, bonds: e.rows.length }));
        ticks.sort((a, b) => b.weighted_delta_bp - a.weighted_delta_bp);
        stories.push({
          id: 'repricing',
          headline_en: 'REPRICED IN ONE QUARTER: ' + ticks[0].issuer + ' bonds widened ' +
            Math.round(Math.min.apply(null, rows.filter((r) => r.ticker === ticks[0].ticker).map((r) => r.delta_bp))) + '-' +
            Math.round(Math.max.apply(null, rows.filter((r) => r.ticker === ticks[0].ticker).map((r) => r.delta_bp))) + 'bp between issuance and the ' + marks.latest_period + ' fund marks, while sector peers moved ' +
            ticks.slice(1).map((e) => e.ticker + ' +' + e.weighted_delta_bp).join(' / ') + 'bp',
          key_numbers: {
            reporting_period: marks.latest_period,
            per_ticker_weighted_delta_bp: ticks,
            bonds: rows,
          },
          why_it_matters_en: 'Same sector, same quarter, same method — the gap between the repriced name and its peers is the information. Marks are N-PORT Level 2 fair values, not trades.',
          url_zh: 'https://spreadbench.com/story-crwv.html',
          url_en: 'https://spreadbench.com/en/story-crwv.html',
          share_card_1200x630: 'https://spreadbench.com/assets/img/story-crwv.png',
        });
      }
    }

    return {
      status: 'ok',
      as_of: uni.as_of,
      data_status: uni.data_status,
      stories: stories,
      note: 'Recomputed live from public SEC filing data (universe + N-PORT marks). Facts only — no ratings, no valuation opinions, no investment advice.',
    };
  }

  const rel = t.path(a);
  let data;
  try {
    data = await readJson(rel);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/ENOENT|HTTP 404|not found/i.test(msg)) return notFound(rel);
    throw e;
  }
  return data;
}

module.exports = { TOOLS, SERVER_INFO, callTool, BY_NAME };
