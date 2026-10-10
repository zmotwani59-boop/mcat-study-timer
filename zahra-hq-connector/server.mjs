#!/usr/bin/env node
// Zahra HQ's private remote MCP adapter. No tokens or deployment URLs are stored in source.
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT || 3000);
const KEY = process.env.HQ_MCP_ACCESS_KEY || "";
const BRIDGE_URL = process.env.HQ_BRIDGE_URL || "";
const BRIDGE_TOKEN = process.env.HQ_BRIDGE_TOKEN || "";
const VERSION = "2025-03-26";
const MAX_LENGTH = 1199;
const HEADERS = ["Priorities:", "To do:", "Deadlines:", "Can wait:"];

if (KEY.length < 32) {
  console.error("HQ_MCP_ACCESS_KEY is required and must be at least 32 characters.");
  process.exit(1);
}

const tool = {
  name: "sendToHQ",
  description: "Send the user's explicitly approved check-in, priorities, tasks, deadline list, or plan into Zahra HQ exactly once. Do not call without user authorization. The destination is the user's existing HQ planner.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Plain-text update with headers in order: Priorities:, To do:, Deadlines:, Can wait:. Under 1200 characters. One task per line; timed items start with a time range." }
    },
    required: ["text"],
    additionalProperties: false
  }
};
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const error = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const secureMatch = (a, b) => {
  if (!a || !b) return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};

async function sendPlan(text) {
  if (typeof text !== "string" || !text.trim() || text.length > MAX_LENGTH)
    throw new Error("Plan must be nonempty and under 1200 characters.");
  let last = -1;
  for (const header of HEADERS) {
    const at = text.indexOf(header);
    if (at < 0 || at <= last) throw new Error("Plan is missing or has an out-of-order header: " + header);
    last = at;
  }
  if (!BRIDGE_URL || !BRIDGE_TOKEN) throw new Error("HQ bridge environment variables are not configured.");
  const url = new URL(BRIDGE_URL);
  if (url.protocol !== "https:" || url.hostname !== "script.google.com" || !/^\\/macros\\/s\\/[^/]+\\/exec$/.test(url.pathname))
    throw new Error("Invalid HQ Apps Script bridge URL.");
  url.searchParams.set("token", BRIDGE_TOKEN);
  url.searchParams.set("text", text);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 24000);
  let response;
  try { response = await fetch(url, { redirect: "follow", signal: controller.signal, headers: { "accept": "application/json" } }); }
  catch (e) { throw new Error(e?.name === "AbortError" ? "HQ bridge timeout" : "HQ bridge request failed"); }
  finally { clearTimeout(timeout); }
  if (!response.ok) throw new Error("HQ bridge HTTP " + response.status);
  let body;
  try { body = JSON.parse((await response.text()).slice(0, 32768)); }
  catch { throw new Error("HQ bridge did not return JSON. Apps Script redirects or deployment permissions may need attention."); }
  if (!body || typeof body !== "object") throw new Error("Unexpected HQ bridge response.");
  if (body.ok === false || body.success === false || body.error)
    throw new Error("HQ bridge rejected update: " + String(body.error || body.message || "unknown error").slice(0, 250));
  return { submitted: true, bridgeResult: body, note: "Refresh HQ to verify the new items." };
}

async function rpc(msg) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string")
    return error(msg?.id ?? null, -32600, "Invalid JSON-RPC request.");
  if (!Object.hasOwn(msg, "id")) return null;
  switch (msg.method) {
    case "initialize":
      return ok(msg.id, { protocolVersion: VERSION, serverInfo: { name: "zahra-hq", version: "0.2.0" }, capabilities: { tools: { listChanged: false } } });
    case "ping": return ok(msg.id, {});
    case "tools/list": return ok(msg.id, { tools: [tool] });
    case "tools/call":
      if (msg.params?.name !== "sendToHQ") return error(msg.id, -32602, "Unknown tool");
      try {
        const result = await sendPlan(msg.params?.arguments?.text);
        return ok(msg.id, { content: [{ type: "text", text: JSON.stringify(result) }] });
      } catch (e) {
        return ok(msg.id, { isError: true, content: [{ type: "text", text: "Zahra HQ error: " + String(e.message || e) }] });
      }
    default: return error(msg.id, -32601, "Unsupported method");
  }
}

createServer(async (req, res) => {
  const respond = (status, body, contentType = "application/json") => {
    res.writeHead(status, { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(body === null ? "" : JSON.stringify(body));
  };
  const path = new URL(req.url || "/", "http://localhost").pathname;
  if (path === "/health" && req.method === "GET") {
    respond(200, { ok: true, service: "zahra-hq-mcp", configured: Boolean(BRIDGE_URL && BRIDGE_TOKEN) });
    return;
  }
  if (!path.startsWith("/mcp/") || !secureMatch(path.slice("/mcp/".length), KEY)) { respond(404, { error: "Not found" }); return; }
  if (req.method !== "POST") { respond(405, { error: "Use POST" }); return; }
  if (!(req.headers["content-type"] || "").includes("application/json")) { respond(415, { error: "Expected JSON" }); return; }
  const parts = [];
  let length = 0;
  for await (const part of req) {
    length += part.length;
    if (length > 16384) { respond(413, { error: "Request too large" }); return; }
    parts.push(part);
  }
  let msg;
  try { msg = JSON.parse(Buffer.concat(parts).toString("utf8")); }
  catch { respond(400, { error: "Invalid JSON" }); return; }
  if (Array.isArray(msg)) { respond(400, { error: "Batch requests are not supported" }); return; }
  try {
    const result = await rpc(msg);
    if (result === null) { respond(202, null); return; }
    respond(200, result);
  } catch { respond(500, error(msg?.id ?? null, -32603, "Internal error")); }
}).listen(PORT, "0.0.0.0", () => console.error("Zahra HQ MCP listening on " + PORT));
