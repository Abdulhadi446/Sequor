import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import * as db from "./db.js";
import * as security from "./security.js";
import * as engine from "./engine.js";
import * as credentials from "./credentials.js";
import * as auth from "./auth.js";
import * as knowledge from "./knowledge.js";
import * as agents from "./agents.js";
import { testAgent } from "./agent.js";
import { startScheduler } from "./scheduler.js";
import { TEMPLATES, getTemplate, templateMeta } from "./templates.js";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, "..", "public");
const parsedPort = Number.parseInt(process.env.PORT ?? "", 10);
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 3000;
const HOST = process.env.HOST || "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const notFound = () => new HttpError(404, "Not found");

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
}

// Browsers send Origin on cross-site writes; reject anything that is not this
// host so a session cookie cannot be driven from another site. Sec-Fetch-Site
// catches the same case when a client omits Origin.
function assertSameOrigin(req) {
  const site = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
  if (site === "cross-site" || site === "same-site") {
    throw new HttpError(403, "Cross-origin request blocked");
  }
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    if (new URL(origin).host !== req.headers.host) {
      throw new HttpError(403, "Cross-origin request blocked");
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(403, "Cross-origin request blocked");
  }
}

function limitOrThrow(key, limit, windowMs, message = "Too many requests. Try again shortly.") {
  const result = security.rateLimit(key, limit, windowMs);
  if (result.ok) return;
  const error = new HttpError(429, message);
  error.retryAfter = result.retryAfter;
  throw error;
}

const NODE_TYPES = new Set([
  "trigger",
  "agent",
  "check",
  "http",
  "fetch",
  "mcp",
  "bash",
  "code",
  "rag",
  "if",
  "switch",
  "filter",
  "merge",
  "set",
  "wait",
  "limit",
  "noop",
  "stop",
]);

function validateGraph(graph) {
  if (!graph || typeof graph !== "object") throw new HttpError(400, "graph is required");
  if (!Array.isArray(graph.nodes)) throw new HttpError(400, "graph.nodes must be an array");
  if (!Array.isArray(graph.edges)) throw new HttpError(400, "graph.edges must be an array");

  const ids = new Set();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== "string" || !node.id) throw new HttpError(400, "every node needs an id");
    if (ids.has(node.id)) throw new HttpError(400, `duplicate node id: ${node.id}`);
    if (!NODE_TYPES.has(node.type)) {
      throw new HttpError(400, `node ${node.id} has an unsupported type: ${node.type}`);
    }
    if (!security.execAllowed && (node.type === "bash" || node.type === "code")) {
      throw new HttpError(
        400,
        `${node.type} nodes are disabled on this server. Set SEQUOR_ALLOW_EXEC=1 to allow shell and JavaScript nodes.`,
      );
    }
    ids.add(node.id);
  }
  for (const edge of graph.edges) {
    if (!edge || !ids.has(edge.from) || !ids.has(edge.to)) {
      throw new HttpError(400, `edge references a missing node: ${edge?.from} -> ${edge?.to}`);
    }
  }
  return graph;
}

function runPayload(runId, userId) {
  const run = db.getRun(runId, userId);
  if (!run) throw notFound();
  return { run, nodes: db.listRunNodes(runId) };
}

function streamRun(req, res, runId, userId) {
  const run = db.getRun(runId, userId);
  if (!run) throw notFound();

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const write = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  write({ type: "snapshot", ...runPayload(runId, userId) });

  const unsubscribe = engine.subscribeRun(runId, write);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

// A forged Host header must not end up inside a generated webhook URL.
const origin = (req) => {
  const raw = String(req.headers.host || "");
  const host = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i.test(raw) ? raw : `127.0.0.1:${PORT}`;
  const proto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return `${proto === "https" ? "https" : "http"}://${host}`;
};

function tokensMatch(candidate, expected) {
  const a = Buffer.from(String(candidate ?? ""));
  const b = Buffer.from(String(expected ?? ""));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

const authPayload = (user) => ({ id: user.id, name: user.name, email: user.email, createdAt: user.createdAt });

// Runs handle their own auth: a per-workflow hook token, no session required.
async function handleHook(req, res, url, workflowId) {
  const workflow = db.getWorkflowAny(workflowId);
  if (!workflow) throw notFound();
  const token = url.searchParams.get("token") || req.headers["x-sequor-token"];
  if (!tokensMatch(token, workflow.hookToken)) {
    throw new HttpError(401, "Invalid or missing webhook token.");
  }
  limitOrThrow(`hook:${workflow.id}:${security.clientIp(req)}`, 60, 60_000, "This webhook is being called too often.");
  const body = await readBody(req);
  const result = engine.startRun({ workflow, input: body ?? {}, trigger: "webhook" });
  return sendJson(res, result.error ? 400 : 202, {
    runId: result.runId,
    error: result.error ?? null,
  });
}

async function handleAuth(req, res, url, parts) {
  const method = req.method ?? "GET";

  if (parts[1] === "session" && parts.length === 2 && method === "GET") {
    const user = auth.currentUser(req);
    const accounts = db.countUsers();
    return sendJson(res, 200, {
      user: user ? authPayload(user) : null,
      needsSetup: accounts === 0,
      signup: security.signupMode,
      signupOpen: security.signupOpen(accounts),
      legacy: db.listAllWorkflows().filter((workflow) => !workflow.userId).length,
    });
  }

  if (parts[1] === "signup" && method === "POST") {
    assertSameOrigin(req);
    limitOrThrow(`signup:${security.clientIp(req)}`, 5, 60 * 60 * 1000, "Too many accounts from this address. Try again later.");
    if (!security.signupOpen(db.countUsers())) {
      throw new HttpError(
        403,
        "Sign-ups are closed on this server. Ask the owner for an account, or start it with SEQUOR_SIGNUP=open.",
      );
    }
    const body = await readBody(req);
    const user = await auth.createAccount(body);
    db.claimOrphanedRows(user.id);
    if (!db.listWorkflows(user.id).length) {
      const template = TEMPLATES[0];
      db.createWorkflow({
        userId: user.id,
        name: template.name,
        description: template.description,
        graph: structuredClone(template.graph),
      });
    }
    const token = auth.startSession(user.id, req.headers["user-agent"]);
    auth.setSessionCookie(req, res, token);
    return sendJson(res, 201, { user: authPayload(user) });
  }

  if (parts[1] === "login" && method === "POST") {
    assertSameOrigin(req);
    limitOrThrow(`login:${security.clientIp(req)}`, 20, 5 * 60 * 1000, "Too many sign-in attempts from this address.");
    const body = await readBody(req);
    const user = await auth.login({
      email: body.email,
      password: body.password,
      ip: security.clientIp(req),
    });
    const token = auth.startSession(user.id, req.headers["user-agent"]);
    auth.setSessionCookie(req, res, token);
    return sendJson(res, 200, { user: authPayload(user) });
  }

  if (parts[1] === "logout" && method === "POST") {
    assertSameOrigin(req);
    auth.endSession(req);
    auth.clearSessionCookie(req, res);
    return sendJson(res, 200, { ok: true });
  }

  throw notFound();
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean).slice(1);
  const method = req.method ?? "GET";

  limitOrThrow(`api:${security.clientIp(req)}`, 900, 60_000);

  if (parts[0] === "auth") return handleAuth(req, res, url, parts);

  if (parts[0] === "workflows" && parts.length === 3 && parts[2] === "hook" && method === "POST") {
    assertSameOrigin(req);
    return handleHook(req, res, url, parts[1]);
  }

  if (!["GET", "HEAD"].includes(method)) assertSameOrigin(req);
  const user = auth.requireUser(req);

  if (parts[0] === "state" && parts.length === 1 && method === "GET") {
    const env = credentials.envStatus();
    return sendJson(res, 200, {
      user: authPayload(user),
      workflows: db.listWorkflows(user.id),
      templates: templateMeta(),
      credentials: credentials.listCredentials(user.id),
      providers: credentials.PROVIDERS,
      env,
      knowledge: knowledge.listKnowledgeBases(user.id),
      agents: agents.listAgents(user.id),
      builtinTools: agents.BUILTIN_TOOLS,
      capabilities: security.describePolicy(),
      agent: {
        runtime: "Sequor tool loop · OpenAI-compatible chat completions",
        defaultModel: env.model || "provider credential default",
        tools: ["knowledge_search", "remember"],
      },
    });
  }

  // ---- credentials -------------------------------------------------------
  if (parts[0] === "credentials" && parts.length === 1) {
    if (method === "GET") return sendJson(res, 200, { credentials: credentials.listCredentials(user.id) });
    if (method === "POST") {
      const body = await readBody(req);
      try {
        const credential = credentials.createCredential(body, user.id);
        return sendJson(res, 201, { credential });
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    }
  }

  if (parts[0] === "credentials" && parts.length === 3 && method === "POST" && parts[2] === "test") {
    const result = await credentials.testCredential(parts[1], user.id);
    return sendJson(res, 200, result);
  }

  if (parts[0] === "credentials" && parts.length === 2 && method === "DELETE") {
    credentials.deleteCredential(parts[1], user.id);
    return sendJson(res, 200, { ok: true });
  }

  // ---- workflows ---------------------------------------------------------
  if (parts[0] === "workflows" && parts.length === 1) {
    if (method === "GET") return sendJson(res, 200, { workflows: db.listWorkflows(user.id) });
    if (method === "POST") {
      const body = await readBody(req);
      const graph = body.graph ? validateGraph(body.graph) : { nodes: [], edges: [] };
      const workflow = db.createWorkflow({
        userId: user.id,
        name: body.name,
        description: body.description,
        graph,
      });
      return sendJson(res, 201, { workflow });
    }
  }

  if (parts[0] === "workflows" && parts.length === 2) {
    const id = parts[1];
    if (method === "GET") {
      const workflow = db.getWorkflow(id, user.id);
      if (!workflow) throw notFound();
      return sendJson(res, 200, { workflow });
    }
    if (method === "PUT") {
      const body = await readBody(req);
      if (!db.getWorkflow(id, user.id)) throw notFound();
      const patch = {};
      if (body.name !== undefined) patch.name = String(body.name).slice(0, 160) || "Untitled workflow";
      if (body.description !== undefined) patch.description = String(body.description);
      if (body.graph !== undefined) patch.graph = validateGraph(body.graph);
      if (body.active !== undefined) patch.active = Boolean(body.active);
      const workflow = db.updateWorkflow(id, user.id, patch);
      return sendJson(res, 200, { workflow });
    }
    if (method === "DELETE") {
      if (!db.getWorkflow(id, user.id)) throw notFound();
      db.deleteWorkflow(id, user.id);
      return sendJson(res, 200, { ok: true });
    }
  }

  if (parts[0] === "workflows" && parts.length === 3 && method === "POST" && parts[2] === "hook-token") {
    const token = db.rotateHookToken(parts[1], user.id);
    if (!token) throw notFound();
    return sendJson(res, 200, {
      hookToken: token,
      webhook: `${origin(req)}/api/workflows/${parts[1]}/hook?token=${token}`,
    });
  }

  if (parts[0] === "workflows" && parts.length === 3 && method === "POST" && parts[2] === "run") {
    const workflow = db.getWorkflow(parts[1], user.id);
    if (!workflow) throw notFound();
    const body = await readBody(req);
    const input = body.input && typeof body.input === "object" ? body.input : {};
    const result = engine.startRun({ workflow, input, trigger: "manual" });
    const payload = runPayload(result.runId, user.id);
    return sendJson(res, result.error ? 400 : 202, { ...payload, error: result.error ?? null });
  }

  // ---- runs --------------------------------------------------------------
  if (parts[0] === "runs" && parts.length === 1 && method === "GET") {
    const workflowId = url.searchParams.get("workflowId") ?? undefined;
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 60));
    return sendJson(res, 200, { runs: db.listRuns(workflowId, user.id, limit) });
  }

  if (parts[0] === "runs" && parts.length === 2 && method === "GET") {
    return sendJson(res, 200, runPayload(parts[1], user.id));
  }

  if (parts[0] === "runs" && parts.length === 3 && method === "GET" && parts[2] === "events") {
    return streamRun(req, res, parts[1], user.id);
  }

  if (parts[0] === "runs" && parts.length === 3 && method === "POST") {
    const runId = parts[1];
    const action = parts[2];
    if (action === "cancel") {
      if (!db.getRun(runId, user.id)) throw notFound();
      const cancelled = engine.cancelRun(runId);
      return sendJson(res, 200, { cancelled, ...runPayload(runId, user.id) });
    }
    if (action === "resume") {
      const result = engine.resumeRun(runId, user.id);
      if (!result) throw notFound();
      return sendJson(res, 202, { ...runPayload(result.runId, user.id), error: result.error ?? null });
    }
  }

  // ---- agents ------------------------------------------------------------
  if (parts[0] === "agents" && parts.length === 1) {
    if (method === "GET") return sendJson(res, 200, { agents: agents.listAgents(user.id) });
    if (method === "POST") {
      const body = await readBody(req);
      try {
        return sendJson(res, 201, { agent: agents.createAgent(user.id, body) });
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    }
  }

  if (parts[0] === "agents" && parts.length === 2 && parts[1] === "import" && method === "POST") {
    const body = await readBody(req);
    try {
      const result = agents.importOpencodeConfig(user.id, body.config, {
        name: body.name,
        files: Array.isArray(body.files) ? body.files : [],
      });
      return sendJson(res, 201, result);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  }

  if (parts[0] === "agents" && parts.length === 3 && parts[2] === "test" && method === "POST") {
    const agent = agents.getAgent(parts[1], user.id);
    if (!agent) throw notFound();
    try {
      return sendJson(res, 200, await testAgent({ agent, userId: user.id }));
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  }

  if (parts[0] === "agents" && parts.length === 2) {
    const id = parts[1];
    if (method === "GET") {
      const agent = agents.getAgent(id, user.id);
      if (!agent) throw notFound();
      return sendJson(res, 200, { agent });
    }
    if (method === "PUT") {
      const body = await readBody(req);
      const existing = agents.getAgent(id, user.id);
      if (!existing) throw notFound();
      const agent = agents.updateAgent(id, user.id, { ...existing, ...body });
      return sendJson(res, 200, { agent });
    }
    if (method === "DELETE") {
      if (!agents.deleteAgent(id, user.id)) throw notFound();
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- knowledge bases ---------------------------------------------------
  if (parts[0] === "knowledge" && parts.length === 1) {
    if (method === "GET") {
      return sendJson(res, 200, { knowledge: knowledge.listKnowledgeBases(user.id) });
    }
    if (method === "POST") {
      const body = await readBody(req);
      try {
        const knowledgeBase = knowledge.createKnowledgeBase({
          userId: user.id,
          name: body.name,
          description: body.description,
          backend: body.backend,
          model: body.model,
          credentialId: body.credentialId,
        });
        return sendJson(res, 201, { knowledgeBase });
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    }
  }

  if (parts[0] === "knowledge" && parts.length === 2 && method === "DELETE") {
    const removed = knowledge.deleteKnowledgeBase(parts[1], user.id);
    if (!removed) throw notFound();
    return sendJson(res, 200, { ok: true });
  }

  if (parts[0] === "knowledge" && parts.length === 3 && parts[2] === "documents") {
    if (method === "GET") {
      if (!db.getKnowledgeBase(parts[1], user.id)) throw notFound();
      return sendJson(res, 200, { documents: knowledge.listDocuments(user.id, parts[1]) });
    }
    if (method === "POST") {
      const body = await readBody(req);
      try {
        const result = await knowledge.addDocument({
          userId: user.id,
          kbId: parts[1],
          title: body.title,
          text: body.text,
          source: body.source,
        });
        return sendJson(res, 201, result);
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    }
  }

  if (parts[0] === "knowledge" && parts.length === 4 && parts[2] === "documents" && method === "DELETE") {
    const removed = knowledge.deleteDocument(parts[3], user.id);
    if (!removed) throw notFound();
    return sendJson(res, 200, { ok: true });
  }

  if (parts[0] === "knowledge" && parts.length === 3 && parts[2] === "search" && method === "GET") {
    if (!db.getKnowledgeBase(parts[1], user.id)) throw notFound();
    const query = url.searchParams.get("q") ?? "";
    const topK = Number(url.searchParams.get("k")) || 5;
    const result = await knowledge.searchKnowledge({ userId: user.id, kbIds: [parts[1]], query, topK });
    return sendJson(res, 200, result);
  }

  // ---- workspace memory --------------------------------------------------
  if (parts[0] === "memory" && parts.length === 1 && method === "GET") {
    const workflowId = url.searchParams.get("workflowId") ?? null;
    const limit = Number(url.searchParams.get("limit")) || 60;
    const memories = knowledge
      .listMemories(user.id, { workflowId, limit })
      .map(({ embedding, userId: owner, ...rest }) => rest);
    return sendJson(res, 200, { memories });
  }

  if (parts[0] === "memory" && parts.length === 2 && method === "DELETE") {
    const removed = knowledge.deleteMemory(parts[1], user.id);
    if (!removed) throw notFound();
    return sendJson(res, 200, { ok: true });
  }

  // ---- templates ---------------------------------------------------------
  if (parts[0] === "templates" && parts.length === 1 && method === "GET") {
    return sendJson(res, 200, { templates: templateMeta() });
  }

  if (parts[0] === "templates" && parts.length === 2 && method === "POST") {
    const template = getTemplate(parts[1]);
    if (!template) throw notFound();
    const workflow = db.createWorkflow({
      userId: user.id,
      name: template.name,
      description: template.description,
      graph: structuredClone(template.graph),
    });
    return sendJson(res, 201, { workflow });
  }

  throw notFound();
}

async function serveStatic(res, pathname) {
  let relative = decodeURIComponent(pathname);
  const looksLikeFile = extname(relative) !== "";
  if (relative === "/" || relative === "") relative = "/index.html";
  let filePath = normalize(join(PUBLIC_DIR, relative));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("Forbidden");
    return;
  }
  // Client-side routes use the n8n shape: /workflow/<id>, /executions,
  // /credentials, /knowledge. Anything that is not a real file falls back to
  // the app shell so a refresh on a deep link works.
  if (!looksLikeFile && !existsSync(filePath)) {
    filePath = join(PUBLIC_DIR, "index.html");
  }
  if (!existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  const data = await readFile(filePath);
  res.writeHead(200, {
    "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
    "cache-control": "no-cache",
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  security.securityHeaders(req, res);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("Method not allowed");
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = err?.status ?? (err instanceof HttpError ? err.status : 500);
    if (status >= 500) console.error(`[sequor] ${req.method} ${url.pathname} failed:`, err);
    if (err?.retryAfter) res.setHeader("retry-after", String(err.retryAfter));
    // 5xx messages can carry paths, SQL and stack details; keep those in the log.
    const message = status >= 500 ? "Internal server error" : err.message || "Unexpected error";
    sendJson(res, status, { error: message });
  }
});

// Bound the time a client may take to send a request, and the number of
// headers it may send. SSE responses are unaffected (they are responses).
server.headersTimeout = 20_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 10_000;
server.maxHeadersCount = 100;

auth.purgeExpiredSessions();
const recovered = db.failStaleRuns();
if (recovered) console.log(`Marked ${recovered} execution${recovered === 1 ? "" : "s"} interrupted by the last shutdown as failed.`);

server.listen(PORT, HOST, () => {
  const env = credentials.envStatus();
  console.log(`Sequor listening on http://${HOST}:${PORT}`);
  console.log(`Accounts: ${db.countUsers()} · ${env.configured ? "environment model key configured" : "no environment key"}`);
  if (db.countUsers() === 0) {
    const legacy = db.listAllWorkflows().length;
    console.log(
      legacy
        ? `First account will adopt ${legacy} existing workflow${legacy === 1 ? "" : "s"} and their credentials.`
        : "Create the first account in the browser to get started.",
    );
  }
  const policy = security.describePolicy();
  console.log(
    `Security: ${policy.exposed ? "public" : "loopback"} · shell/JS nodes ${policy.exec ? "enabled" : "disabled"} · ` +
      `private network ${policy.privateNetwork ? "reachable" : "blocked"} · sign-ups ${policy.signup}`,
  );
  if (policy.exposed && policy.exec) {
    console.warn(
      "[sequor] Warning: shell and JavaScript nodes are enabled on a public server. Anyone with an account can run commands as this user.",
    );
  }
  if (policy.exposed && policy.signup !== "first-user" && policy.signup !== "closed") {
    console.warn(`[sequor] Warning: sign-ups are "${policy.signup}" on a public server.`);
  }
  startScheduler();
});
