#!/usr/bin/env node
'use strict';
/* @ncsx/mcp — SpreadBench NCSX 官方 MCP server（stdio, 零依赖）
 *
 * 数据源：https://spreadbench.com/api/v1/*.json（免费公开端点，全部带 data_status 字段）
 * 协议：Model Context Protocol（JSON-RPC 2.0 over stdio），2024-11-05 / 2025-03-26 spec
 *
 * 用法（Claude Desktop / 任意 MCP 客户端）：
 *   npx -y @ncsx/mcp        （npm 发布后）
 *   node index.js           （本地）
 */

const BASE = process.env.NCSX_BASE_URL || 'https://spreadbench.com';

/* ---------- 极简 JSON-RPC / MCP ---------- */
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
let buf = '';
let inflight = 0;   /* 未完成的请求数：stdin 关闭时不能立刻 exit，否则最后一条 tools/call 会被截断 */
let ended = false;
function maybeExit() { if (ended && !inflight) process.exit(0); }

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    inflight++;
    handle(msg).catch(() => {}).then(() => { inflight--; maybeExit(); });
  }
});
process.stdin.on('end', () => { ended = true; maybeExit(); });

const { TOOLS, SERVER_INFO, callTool: callShared } = require('./tools');

function ok(id, result) { send({ jsonrpc: '2.0', id, result }); }
function err(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

/* Node 18+ 内置 fetch；老 Node 降级 https 模块 */
function getJson(rel) {
  const url = BASE + rel;
  if (typeof fetch === 'function') {
    return fetch(url, { headers: { 'User-Agent': '@ncsx/mcp 0.2.0' } })
      .then((r) => (r.status === 200 ? r.json() : Promise.reject(new Error('HTTP ' + r.status + ' for ' + url))));
  }
  return new Promise((resolve, reject) => {
    const https = require('https');
    https.get(url, { headers: { 'User-Agent': '@ncsx/mcp 0.2.0' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function callTool(name, args) {
  const data = await callShared(name, args, getJson);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/* ---------- 分发 ---------- */
async function handle(msg) {
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') return ok(id, SERVER_INFO);
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return; // 通知不回包
    if (method === 'ping') return ok(id, {});
    if (method === 'tools/list') return ok(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const result = await callTool(params.name, params.arguments || {});
      return ok(id, result);
    }
    if (method === 'resources/list') return ok(id, { resources: [] });
    if (method === 'prompts/list') return ok(id, { prompts: [] });
    return err(id, -32601, 'Method not found: ' + method);
  } catch (e) {
    return err(id, -32000, String((e && e.message) || e));
  }
}
