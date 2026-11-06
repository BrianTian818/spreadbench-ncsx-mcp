# SpreadBench NCSX-IS — MCP server

Official [Model Context Protocol](https://modelcontextprotocol.io) server for **SpreadBench NCSX-IS**, an issuance-spread benchmark for AI-infrastructure (Neocloud) bonds.

> **What NCSX-IS measures.** For each constituent bond, the coupon minus the US Treasury yield of matching tenor **on that bond's pricing date**, weighted by face value. It is a **point-in-time issuance spread** — event-driven, no daily frequency, and **not** a traded CDS level or a rating. SpreadBench publishes no credit ratings and no investment advice.

Live data: <https://spreadbench.com> · Methodology + DOI: <https://spreadbench.com/methodology.html> · JSON API: <https://spreadbench.com/api.html>

---

## Two ways to connect

### 1. Remote (streamable-http, nothing to install)

```json
{
  "mcpServers": {
    "ncsx": {
      "type": "streamable-http",
      "url": "https://spreadbench.com/mcp"
    }
  }
}
```

Free, no API key, no signup.

### 2. Local (stdio, same tool set)

```bash
npm install -g github:BrianTian818/spreadbench-ncsx-mcp
# or, without npm registry:
npm install -g https://spreadbench.com/download/ncsx-mcp-0.2.9.tgz
```

```json
{
  "mcpServers": {
    "ncsx": { "command": "ncsx-mcp" }
  }
}
```

Both transports share one tool definition file (`tools.js`), so they never drift apart.

---

## Tools

Fourteen read-only tools, all keyless. Every tool declares `readOnlyHint: true` / `destructiveHint: false`, so clients do not prompt for write permission.

| Tool | Returns |
|---|---|
| `ncsx_latest` | **Start here for "what is the level".** Latest NCSX-IS reading, secured / unsecured sub-indices, constituent and issuer counts, notional, as-of date, methodology version, DOI, `data_status` |
| `ncsx_index` | **Structural, not a single number.** Full index definition, sub-index notionals, coverage notes |
| `ncsx_constituents` | **The whole universe, no filter.** All 13 constituent bonds: issuer, ticker, coupon, maturity, size, seniority, pricing date, matched Treasury, issuance spread in bp |
| `ncsx_bond` | **Filtered lookup for one issuer** — matches issuer / ticker / note keyword and returns only matching bonds |
| `ncsx_curve` | The Treasury par-yield curve used on the pricing date (14 tenors, linear interpolation, no extrapolation) plus recent history |
| `ncsx_sector` | US high-yield / investment-grade OAS reference series for comparison |
| `ncsx_filings` | SEC filing radar for 9 AI-infrastructure issuers, last 45 days, noise forms filtered; pricing-chain forms (FWP / 424B* / S-3*) flagged `pricing_signal` |
| `ncsx_marks` | Second, independent layer: quarterly fair-value marks from SEC Form N-PORT filings, converted to spread |
| `ncsx_wall` | Maturity wall by year with secured / unsecured split; pass `year` to drill into one cohort |
| `ncsx_stories` | Citable data stories recomputed live, each with headline numbers, bilingual page and a 1200x630 share card |
| `ncsx_facts` | 16 quotable numbers, each with `value`, `unit`, `as_of`, a human-readable `calc` and a `source`; filter by `id` or `q` |
| `ncsx_events` | **History as an event replay.** 13 pricing events in order, level after each, change in bp and per-bond pull attribution (`pull_bp`), so pulls sum to the event delta; filter by `since` or `ticker` |
| `ncsx_ruler` | **Reverse pricing.** Given a coupon and a tenor: interpolated Treasury (never extrapolated), issuance spread, rank among the 13, gap to the index level and to the same-structure tier, and the index level after adding the bond at a given size. Pass `issuer` to get that issuer's own bonds already in the index as a pricing history. Recomputed on every call — nothing is stored |
| `ncsx_methodology` | Methodology version, DOI, license, data sources and their licensing status, full formula chain |

Three names from the demo-era server — `ncsx_levels`, `ncsx_attribution`, `ncsx_weekly` — are **not listed** any more, but still answer if an old client calls them: they return a structured retirement notice rather than an error.

---

## Read `data_status` before you quote anything

Every payload carries a `data_status` field. This is the single most important field in the schema:

| `data_status` | Meaning |
|---|---|
| `real_issuance` | Observed public issuance data. Safe to quote; reproducible from SEC filings. |
| `retired_seed` / `seed` | A **withdrawn demo series**. Numbers were generated for layout testing. **Never quote as market levels.** |

If a tool returns `status: "retired"`, the endpoint was withdrawn — read the `replacement` field and move on. Nothing in this server will silently hand you demo numbers.

---

## Example prompts

- *"What is the current NCSX-IS spread, and how does the unsecured cohort differ from the secured one?"*
- *"Which CoreWeave bonds are in the index and what spread did each price at?"*
- *"Compare NCSX-IS against the US high-yield OAS over the last 90 days."*
- *"Which Treasury tenors does the index lean on most?"*
- *"Is the NCSX-IS level consistent with the latest SEC N-PORT marks?"*
- *"A $1.5bn 5-year note at 8.25% — where does that price relative to this market, and what would it do to NCSX-IS?"*
- *"How did NCSX-IS get from 517.7bp to 432.3bp, and which issuer pulled it the most?"*

---

## Conventions

- **Identifier:** constituents are identified by issuer + coupon + maturity. They do **not** carry CUSIPs — do not query by CUSIP.
- **Units:** spreads in basis points over the Treasury at pricing. Notionals in USD millions.
- **Frequency:** event-driven. There is no T+1 update and no daily change field.
- **Reproducibility:** every number is derived from public filings (SEC EDGAR) and the US Treasury par-yield curve. The methodology page states the exact formula and the interpolation rule.

## Notes on naming

Older versions of this server exposed `Composite` / `HY` / `IG` tiers and 90-day daily series. Those came from a demo dataset and were withdrawn on 2026-11-04 in favour of the issuance-spread methodology (`v0.2.0-real`). The three retired names listed above remain callable only so that old clients receive an explicit notice instead of an error; they are hidden from `tools/list`.

## Directory listings

This server is listed in the official [MCP Registry](https://registry.modelcontextprotocol.io) as `com.spreadbench/ncsx`, and is indexed by Glama (`A` tier) and brick.blue. `glama.json` in this repo claims the listing for its maintainer.

## License

MIT. Data is published for research and citation; SpreadBench does not provide credit ratings or investment advice.
