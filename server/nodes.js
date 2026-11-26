// Direct nodes: they do real work with no model and no agent loop.
//
//   fetch  download a URL and hand back JSON or text
//   mcp    call one tool on a Model Context Protocol server (HTTP or stdio)
//   bash   run a shell command on this machine
//   code   run JavaScript against the incoming data in a vm context
//
// Every failure is a thrown Error, so the engine's retry policy applies to
// these nodes exactly the way it does to model nodes.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import vm from "node:vm";
import { renderTemplate, renderDeep } from "./template.js";
import { resolveCredential } from "./credentials.js";

const MAX_STREAM = 200_000;

function renderedJson(raw, input) {
  if (raw == null) return {};
  const text = typeof raw === "string" ? raw.trim() : raw;
  if (!text) return {};
  if (typeof text === "object") return renderDeep(text, input);
  try {
    return renderDeep(JSON.parse(text), input);
  } catch {
    try {
      return JSON.parse(renderTemplate(text, input));
    } catch {
      throw new Error("This field must be valid JSON");
    }
  }
}

function renderedHeaders(node, input) {
  const headers = {};
  for (const [key, value] of Object.entries(renderedJson(node.headers, input) ?? {})) {
    headers[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  if (node.credential_id) {
    const credential = resolveCredential(node.credential_id, node._userId ?? null);
    if (credential.apiKey) headers.authorization = `Bearer ${credential.apiKey}`;
  }
  return headers;
}

function trimBody(text) {
  const value = String(text ?? "");
  return value.length > MAX_STREAM ? `${value.slice(0, MAX_STREAM)}\n… (truncated)` : value;
}

// ---- fetch ----------------------------------------------------------------

export async function runFetchNode({ node, input, signal, userId }) {
  const startedAt = Date.now();
  const url = String(renderTemplate(node.url ?? "", input)).trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Fetch needs an absolute URL. Got "${url || "(empty)"}". Use {{ field }} to inject values.`);
  }
  const method = String(node.method || "GET").toUpperCase();
  const headers = renderedHeaders({ ...node, _userId: userId }, input);
  const response = await fetch(url, { method, headers, signal, redirect: "follow" });
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const elapsed = Date.now() - startedAt;

  if (!response.ok) {
    throw new Error(`${method} ${url} → HTTP ${response.status} ${response.statusText}: ${text.slice(0, 240)}`.trim());
  }

  const format = String(node.format || "auto");
  let body = text;
  let kind = "text";
  if (format !== "text") {
    const trimmed = text.trim();
    if (/json/i.test(contentType) || /^[[{]/.test(trimmed)) {
      try {
        body = JSON.parse(trimmed);
        kind = "json";
      } catch {
        body = text;
      }
    }
  }
  if (format === "text") body = text;

  return {
    json: { url, status: response.status, contentType, kind, body },
    cost: 0,
    tokensIn: 0,
    tokensOut: 0,
    logs: [
      `${method} ${url} → ${response.status} (${elapsed}ms)`,
      `${text.length} bytes${contentType ? ` · ${contentType.split(";")[0]}` : ""} · ${kind}`,
    ],
  };
}

// ---- MCP ------------------------------------------------------------------

let mcpRequestId = 0;
const nextMcpId = () => ++mcpRequestId;

function mcpError(message) {
  const error = new Error(message);
  error.rpc = true;
  return error;
}

function unwrapRpc(message, method) {
  if (message?.error) {
    throw mcpError(`${method} failed: ${message.error.message || JSON.stringify(message.error)}`);
  }
  return message?.result ?? {};
}

async function mcpHttpRequest(endpoint, payload, { headers, sessionId, timeout }) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout),
  });
  const nextSession = response.headers.get("mcp-session-id") || sessionId || null;
  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 300);
    try {
      detail = JSON.parse(text).error?.message || detail;
    } catch {
      /* keep raw */
    }
    throw new Error(`MCP server replied ${response.status}: ${detail}`);
  }
  if (!text.trim()) return { message: null, sessionId: nextSession };
  if (/text\/event-stream/i.test(response.headers.get("content-type") ?? "")) {
    const events = text
      .split(/\r?\n\r?\n/)
      .map((block) =>
        block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n"),
      )
      .filter(Boolean);
    for (const event of events) {
      try {
        const parsed = JSON.parse(event);
        if (payload.id == null || parsed.id === payload.id) return { message: parsed, sessionId: nextSession };
      } catch {
        /* keep scanning */
      }
    }
    throw new Error("MCP server streams a response without matching this request");
  }
  return { message: JSON.parse(text), sessionId: nextSession };
}

export async function openHttpSession(endpoint, headers, timeout) {
  const init = await mcpHttpRequest(
    endpoint,
    {
      jsonrpc: "2.0",
      id: nextMcpId(),
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "sequor", version: "0.3.0" },
      },
    },
    { headers, timeout },
  );
  const { sessionId } = init;
  await mcpHttpRequest(
    endpoint,
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { headers, sessionId, timeout },
  ).catch(() => null);
  return {
    call: async (method, params) => {
      const { message } = await mcpHttpRequest(
        endpoint,
        { jsonrpc: "2.0", id: nextMcpId(), method, params },
        { headers, sessionId, timeout },
      );
      return unwrapRpc(message, method);
    },
  };
}

export async function openStdioSession(command, { cwd, timeout, env } = {}) {
  const child = spawn("bash", ["-lc", command], {
    cwd: cwd || undefined,
    env: { ...process.env, ...(env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let stderr = "";
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const entry = message.id != null ? pending.get(message.id) : null;
    if (!entry) return;
    pending.delete(message.id);
    entry.resolve(message);
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  child.on("exit", (code) => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.reject(new Error(`MCP process exited (${code}). ${stderr.slice(-400)}`));
    }
  });

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextMcpId();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeout}ms`));
      }, timeout);
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  try {
    await call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "sequor", version: "0.3.0" },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    return {
      call: async (method, params) => unwrapRpc(await call(method, params), method),
      close: () => {
        lines.close();
        child.kill();
      },
    };
  } catch (error) {
    child.kill();
    throw error;
  }
}

function mcpText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const texts = content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text);
  return texts.length ? texts.join("\n") : "";
}

export async function runMcpNode({ node, input, userId }) {
  const transport = node.transport === "stdio" ? "stdio" : "http";
  const timeout = Math.max(1000, Number(node.timeout_ms) || 30000);
  const tool = String(renderTemplate(node.tool ?? "", input)).trim();
  const args = renderedJson(node.tool_args, input);
  let session;
  let label;

  if (transport === "http") {
    const endpoint = String(renderTemplate(node.server_url ?? "", input)).trim();
    if (!/^https?:\/\//i.test(endpoint)) {
      throw new Error(`MCP node needs an absolute server URL. Got "${endpoint || "(empty)"}".`);
    }
    label = new URL(endpoint).host;
    session = await openHttpSession(endpoint, renderedHeaders({ ...node, _userId: userId }, input), timeout);
  } else {
    const command = String(renderTemplate(node.command ?? "", input)).trim();
    if (!command) throw new Error("MCP node needs a command to start the server");
    label = command.split(/\s+/)[0];
    session = await openStdioSession(command, { cwd: node.cwd || "", timeout });
  }

  try {
    if (!tool) {
      const result = await session.call("tools/list", {});
      const tools = (result.tools ?? []).map((entry) => ({
        name: entry.name,
        description: entry.description ?? "",
      }));
      return {
        json: { server: label, transport, tools },
        cost: 0,
        tokensIn: 0,
        tokensOut: 0,
        logs: [`${transport} ${label} · ${tools.length} tool${tools.length === 1 ? "" : "s"} available`, "Set a tool name to call one."],
      };
    }

    const result = await session.call("tools/call", { name: tool, arguments: args });
    const text = mcpText(result);
    if (result.isError) throw new Error(`${tool} returned an error: ${text.slice(0, 400) || "no detail"}`);
    return {
      json: { server: label, transport, tool, text, content: result.content ?? null, structured: result.structuredContent ?? null },
      cost: 0,
      tokensIn: 0,
      tokensOut: 0,
      logs: [`${transport} ${label} · ${tool} called`, `${text.length} characters returned`],
    };
  } finally {
    if (transport === "stdio") session.close?.();
  }
}

// One entry point for an MCP server described by an agent config.
export async function openMcpSession(server, timeout = 30000) {
  if (server.transport === "stdio") {
    if (!server.command) throw new Error(`MCP server "${server.name}" has no command`);
    return openStdioSession(server.command, { cwd: server.cwd || "", timeout, env: server.env ?? {} });
  }
  if (!server.url) throw new Error(`MCP server "${server.name}" has no URL`);
  return openHttpSession(server.url, server.headers ?? {}, timeout);
}

// ---- bash -----------------------------------------------------------------

export async function runBashNode({ node, input }) {
  const command = String(renderTemplate(node.command ?? "", input)).trim();
  if (!command) throw new Error("Command node needs a command");
  const cwd = renderTemplate(node.cwd ?? "", input).trim() || process.cwd();
  const timeout = Math.max(1000, Number(node.timeout_ms) || 60000);
  const startedAt = Date.now();

  return await new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: { ...process.env, SEQUOR_INPUT: JSON.stringify(input ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(reject, new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_STREAM) stdout = `${stdout.slice(0, MAX_STREAM)}\n… (truncated)`;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_STREAM) stderr = `${stderr.slice(0, MAX_STREAM)}\n… (truncated)`;
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      const elapsed = Date.now() - startedAt;
      const cleanOut = trimBody(stdout.trim());
      const cleanErr = trimBody(stderr.trim());
      if (code !== 0) {
        finish(
          reject,
          new Error(
            `Command exited ${code}: ${(cleanErr || cleanOut || "no output").slice(0, 600)}`,
          ),
        );
        return;
      }
      finish(resolve, {
        json: { exitCode: code, stdout: cleanOut, stderr: cleanErr, durationMs: elapsed },
        cost: 0,
        tokensIn: 0,
        tokensOut: 0,
        logs: [`$ ${command}`, `exit 0 in ${elapsed}ms`, `${stdout.length} bytes stdout`],
      });
    });

    child.stdin.end(JSON.stringify(input ?? {}, null, 2));
  });
}

// ---- code -----------------------------------------------------------------

export async function runCodeNode({ node, input }) {
  const source = String(node.code ?? "").trim();
  if (!source) throw new Error("Code node needs some JavaScript");
  const timeout = Math.max(100, Number(node.timeout_ms) || 30000);
  const logs = [];
  const capture = (...args) => {
    const line = args
      .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
      .join(" ");
    logs.push(line.slice(0, 1000));
  };
  const sandbox = {
    input: input ?? {},
    console: { log: capture, info: capture, warn: capture, error: capture },
    fetch,
    URL,
    URLSearchParams,
    AbortSignal,
    setTimeout,
    clearTimeout,
    JSON,
    Math,
    Date,
    TextEncoder,
    TextDecoder,
  };
  const startedAt = Date.now();
  let output;
  try {
    const script = new vm.Script(`(async (input) => {\n${source}\n})`, { filename: "sequor-code.js" });
    const fn = script.runInNewContext(sandbox, { timeout });
    output = await fn(input ?? {});
  } catch (error) {
    throw new Error(`Code node threw: ${error.message}`);
  }
  const elapsed = Date.now() - startedAt;
  if (output === undefined) {
    throw new Error("Code node returned nothing. Return a JSON-serializable value.");
  }
  let json;
  try {
    json = JSON.parse(JSON.stringify(output));
  } catch {
    throw new Error("Code node returned a value that cannot be serialised to JSON");
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    json = { result: json };
  }
  logs.push(`returned ${Object.keys(json).length} field${Object.keys(json).length === 1 ? "" : "s"} in ${elapsed}ms`);
  return { json, cost: 0, tokensIn: 0, tokensOut: 0, logs };
}

// ---- flow control ---------------------------------------------------------
// IF, Switch, Filter, Edit Fields, Merge, Wait, Limit, No Operation and Stop
// are deterministic: no model and no network. IF/Switch/Filter also report
// which output branch fired so the engine can skip the other side.

const MAX_WAIT_MS = 60 * 60 * 1000;

function lookupPath(input, path) {
  let current = input;
  for (const part of String(path).split(".").filter(Boolean)) {
    if (current == null) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)];
    else if (typeof current === "object") current = current[part];
    else return undefined;
  }
  return current;
}

// A value that is a single {{ expression }} keeps its JSON type; a bare dotted
// path is read from the input when it exists; anything else is literal text.
function resolveValue(value, input) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text) return "";
  if (text.includes("{{")) return renderTemplate(value, input);
  if (/^[A-Za-z_$][\w$]*(\.[\w$]+)*$/.test(text)) {
    const found = lookupPath(input, text);
    if (found !== undefined) return found;
  }
  return text;
}

function numbersPair(left, right) {
  const a = Number(left);
  const b = Number(right);
  if (Number.isFinite(a) && Number.isFinite(b)) return [a, b];
  return null;
}

export function compareValues(left, operator, right) {
  const op = String(operator || "equals");
  if (op === "isEmpty") {
    return (
      left == null ||
      left === "" ||
      (Array.isArray(left) && !left.length) ||
      (typeof left === "object" && !Array.isArray(left) && !Object.keys(left).length)
    );
  }
  if (op === "isNotEmpty") return !compareValues(left, "isEmpty");
  if (op === "exists") return left != null && left !== "";
  if (op === "isTrue") return left === true || left === "true";
  if (op === "isFalse") return left === false || left === "false";
  if (op === "regex") {
    try {
      return new RegExp(String(right ?? ""), "i").test(String(left ?? ""));
    } catch {
      return false;
    }
  }

  if (op === "contains") {
    if (Array.isArray(left)) return left.some((entry) => String(entry) === String(right));
    return String(left ?? "").toLowerCase().includes(String(right ?? "").toLowerCase());
  }
  if (op === "notContains") return !compareValues(left, "contains", right);
  if (op === "startsWith") return String(left ?? "").toLowerCase().startsWith(String(right ?? "").toLowerCase());
  if (op === "endsWith") return String(left ?? "").toLowerCase().endsWith(String(right ?? "").toLowerCase());

  const pair = numbersPair(left, right);
  if (op === "greater") return pair ? pair[0] > pair[1] : String(left ?? "") > String(right ?? "");
  if (op === "greaterOrEqual") return pair ? pair[0] >= pair[1] : String(left ?? "") >= String(right ?? "");
  if (op === "less") return pair ? pair[0] < pair[1] : String(left ?? "") < String(right ?? "");
  if (op === "lessOrEqual") return pair ? pair[0] <= pair[1] : String(left ?? "") <= String(right ?? "");

  const same = pair ? pair[0] === pair[1] : String(left ?? "") === String(right ?? "");
  return op === "notEquals" ? !same : same;
}

export function conditionsPass(node, input) {
  const conditions = Array.isArray(node.conditions) ? node.conditions.filter(Boolean) : [];
  if (!conditions.length) return true;
  const checks = conditions.map((condition) =>
    compareValues(resolveValue(condition.left, input), condition.operator, resolveValue(condition.right, input)),
  );
  return node.combine === "or" ? checks.some(Boolean) : checks.every(Boolean);
}

export function describeConditions(node) {
  const conditions = Array.isArray(node.conditions) ? node.conditions.filter(Boolean) : [];
  if (!conditions.length) return "always true";
  return conditions
    .map((condition) => `${String(condition.left ?? "value")} ${String(condition.operator ?? "equals")} ${String(condition.right ?? "")}`.trim())
    .join(node.combine === "or" ? " or " : " and ");
}

const zero = () => ({ cost: 0, tokensIn: 0, tokensOut: 0 });

export async function runIfNode({ node, input }) {
  const pass = conditionsPass(node, input);
  return {
    json: { ...(input ?? {}) },
    branches: new Set([pass ? "true" : "false"]),
    ...zero(),
    logs: [`${describeConditions(node)} → ${pass}`, `taking the ${pass ? "true" : "false"} output`],
  };
}

export async function runSwitchNode({ node, input }) {
  const rules = Array.isArray(node.rules) ? node.rules.filter(Boolean) : [];
  let matched = null;
  for (const [index, rule] of rules.entries()) {
    if (compareValues(resolveValue(rule.left, input), rule.operator, resolveValue(rule.right, input))) {
      matched = String(index);
      break;
    }
  }
  if (matched == null && node.fallback !== false) matched = "fallback";
  return {
    json: { ...(input ?? {}) },
    branches: new Set(matched ? [matched] : []),
    ...zero(),
    logs: [
      matched == null ? "no rule matched and there is no fallback output" : `taking output ${matched === "fallback" ? "default" : Number(matched) + 1}`,
    ],
  };
}

export async function runFilterNode({ node, input }) {
  const pass = conditionsPass(node, input);
  return {
    json: { ...(input ?? {}) },
    branches: pass ? null : new Set(),
    ...zero(),
    logs: [`${describeConditions(node)} → ${pass}`, pass ? "kept the item" : "dropped the item, downstream nodes are skipped"],
  };
}

export async function runSetNode({ node, input }) {
  const source = node.assignments;
  const assignments = source && typeof source === "object" && !Array.isArray(source) ? renderDeep(source, input) : {};
  const keys = Object.keys(assignments);
  const json = node.keep_input === false ? { ...assignments } : { ...(input ?? {}), ...assignments };
  return { json, ...zero(), logs: [`set ${keys.length} field${keys.length === 1 ? "" : "s"}${keys.length ? `: ${keys.join(", ")}` : ""}`, node.keep_input === false ? "other input fields dropped" : "other input fields kept"] };
}

export async function runMergeNode({ node, inputs = [] }) {
  const list = inputs.length ? inputs : [{}];
  const mode = node.mode === "append" || node.mode === "first" ? node.mode : "combine";
  let json;
  if (mode === "append") {
    json = { items: list.flatMap((entry) => (Array.isArray(entry?.items) ? entry.items : [entry])) };
  } else if (mode === "first") {
    json = { ...(list[0] ?? {}) };
  } else {
    json = Object.assign({}, ...list);
  }
  return {
    json,
    ...zero(),
    logs: [`${list.length} input${list.length === 1 ? "" : "s"} merged with mode "${mode}"`, `${Object.keys(json).length} field${Object.keys(json).length === 1 ? "" : "s"} out`],
  };
}

export async function runWaitNode({ node, input, signal }) {
  const amount = Math.max(0, Number(node.amount) || 0);
  const perUnit = node.unit === "minutes" ? 60_000 : node.unit === "hours" ? 3_600_000 : 1000;
  const ms = Math.min(Math.round(amount * perUnit), MAX_WAIT_MS);
  if (signal?.aborted) throw new Error("run cancelled");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("run cancelled"));
      },
      { once: true },
    );
  });
  return { json: { ...(input ?? {}) }, ...zero(), logs: [`waited ${amount} ${node.unit || "seconds"}`] };
}

export async function runLimitNode({ node, input }) {
  const max = Math.max(0, Math.floor(Number(node.max) || 0));
  const field = String(node.field ?? "items").trim() || "items";
  const source = (input ?? {})[field];
  if (!Array.isArray(source)) throw new Error(`Limit found no array at "${field}"`);
  const kept = source.slice(0, max);
  return {
    json: { ...(input ?? {}), [field]: kept },
    ...zero(),
    logs: [`${field}: kept ${kept.length} of ${source.length} item${source.length === 1 ? "" : "s"}`],
  };
}

export async function runNoOpNode({ input }) {
  return { json: { ...(input ?? {}) }, ...zero(), logs: ["passed the input through"] };
}

export async function runStopNode({ node, input }) {
  const message = String(renderTemplate(node.message ?? "", input) ?? "").trim() || "Workflow stopped by a Stop and Error node";
  throw new Error(message);
}
