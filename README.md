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
npm install -g https://spreadbench.com/download/ncsx-mcp-0.2.0.tgz
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

| Tool | Returns |
|---|---|
| `ncsx_latest` | Latest NCSX-IS reading, secured / unsecured sub-indices, constituent and issuer counts, notional, as-of date, methodology version, DOI, `data_status` |
| `ncsx_index` | Full index definition, sub-index notionals, coverage notes |
| `ncsx_constituents` | All 13 constituent bonds: issuer, ticker, coupon, maturity, size, seniority, pricing date, matched Treasury, issuance spread in bp |
| `ncsx_bond` | Look up individual bonds by issuer / ticker / note keyword |
| `ncsx_curve` | The Treasury par-yield curve used on the pricing date (14 tenors, linear interpolation, no extrapolation) plus recent history |
| `ncsx_sector` | US high-yield / investment-grade OAS reference series for comparison |
| `ncsx_marks` | Second, independent layer: quarterly fair-value marks from SEC Form N-PORT filings, converted to spread |
| `ncsx_methodology` | Methodology version, DOI, license, data sources and their licensing status, full formula chain |
| `ncsx_levels` | **Deprecated** — returns a structured retirement notice (the old demo series was withdrawn) |
| `ncsx_attribution` | **Deprecated** — an issuance spread has no daily move to attribute |
| `ncsx_weekly` | **Deprecated** — structured snapshot being rebuilt; see <https://spreadbench.com/feed.xml> |

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

---

## Conventions

- **Identifier:** constituents are identified by issuer + coupon + maturity. They do **not** carry CUSIPs — do not query by CUSIP.
- **Units:** spreads in basis points over the Treasury at pricing. Notionals in USD millions.
- **Frequency:** event-driven. There is no T+1 update and no daily change field.
- **Reproducibility:** every number is derived from public filings (SEC EDGAR) and the US Treasury par-yield curve. The methodology page states the exact formula and the interpolation rule.

## Notes on naming

Older versions of this server exposed `Composite` / `HY` / `IG` tiers and 90-day daily series. Those came from a demo dataset and were withdrawn on 2026-11-04 in favour of the issuance-spread methodology (`v0.2.0-real`). The three deprecated tools above remain callable only so that old clients receive an explicit notice instead of an error.

## License

MIT. Data is published for research and citation; SpreadBench does not provide credit ratings or investment advice.
