#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const APP_ID = process.env.LARK_APP_ID || process.env.APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET || process.env.APP_SECRET;
const DOMAIN = (process.env.LARK_DOMAIN || "https://open.larksuite.com").replace(/\/$/, "");
let tokenCache = { token: null, exp: 0 };
async function tenantToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  if (!APP_ID || !APP_SECRET) throw new Error("LARK_APP_ID / LARK_APP_SECRET are not set in the MCP config env.");
  const r = await fetch(`${DOMAIN}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`Lark auth failed (${j.code}): ${j.msg}. Check App ID/Secret.`);
  tokenCache = { token: j.tenant_access_token, exp: Date.now() + (j.expire - 120) * 1e3 };
  return tokenCache.token;
}
const HINTS = {
  91403: "Your Lark app has no permission on this sheet. Open the sheet \u2192 \u2022\u2022\u2022 (top right) \u2192 Add Apps / More \u2192 Add document app \u2192 <your app>, and give it EDIT access.",
  1310213: "Your Lark app has no permission on this sheet (needs edit). Share the sheet with your Lark app with 'Can edit'.",
  99991672: "The app is missing an API scope. In the Lark developer console add 'sheets:spreadsheet' (read & write), then create a new version and publish it.",
  99991663: "Access token invalid \u2014 restart Claude so the MCP fetches a new token.",
  90202: "Range is wrong. Use 'SheetName!A1:D10' or 'sheetId!A1:D10'."
};
async function lark(method, path, body) {
  const token = await tenantToken();
  const r = await fetch(`${DOMAIN}/open-apis${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: body === void 0 ? void 0 : JSON.stringify(body)
  });
  let j;
  try {
    j = await r.json();
  } catch {
    throw new Error(`Lark HTTP ${r.status} (non-JSON response) on ${method} ${path}`);
  }
  if (j.code !== 0) {
    if (j.code === 99991663 || j.code === 99991661) tokenCache = { token: null, exp: 0 };
    const hint = HINTS[j.code] ? `
Fix: ${HINTS[j.code]}` : "";
    throw new Error(`Lark error ${j.code}: ${j.msg}${hint}`);
  }
  return j.data;
}
const docCache = new Map();
async function resolveSpreadsheet(input) {
  input = String(input).trim();
  if (docCache.has(input)) return docCache.get(input);
  let token = input, kind = "sheets", sheetFromUrl = null;
  const m = input.match(/\/(sheets|wiki)\/([A-Za-z0-9]+)/);
  if (m) {
    kind = m[1];
    token = m[2];
    const s = input.match(/[?&]sheet=([A-Za-z0-9]+)/);
    if (s) sheetFromUrl = s[1];
  }
  if (kind === "wiki") {
    const d = await lark("GET", `/wiki/v2/spaces/get_node?token=${token}`);
    if (d.node.obj_type !== "sheet") throw new Error(`That wiki page is a ${d.node.obj_type}, not a sheet.`);
    token = d.node.obj_token;
  }
  const out = { token, sheetFromUrl };
  docCache.set(input, out);
  return out;
}
async function getTabs(token) {
  const d = await lark("GET", `/sheets/v3/spreadsheets/${token}/sheets/query`);
  return d.sheets.map((s) => ({
    sheet_id: s.sheet_id,
    title: s.title,
    index: s.index,
    hidden: s.hidden,
    rows: s.grid_properties?.row_count,
    cols: s.grid_properties?.column_count,
    frozen_rows: s.grid_properties?.frozen_row_count
  }));
}
async function resolveRange(doc, range) {
  let tab = null, cells = range || "";
  const bang = cells.lastIndexOf("!");
  if (bang >= 0) {
    tab = cells.slice(0, bang).replace(/^'|'$/g, "");
    cells = cells.slice(bang + 1);
  }
  const tabs = await getTabs(doc.token);
  let found;
  if (tab) found = tabs.find((t) => t.sheet_id === tab) || tabs.find((t) => t.title === tab) || tabs.find((t) => t.title.toLowerCase() === tab.toLowerCase());
  else if (doc.sheetFromUrl) found = tabs.find((t) => t.sheet_id === doc.sheetFromUrl);
  else found = tabs[0];
  if (!found) throw new Error(`Tab "${tab}" not found. Tabs: ${tabs.map((t) => `${t.title} (${t.sheet_id})`).join(", ")}`);
  return { sheetId: found.sheet_id, title: found.title, full: cells ? `${found.sheet_id}!${cells}` : found.sheet_id };
}
function encode(values, raw) {
  return values.map((row) => row.map((v) => {
    if (!raw && typeof v === "string" && v.startsWith("=")) return { type: "formula", text: v };
    return v === void 0 ? null : v;
  }));
}
const ok = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const wrap = (fn) => async (args) => {
  try {
    return ok(await fn(args));
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: String(e.message || e) }] };
  }
};
const SHEET = z.string().describe("Lark sheet link (\u2026/sheets/XXXX?sheet=YYY or \u2026/wiki/XXXX) or spreadsheet token");
const RANGE = z.string().describe("Range like 'A1:D10', 'Budget!A1:D10' (tab name) or '1qDKMm!A1:D10' (tab id). Without a tab, uses the tab in the link, else the first tab.");
const VALUES = z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe("2-D array of rows. Strings starting with '=' are written as formulas.");
const server = new McpServer({ name: "lark-sheets", version: "1.0.0" });
server.tool(
  "sheet_tabs",
  "List all tabs (sheet_id, title, size) of a Lark spreadsheet.",
  { sheet: SHEET },
  wrap(async ({ sheet }) => {
    const doc = await resolveSpreadsheet(sheet);
    return { spreadsheet_token: doc.token, tabs: await getTabs(doc.token) };
  })
);
server.tool(
  "sheet_read",
  "Read cell values from a range. render: 'formatted' (as displayed), 'raw' (unformatted numbers), 'formula' (shows formulas).",
  { sheet: SHEET, range: RANGE, render: z.enum(["formatted", "raw", "formula"]).optional() },
  wrap(async ({ sheet, range, render = "formatted" }) => {
    const doc = await resolveSpreadsheet(sheet);
    const r = await resolveRange(doc, range);
    const opt = { formatted: "FormattedValue", raw: "UnformattedValue", formula: "Formula" }[render];
    const d = await lark("GET", `/sheets/v2/spreadsheets/${doc.token}/values/${encodeURIComponent(r.full)}?valueRenderOption=${opt}&dateTimeRenderOption=FormattedString`);
    return { tab: r.title, range: d.valueRange.range, values: d.valueRange.values };
  })
);
server.tool(
  "sheet_write",
  "Overwrite cells in ONE range with values/formulas. The values array size should match the range (or just give the top-left cell, e.g. 'B5').",
  { sheet: SHEET, range: RANGE, values: VALUES, raw: z.boolean().optional().describe("true = write strings starting with '=' as plain text") },
  wrap(async ({ sheet, range, values, raw }) => {
    const doc = await resolveSpreadsheet(sheet);
    const r = await resolveRange(doc, range);
    const d = await lark("PUT", `/sheets/v2/spreadsheets/${doc.token}/values`, { valueRange: { range: r.full, values: encode(values, raw) } });
    return { tab: r.title, updated_range: d.updatedRange, updated_cells: d.updatedCells, revision: d.revision };
  })
);
server.tool(
  "sheet_write_many",
  "Write several ranges in one call (can span tabs).",
  { sheet: SHEET, updates: z.array(z.object({ range: RANGE, values: VALUES })), raw: z.boolean().optional() },
  wrap(async ({ sheet, updates, raw }) => {
    const doc = await resolveSpreadsheet(sheet);
    const valueRanges = [];
    for (const u of updates) valueRanges.push({ range: (await resolveRange(doc, u.range)).full, values: encode(u.values, raw) });
    const d = await lark("POST", `/sheets/v2/spreadsheets/${doc.token}/values_batch_update`, { valueRanges });
    return { revision: d.revision, responses: d.responses?.map((x) => ({ range: x.updatedRange, cells: x.updatedCells })) };
  })
);
server.tool(
  "sheet_append",
  "Append rows after the last filled row of a range/table (inserts new rows, does not overwrite).",
  { sheet: SHEET, range: RANGE, values: VALUES, raw: z.boolean().optional() },
  wrap(async ({ sheet, range, values, raw }) => {
    const doc = await resolveSpreadsheet(sheet);
    const r = await resolveRange(doc, range);
    const d = await lark("POST", `/sheets/v2/spreadsheets/${doc.token}/values_append?insertDataOption=INSERT_ROWS`, { valueRange: { range: r.full, values: encode(values, raw) } });
    return { tab: r.title, updated_range: d.updates?.updatedRange, updated_cells: d.updates?.updatedCells };
  })
);
server.tool(
  "sheet_clear",
  "Clear values in a range (writes empty cells; keeps formatting).",
  { sheet: SHEET, range: RANGE },
  wrap(async ({ sheet, range }) => {
    const doc = await resolveSpreadsheet(sheet);
    const r = await resolveRange(doc, range);
    const cur = await lark("GET", `/sheets/v2/spreadsheets/${doc.token}/values/${encodeURIComponent(r.full)}`);
    const vals = cur.valueRange.values || [];
    const width = Math.max(1, ...vals.map((x) => x.length));
    const blank = vals.map(() => Array(width).fill(""));
    if (!blank.length) return "Range already empty.";
    const d = await lark("PUT", `/sheets/v2/spreadsheets/${doc.token}/values`, { valueRange: { range: cur.valueRange.range, values: blank } });
    return { tab: r.title, cleared: d.updatedRange };
  })
);
server.tool(
  "sheet_insert_rows",
  "Insert empty rows or columns. start is 0-based (0 = before row 1 / column A).",
  { sheet: SHEET, tab: z.string().optional().describe("Tab name or id (default: tab in link / first tab)"), dimension: z.enum(["ROWS", "COLUMNS"]).default("ROWS"), start: z.number().int().min(0), count: z.number().int().min(1).max(5e3) },
  wrap(async ({ sheet, tab, dimension, start, count }) => {
    const doc = await resolveSpreadsheet(sheet);
    const r = await resolveRange(doc, tab ? `${tab}!A1` : "A1");
    await lark("POST", `/sheets/v2/spreadsheets/${doc.token}/insert_dimension_range`, {
      dimension: { sheetId: r.sheetId, majorDimension: dimension, startIndex: start, endIndex: start + count },
      inheritStyle: start > 0 ? "BEFORE" : "AFTER"
    });
    return `Inserted ${count} ${dimension.toLowerCase()} at index ${start} in "${r.title}".`;
  })
);
server.tool(
  "sheet_delete_rows",
  "Delete rows or columns. first/last are 1-based and inclusive (e.g. rows 5 to 7).",
  { sheet: SHEET, tab: z.string().optional(), dimension: z.enum(["ROWS", "COLUMNS"]).default("ROWS"), first: z.number().int().min(1), last: z.number().int().min(1) },
  wrap(async ({ sheet, tab, dimension, first, last }) => {
    const doc = await resolveSpreadsheet(sheet);
    const r = await resolveRange(doc, tab ? `${tab}!A1` : "A1");
    const d = await lark("DELETE", `/sheets/v2/spreadsheets/${doc.token}/dimension_range`, {
      dimension: { sheetId: r.sheetId, majorDimension: dimension, startIndex: first, endIndex: last }
    });
    return { tab: r.title, deleted: d.delCount ?? last - first + 1 };
  })
);
server.tool(
  "sheet_add_tab",
  "Add a new tab to the spreadsheet.",
  { sheet: SHEET, title: z.string(), index: z.number().int().min(0).optional() },
  wrap(async ({ sheet, title, index }) => {
    const doc = await resolveSpreadsheet(sheet);
    const props = { title };
    if (index !== void 0) props.index = index;
    const d = await lark("POST", `/sheets/v2/spreadsheets/${doc.token}/sheets_batch_update`, { requests: [{ addSheet: { properties: props } }] });
    return d.replies?.[0]?.addSheet?.properties || d;
  })
);
server.tool(
  "sheet_find",
  "Find cells containing text in a tab. Returns matching cell addresses.",
  { sheet: SHEET, tab: z.string().optional(), text: z.string(), range: z.string().optional().describe("Optional cells like 'A1:Z500'") },
  wrap(async ({ sheet, tab, text, range }) => {
    const doc = await resolveSpreadsheet(sheet);
    const r = await resolveRange(doc, tab ? `${tab}!A1` : "A1");
    const d = await lark("POST", `/sheets/v3/spreadsheets/${doc.token}/sheets/${r.sheetId}/find`, {
      find_condition: { range: `${r.sheetId}!${range || "A1:ZZ5000"}`, match_case: false, match_entire_cell: false, search_by_regex: false, include_formulas: false },
      find: text
    });
    return { tab: r.title, matched_cells: d.find_result?.matched_cells || [], matched_formula_cells: d.find_result?.matched_formula_cells || [] };
  })
);
server.tool(
  "sheet_check_access",
  "Diagnose whether the app can read AND write a sheet (writes nothing; tests write by re-writing one cell with its own value).",
  { sheet: SHEET },
  wrap(async ({ sheet }) => {
    const doc = await resolveSpreadsheet(sheet);
    const tabs = await getTabs(doc.token);
    const t = doc.sheetFromUrl || tabs[0].sheet_id;
    const cur = await lark("GET", `/sheets/v2/spreadsheets/${doc.token}/values/${t}!A1:A1?valueRenderOption=Formula`);
    const v = cur.valueRange.values?.[0]?.[0] ?? null;
    let write = "ok";
    if (v !== null && typeof v === "object") return { read: "ok", write: "skipped (A1 holds a rich value; test on another sheet)", tabs: tabs.map((x) => x.title) };
    try {
      await lark("PUT", `/sheets/v2/spreadsheets/${doc.token}/values`, { valueRange: { range: `${t}!A1:A1`, values: encode([[v]], false) } });
    } catch (e) {
      write = String(e.message);
    }
    return { read: "ok", write, tabs: tabs.map((x) => x.title) };
  })
);
await server.connect(new StdioServerTransport());
