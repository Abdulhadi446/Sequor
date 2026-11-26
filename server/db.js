import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = process.env.SEQUOR_DB || join(root, "data", "sequor.db");
mkdirSync(dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  graph TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  hook_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  secret TEXT NOT NULL,
  hint TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',
  input TEXT NOT NULL DEFAULT '{}',
  graph TEXT NOT NULL,
  resume_of TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  cost REAL NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS run_nodes (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  title TEXT NOT NULL,
  node_type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  output TEXT,
  error TEXT,
  logs TEXT NOT NULL DEFAULT '[]',
  cost REAL NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, node_id)
);

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  embedding_backend TEXT NOT NULL DEFAULT 'local',
  embedding_model TEXT NOT NULL DEFAULT '',
  credential_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id TEXT PRIMARY KEY,
  kb_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY,
  kb_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  backend TEXT NOT NULL DEFAULT 'local',
  model TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  embedding TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workflow_id TEXT,
  run_id TEXT,
  node_id TEXT,
  kind TEXT NOT NULL DEFAULT 'action',
  text TEXT NOT NULL,
  embedding TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  credential_id TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  skills TEXT NOT NULL DEFAULT '[]',
  mcp_servers TEXT NOT NULL DEFAULT '[]',
  plugins TEXT NOT NULL DEFAULT '[]',
  tools TEXT NOT NULL DEFAULT '{}',
  workspace TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS runs_by_workflow ON runs(workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS agents_by_user ON agents(user_id, created_at ASC);
CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS knowledge_by_user ON knowledge_bases(user_id, created_at ASC);
CREATE INDEX IF NOT EXISTS documents_by_kb ON knowledge_documents(kb_id, created_at ASC);
CREATE INDEX IF NOT EXISTS chunks_by_kb ON knowledge_chunks(kb_id);
CREATE INDEX IF NOT EXISTS memories_by_user ON memories(user_id, created_at DESC);
`);

// Additive migrations for databases created by earlier builds.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn("workflows", "user_id", "TEXT");
ensureColumn("workflows", "active", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("workflows", "hook_token", "TEXT");
ensureColumn("credentials", "user_id", "TEXT");
ensureColumn("runs", "user_id", "TEXT");
ensureColumn("runs", "tokens_in", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("runs", "tokens_out", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("run_nodes", "tokens_in", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("run_nodes", "tokens_out", "INTEGER NOT NULL DEFAULT 0");

// Indexes on migrated columns can only be created once those columns exist.
db.exec(`
CREATE INDEX IF NOT EXISTS workflows_by_user ON workflows(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS credentials_by_user ON credentials(user_id);
CREATE INDEX IF NOT EXISTS runs_by_user ON runs(user_id, started_at DESC);
`);

// Give every existing workflow a webhook secret on first boot of this build.
db.exec("UPDATE workflows SET hook_token = lower(hex(randomblob(16))) WHERE hook_token IS NULL OR hook_token = '';");

function safeParse(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

const now = () => new Date().toISOString();

const statements = {
  countUsers: db.prepare("SELECT COUNT(*) AS n FROM users"),
  listUsers: db.prepare("SELECT * FROM users ORDER BY created_at ASC"),
  getUserById: db.prepare("SELECT * FROM users WHERE id = ?"),
  getUserByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  insertUser: db.prepare(
    "INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  ),

  insertSession: db.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
  ),
  getSessionByHash: db.prepare("SELECT * FROM sessions WHERE token_hash = ?"),
  deleteSession: db.prepare("DELETE FROM sessions WHERE id = ?"),
  deleteSessionByHash: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  deleteExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at < ?"),

  listWorkflows: db.prepare("SELECT * FROM workflows WHERE user_id = ? ORDER BY updated_at DESC"),
  listAllWorkflows: db.prepare("SELECT * FROM workflows ORDER BY updated_at DESC"),
  getWorkflow: db.prepare("SELECT * FROM workflows WHERE id = ? AND user_id = ?"),
  getWorkflowAny: db.prepare("SELECT * FROM workflows WHERE id = ?"),
  insertWorkflow: db.prepare(
    "INSERT INTO workflows (id, user_id, name, description, graph, active, hook_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ),
  updateWorkflow: db.prepare(
    "UPDATE workflows SET name = ?, description = ?, graph = ?, active = ?, updated_at = ? WHERE id = ? AND user_id = ?",
  ),
  setHookToken: db.prepare("UPDATE workflows SET hook_token = ? WHERE id = ? AND user_id = ?"),
  deleteWorkflow: db.prepare("DELETE FROM workflows WHERE id = ? AND user_id = ?"),

  listCredentials: db.prepare("SELECT * FROM credentials WHERE user_id = ? ORDER BY created_at ASC"),
  getCredential: db.prepare("SELECT * FROM credentials WHERE id = ? AND user_id = ?"),
  insertCredential: db.prepare(
    "INSERT INTO credentials (id, user_id, name, provider, base_url, model, secret, hint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ),
  deleteCredential: db.prepare("DELETE FROM credentials WHERE id = ? AND user_id = ?"),

  insertRun: db.prepare(`
    INSERT INTO runs (id, user_id, workflow_id, workflow_name, status, trigger, input, graph, resume_of, error, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  finishRun: db.prepare(`
    UPDATE runs SET status = ?, error = ?, cost = ?, duration_ms = ?, tokens_in = ?, tokens_out = ?, finished_at = ?
    WHERE id = ?
  `),
  getRun: db.prepare("SELECT * FROM runs WHERE id = ? AND user_id = ?"),
  getRunAny: db.prepare("SELECT * FROM runs WHERE id = ?"),
  listRuns: db.prepare(
    "SELECT * FROM runs WHERE workflow_id = ? AND user_id = ? ORDER BY started_at DESC LIMIT ?",
  ),
  listUserRuns: db.prepare("SELECT * FROM runs WHERE user_id = ? ORDER BY started_at DESC LIMIT ?"),
  lastRunAt: db.prepare("SELECT started_at FROM runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT 1"),
  listRunNodes: db.prepare("SELECT * FROM run_nodes WHERE run_id = ?"),
  listAgents: db.prepare("SELECT * FROM agents WHERE user_id = ? ORDER BY created_at ASC"),
  getAgent: db.prepare("SELECT * FROM agents WHERE id = ? AND user_id = ?"),
  insertAgent: db.prepare(`
    INSERT INTO agents (id, user_id, name, description, model, credential_id, system_prompt, skills, mcp_servers, plugins, tools, workspace, source, config, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateAgent: db.prepare(`
    UPDATE agents SET name = ?, description = ?, model = ?, credential_id = ?, system_prompt = ?,
      skills = ?, mcp_servers = ?, plugins = ?, tools = ?, workspace = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `),
  deleteAgent: db.prepare("DELETE FROM agents WHERE id = ? AND user_id = ?"),

  listKnowledgeBases: db.prepare(`
    SELECT kb.*,
      (SELECT COUNT(*) FROM knowledge_documents d WHERE d.kb_id = kb.id) AS documents,
      (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.kb_id = kb.id) AS chunks
    FROM knowledge_bases kb WHERE kb.user_id = ? ORDER BY kb.created_at ASC
  `),
  getKnowledgeBase: db.prepare(`
    SELECT kb.*,
      (SELECT COUNT(*) FROM knowledge_documents d WHERE d.kb_id = kb.id) AS documents,
      (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.kb_id = kb.id) AS chunks
    FROM knowledge_bases kb WHERE kb.id = ? AND kb.user_id = ?
  `),
  insertKnowledgeBase: db.prepare(
    "INSERT INTO knowledge_bases (id, user_id, name, description, embedding_backend, embedding_model, credential_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ),
  deleteKnowledgeBase: db.prepare("DELETE FROM knowledge_bases WHERE id = ? AND user_id = ?"),
  deleteChunksByBase: db.prepare("DELETE FROM knowledge_chunks WHERE kb_id = ? AND user_id = ?"),
  deleteDocumentsByBase: db.prepare("DELETE FROM knowledge_documents WHERE kb_id = ? AND user_id = ?"),

  listKnowledgeDocuments: db.prepare(
    "SELECT * FROM knowledge_documents WHERE user_id = ? AND kb_id = ? ORDER BY created_at ASC",
  ),
  getKnowledgeDocument: db.prepare("SELECT * FROM knowledge_documents WHERE id = ? AND user_id = ?"),
  insertKnowledgeDocument: db.prepare(
    "INSERT INTO knowledge_documents (id, kb_id, user_id, title, source, text, chunk_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ),
  deleteKnowledgeDocument: db.prepare("DELETE FROM knowledge_documents WHERE id = ? AND user_id = ?"),
  deleteChunksByDocument: db.prepare("DELETE FROM knowledge_chunks WHERE doc_id = ? AND user_id = ?"),
  insertKnowledgeChunk: db.prepare(
    "INSERT INTO knowledge_chunks (id, kb_id, doc_id, user_id, ord, backend, model, text, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ),

  insertMemory: db.prepare(
    "INSERT INTO memories (id, user_id, workflow_id, run_id, node_id, kind, text, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ),
  listMemories: db.prepare(
    "SELECT * FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
  ),
  listWorkflowMemories: db.prepare(
    "SELECT * FROM memories WHERE user_id = ? AND workflow_id = ? ORDER BY created_at DESC LIMIT ?",
  ),
  deleteMemory: db.prepare("DELETE FROM memories WHERE id = ? AND user_id = ?"),

  upsertRunNode: db.prepare(`
    INSERT INTO run_nodes (run_id, node_id, title, node_type, status, attempts, output, error, logs, cost, tokens_in, tokens_out, duration_ms, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, node_id) DO UPDATE SET
      title = excluded.title,
      node_type = excluded.node_type,
      status = excluded.status,
      attempts = excluded.attempts,
      output = excluded.output,
      error = excluded.error,
      logs = excluded.logs,
      cost = excluded.cost,
      tokens_in = excluded.tokens_in,
      tokens_out = excluded.tokens_out,
      duration_ms = excluded.duration_ms,
      updated_at = excluded.updated_at
  `),
};

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    createdAt: row.created_at,
  };
}

function mapWorkflow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id ?? null,
    name: row.name,
    description: row.description ?? "",
    graph: safeParse(row.graph, { nodes: [], edges: [] }),
    active: Boolean(row.active),
    hookToken: row.hook_token ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id ?? null,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    status: row.status,
    trigger: row.trigger,
    input: safeParse(row.input, {}),
    graph: safeParse(row.graph, { nodes: [], edges: [] }),
    resumeOf: row.resume_of ?? null,
    error: row.error ?? null,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    cost: row.cost ?? 0,
    tokensIn: row.tokens_in ?? 0,
    tokensOut: row.tokens_out ?? 0,
    durationMs: row.duration_ms ?? null,
  };
}

function mapKnowledgeBase(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description ?? "",
    embeddingBackend: row.embedding_backend === "remote" ? "remote" : "local",
    embeddingModel: row.embedding_model ?? "",
    credentialId: row.credential_id ?? "",
    documents: row.documents ?? 0,
    chunks: row.chunks ?? 0,
    createdAt: row.created_at,
  };
}

function mapKnowledgeDocument(row) {
  if (!row) return null;
  return {
    id: row.id,
    kbId: row.kb_id,
    userId: row.user_id,
    title: row.title,
    source: row.source ?? "",
    text: row.text,
    chunkCount: row.chunk_count ?? 0,
    createdAt: row.created_at,
  };
}

function mapChunk(row) {
  return {
    id: row.id,
    kbId: row.kb_id,
    docId: row.doc_id,
    title: row.title ?? "",
    ord: row.ord ?? 0,
    backend: row.backend ?? "local",
    model: row.model ?? "",
    text: row.text,
    embedding: safeParse(row.embedding, []),
  };
}

function mapMemory(row) {
  return {
    id: row.id,
    userId: row.user_id,
    workflowId: row.workflow_id ?? null,
    runId: row.run_id ?? null,
    nodeId: row.node_id ?? null,
    kind: row.kind ?? "action",
    text: row.text,
    embedding: safeParse(row.embedding, []),
    createdAt: row.created_at,
  };
}

function mapRunNode(row) {
  return {
    nodeId: row.node_id,
    title: row.title,
    nodeType: row.node_type,
    status: row.status,
    attempts: row.attempts ?? 0,
    output: safeParse(row.output, null),
    error: row.error ?? null,
    logs: safeParse(row.logs, []),
    cost: row.cost ?? 0,
    tokensIn: row.tokens_in ?? 0,
    tokensOut: row.tokens_out ?? 0,
    durationMs: row.duration_ms ?? null,
  };
}

function mapCredential(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id ?? null,
    name: row.name,
    provider: row.provider,
    baseUrl: row.base_url,
    model: row.model ?? "",
    secret: row.secret,
    hint: row.hint ?? "",
    createdAt: row.created_at,
  };
}

// ---- users ---------------------------------------------------------------

export function countUsers() {
  return statements.countUsers.get().n;
}

export function listUsers() {
  return statements.listUsers.all().map(mapUser);
}

export function getUserById(id) {
  return mapUser(statements.getUserById.get(id));
}

export function getUserByEmail(email) {
  return mapUser(statements.getUserByEmail.get(String(email).toLowerCase()));
}

export function createUser({ name, email, passwordHash }) {
  const id = randomUUID();
  const stamp = now();
  statements.insertUser.run(id, name, String(email).toLowerCase(), passwordHash, stamp);
  return getUserById(id);
}

export function getPasswordHash(userId) {
  return statements.getUserById.get(userId)?.password_hash ?? null;
}

// ---- sessions ------------------------------------------------------------

export function createSession({ userId, tokenHash, expiresAt, userAgent }) {
  statements.insertSession.run(randomUUID(), userId, tokenHash, now(), expiresAt, userAgent ?? null);
}

export function getSessionByHash(tokenHash) {
  const row = statements.getSessionByHash.get(tokenHash);
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export function deleteSession(id) {
  statements.deleteSession.run(id);
}

export function deleteSessionByHash(tokenHash) {
  statements.deleteSessionByHash.run(tokenHash);
}

export function deleteExpiredSessions() {
  statements.deleteExpiredSessions.run(now());
}

// ---- workflows -----------------------------------------------------------

export function listWorkflows(userId) {
  return statements.listWorkflows.all(userId).map(mapWorkflow);
}

export function listAllWorkflows() {
  return statements.listAllWorkflows.all().map(mapWorkflow);
}

export function getWorkflow(id, userId) {
  return mapWorkflow(statements.getWorkflow.get(id, userId));
}

export function getWorkflowAny(id) {
  return mapWorkflow(statements.getWorkflowAny.get(id));
}

function newHookToken() {
  return randomBytes(16).toString("hex");
}

export function createWorkflow({
  userId = null,
  name,
  description = "",
  graph = { nodes: [], edges: [] },
  active = false,
}) {
  const id = randomUUID();
  const stamp = now();
  statements.insertWorkflow.run(
    id,
    userId,
    name || "Untitled workflow",
    description,
    JSON.stringify(graph),
    active ? 1 : 0,
    newHookToken(),
    stamp,
    stamp,
  );
  return getWorkflow(id, userId);
}

export function updateWorkflow(id, userId, { name, description, graph, active }) {
  const existing = getWorkflow(id, userId);
  if (!existing) return null;
  statements.updateWorkflow.run(
    name ?? existing.name,
    description ?? existing.description,
    graph ? JSON.stringify(graph) : JSON.stringify(existing.graph),
    active == null ? (existing.active ? 1 : 0) : active ? 1 : 0,
    now(),
    id,
    userId,
  );
  return getWorkflow(id, userId);
}

export function rotateHookToken(id, userId) {
  const token = newHookToken();
  const result = statements.setHookToken.run(token, id, userId);
  if (!result.changes) return null;
  return token;
}

export function deleteWorkflow(id, userId) {
  db.prepare("DELETE FROM runs WHERE workflow_id = ? AND user_id = ?").run(id, userId);
  statements.deleteWorkflow.run(id, userId);
}

// The first account adopts everything created before accounts existed.
export function claimOrphanedRows(userId) {
  const workflows = db.prepare("UPDATE workflows SET user_id = ? WHERE user_id IS NULL").run(userId);
  db.prepare("UPDATE credentials SET user_id = ? WHERE user_id IS NULL").run(userId);
  db.prepare("UPDATE runs SET user_id = ? WHERE user_id IS NULL").run(userId);
  return workflows.changes ?? 0;
}

// ---- credentials ---------------------------------------------------------

export function listCredentials(userId) {
  return statements.listCredentials.all(userId).map(mapCredential);
}

export function getCredential(id, userId) {
  return mapCredential(statements.getCredential.get(id, userId));
}

export function createCredential({ userId, name, provider, baseUrl, model, secret, hint }) {
  const id = randomUUID();
  statements.insertCredential.run(id, userId, name, provider, baseUrl, model ?? "", secret, hint ?? "", now());
  return getCredential(id, userId);
}


export function deleteCredential(id, userId) {
  statements.deleteCredential.run(id, userId);
}

// The scheduler runs workflows for every account.
export function listActiveWorkflows() {
  return db
    .prepare("SELECT * FROM workflows WHERE active = 1 AND hook_token IS NOT NULL")
    .all()
    .map(mapWorkflow);
}

// ---- runs ----------------------------------------------------------------

export function insertRun({
  id,
  userId,
  workflowId,
  workflowName,
  status,
  trigger,
  input,
  graph,
  resumeOf,
  error,
  startedAt,
}) {
  statements.insertRun.run(
    id,
    userId ?? null,
    workflowId,
    workflowName,
    status,
    trigger,
    JSON.stringify(input ?? {}),
    JSON.stringify(graph ?? { nodes: [], edges: [] }),
    resumeOf ?? null,
    error ?? null,
    startedAt,
  );
}

export function finishRun(id, status, error, cost, durationMs, tokensIn = 0, tokensOut = 0) {
  statements.finishRun.run(
    status,
    error ?? null,
    cost ?? 0,
    durationMs ?? null,
    tokensIn ?? 0,
    tokensOut ?? 0,
    now(),
    id,
  );
}

export function getRun(id, userId) {
  return mapRun(statements.getRun.get(id, userId));
}

export function getRunAny(id) {
  return mapRun(statements.getRunAny.get(id));
}

export function listRuns(workflowId, userId, limit = 30) {
  const rows = workflowId
    ? statements.listRuns.all(workflowId, userId, limit)
    : statements.listUserRuns.all(userId, limit);
  return rows.map(mapRun);
}

export function lastRunAt(workflowId) {
  return statements.lastRunAt.get(workflowId)?.started_at ?? null;
}

export function listRunNodes(runId) {
  return statements.listRunNodes.all(runId).map(mapRunNode);
}

// A process that died mid-run leaves rows marked running forever. The engine
// keeps active runs in memory only, so at boot nothing can still be running.
export function failStaleRuns(message = "The server restarted while this execution was running.") {
  return db
    .prepare(
      "UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE status = 'running'",
    )
    .run(message, now()).changes ?? 0;
}

// ---- agents ---------------------------------------------------------------

export function listAgents(userId) {
  return statements.listAgents.all(userId);
}

export function getAgent(id, userId) {
  return statements.getAgent.get(id, userId) ?? null;
}

export function createAgent({
  userId,
  name,
  description = "",
  model = "",
  credentialId = "",
  systemPrompt = "",
  skills = [],
  mcpServers = [],
  plugins = [],
  tools = {},
  workspace = "",
  source = "manual",
  config = {},
}) {
  const id = randomUUID();
  const stamp = now();
  statements.insertAgent.run(
    id,
    userId,
    name,
    description,
    model,
    credentialId,
    systemPrompt,
    JSON.stringify(skills),
    JSON.stringify(mcpServers),
    JSON.stringify(plugins),
    JSON.stringify(tools),
    workspace,
    source,
    JSON.stringify(config),
    stamp,
    stamp,
  );
  return getAgent(id, userId);
}

export function updateAgent(id, userId, patch) {
  statements.updateAgent.run(
    patch.name,
    patch.description ?? "",
    patch.model ?? "",
    patch.credentialId ?? "",
    patch.systemPrompt ?? "",
    JSON.stringify(patch.skills ?? []),
    JSON.stringify(patch.mcpServers ?? []),
    JSON.stringify(patch.plugins ?? []),
    JSON.stringify(patch.tools ?? {}),
    patch.workspace ?? "",
    now(),
    id,
    userId,
  );
  return getAgent(id, userId);
}

export function deleteAgent(id, userId) {
  return (statements.deleteAgent.run(id, userId).changes ?? 0) > 0;
}

// ---- knowledge bases ------------------------------------------------------

export function listKnowledgeBases(userId) {
  return statements.listKnowledgeBases.all(userId).map(mapKnowledgeBase);
}

export function getKnowledgeBase(id, userId) {
  return mapKnowledgeBase(statements.getKnowledgeBase.get(id, userId));
}

export function createKnowledgeBase({
  userId,
  name,
  description = "",
  embeddingBackend = "local",
  embeddingModel = "",
  credentialId = "",
}) {
  const id = randomUUID();
  statements.insertKnowledgeBase.run(
    id,
    userId,
    name,
    description,
    embeddingBackend,
    embeddingModel,
    credentialId ?? "",
    now(),
  );
  return getKnowledgeBase(id, userId);
}

export function deleteKnowledgeBase(id, userId) {
  statements.deleteChunksByBase.run(id, userId);
  statements.deleteDocumentsByBase.run(id, userId);
  return (statements.deleteKnowledgeBase.run(id, userId).changes ?? 0) > 0;
}

export function listKnowledgeDocuments(userId, kbId) {
  return statements.listKnowledgeDocuments.all(userId, kbId).map(mapKnowledgeDocument);
}

export function getKnowledgeDocument(id, userId) {
  return mapKnowledgeDocument(statements.getKnowledgeDocument.get(id, userId));
}

export function insertKnowledgeDocument({ userId, kbId, title, source, text, chunkCount }) {
  const id = randomUUID();
  statements.insertKnowledgeDocument.run(id, kbId, userId, title, source ?? "", text, chunkCount ?? 0, now());
  return getKnowledgeDocument(id, userId);
}

export function deleteKnowledgeDocument(id, userId) {
  statements.deleteChunksByDocument.run(id, userId);
  return (statements.deleteKnowledgeDocument.run(id, userId).changes ?? 0) > 0;
}

export function insertKnowledgeChunks(chunks) {
  const stamp = now();
  for (const chunk of chunks) {
    statements.insertKnowledgeChunk.run(
      randomUUID(),
      chunk.kbId,
      chunk.docId,
      chunk.userId,
      chunk.ord ?? 0,
      chunk.backend ?? "local",
      chunk.model ?? "",
      chunk.text,
      JSON.stringify(chunk.embedding ?? []),
      stamp,
    );
  }
}

export function listKnowledgeChunks(userId, kbIds) {
  const ids = (kbIds ?? []).filter(Boolean);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT c.*, d.title FROM knowledge_chunks c
       LEFT JOIN knowledge_documents d ON d.id = c.doc_id
       WHERE c.user_id = ? AND c.kb_id IN (${placeholders})`,
    )
    .all(userId, ...ids)
    .map(mapChunk);
}

// ---- memory ---------------------------------------------------------------

export function insertMemory({ userId, workflowId, runId, nodeId, kind, text, embedding }) {
  const id = randomUUID();
  statements.insertMemory.run(
    id,
    userId,
    workflowId ?? null,
    runId ?? null,
    nodeId ?? null,
    kind ?? "action",
    text,
    JSON.stringify(embedding ?? []),
    now(),
  );
  const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
  return mapMemory(row);
}

export function listMemories(userId, workflowId, limit = 40) {
  const rows = workflowId
    ? statements.listWorkflowMemories.all(userId, workflowId, limit)
    : statements.listMemories.all(userId, limit);
  return rows.map(mapMemory);
}

export function deleteMemory(id, userId) {
  return (statements.deleteMemory.run(id, userId).changes ?? 0) > 0;
}

export function upsertRunNode({
  runId,
  nodeId,
  title,
  nodeType,
  status,
  attempts,
  output,
  error,
  logs,
  cost,
  tokensIn,
  tokensOut,
  durationMs,
}) {
  statements.upsertRunNode.run(
    runId,
    nodeId,
    title ?? nodeType ?? "node",
    nodeType ?? "agent",
    status,
    attempts ?? 0,
    output ?? null,
    error ?? null,
    JSON.stringify(logs ?? []),
    cost ?? 0,
    tokensIn ?? 0,
    tokensOut ?? 0,
    durationMs ?? null,
    now(),
  );
}
