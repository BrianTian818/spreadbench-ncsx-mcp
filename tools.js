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
    path: () => '/api/v1/latest.json',
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
    name: 'ncsx_marks',
    description: 'Second, independent layer: quarterly fair-value marks for AI-infrastructure bonds as reported by US registered funds on SEC Form N-PORT (Level 2), converted to spread over the matched Treasury. Compare with NCSX-IS to see issuance spread vs. mark spread.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    path: () => '/api/v1/real/marks.json',
  },
  {
    name: 'ncsx_methodology',
    description: 'Methodology metadata and full formula chain: version, DOI, license, data sources and their licensing status, the exact spread and weighting formulas, and what is explicitly NOT measured.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    path: () => '/api/v1/methodology.json',
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
    path: () => '/api/v1/attribution.json',
  },
  {
    name: 'ncsx_weekly',
    description: 'DEPRECATED — returns a structured retirement notice, not data. The structured weekly snapshot is being rebuilt; the human-readable feed at https://spreadbench.com/feed.xml is the current source.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    path: () => '/api/v1/weekly.json',
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
  serverInfo: { name: 'ncsx', version: '0.2.1' },
  instructions:
    'SpreadBench publishes ' + NCSX_IS + ', an issuance-spread benchmark for AI-infrastructure (Neocloud) bonds: ' +
    'each constituent coupon minus the US Treasury yield of matching tenor on its pricing date, weighted by face value. ' +
    'It is event-driven and point-in-time — there is no daily change, and it is not a traded CDS level. ' +
    'Every payload carries data_status: "real_issuance" = observed public issuance data and safe to quote; ' +
    '"retired_seed" / "seed" = withdrawn demo series, never quote as market levels. ' +
    'Free and publicly reproducible; methodology and DOI at https://spreadbench.com/methodology.html. ' +
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
    replacement: { tool: 'ncsx_latest', http: '/api/v1/latest.json', levels: ['NCSX-IS', 'secured', 'unsecured'] },
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
    replacement: { tool: 'ncsx_latest', http: '/api/v1/latest.json' },
  }, extra || {});
}

/* readJson(relPath) 由调用方注入：stdio 版走 http fetch，http 版走本地文件。 */
async function callTool(name, args, readJson) {
  const t = BY_NAME[name];
  if (!t) throw new Error('Unknown tool: ' + name);
  const a = args || {};

  if (t.resolve === 'retired_levels') return retiredLevels(a.tier);

  if (t.resolve === 'bond') {
    const q = String(a.q || '').trim().toLowerCase();
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
        query: a.q,
        available: (uni.bonds || []).map((b) => ({ issuer: b.issuer, ticker: b.ticker, coupon: b.coupon, maturity: b.maturity })),
        note_zh: '没有匹配的成分券。上面列出全部可用标的，可改用发行人名称或代码重试。',
      };
    }
    return {
      status: 'ok',
      query: a.q,
      as_of: uni.as_of,
      data_status: uni.data_status,
      methodology: uni.methodology,
      matches: hits,
      note_zh: 'issue_spread_bp = 票息 − 定价日同期限国债插值（百分点）× 100；tenor_years 为定价日到到期日的年数。',
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
