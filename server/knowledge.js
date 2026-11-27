// Knowledge bases and workspace memory.
//
// Two layers, both real and both queryable:
//   * knowledge bases: documents you add, chunked and embedded, searched by
//     cosine similarity. Embeddings come from an OpenAI-compatible /embeddings
//     endpoint when a credential is chosen, otherwise a deterministic local
//     hashed embedding so retrieval works with no provider at all.
//   * workspace memory: every node that runs writes one line about what it did.
//     Agents read the recent log plus the semantically closest older lines, so
//     a later step knows what earlier steps (and earlier runs) already did.

import { randomUUID } from "node:crypto";
import * as db from "./db.js";
import { credentialAllowsPrivate, resolveForNode } from "./credentials.js";
import { renderText } from "./template.js";
import { assertSafeUrl, safeFetch } from "./security.js";

const LOCAL_MODEL = "hashed-256";
const LOCAL_DIM = 256;
const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 150;

function hashToken(token) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index++) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalize(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (!norm) return vector;
  return vector.map((value) => Number((value / norm).toFixed(6)));
}

// Deterministic bag-of-words embedding: fast, offline, and good enough to make
// retrieval meaningful for keyword-ish questions.
export function localEmbed(text) {
  const vector = new Array(LOCAL_DIM).fill(0);
  const tokens = String(text ?? "")
    .toLowerCase()
    .match(/[a-z0-9_]+|[\u4e00-\u9fff]/g);
  if (!tokens) return vector;
  for (const token of tokens) {
    vector[hashToken(token) % LOCAL_DIM] += 1;
    vector[hashToken(`${token}#bigram`) % LOCAL_DIM] += 0.4;
  }
  return normalize(vector);
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  for (let index = 0; index < a.length; index++) dot += a[index] * b[index];
  return dot;
}

function backendFor(kb) {
  const backend = kb.embeddingBackend === "remote" ? "remote" : "local";
  return { backend, model: backend === "remote" ? kb.embeddingModel || "text-embedding-3-small" : LOCAL_MODEL };
}

async function remoteEmbed(texts, { userId, credentialId, model }) {
  const credential = resolveForNode({ credential_id: credentialId || "" }, userId);
  const headers = { "content-type": "application/json" };
  if (credential.apiKey) headers.authorization = `Bearer ${credential.apiKey}`;
  const url = `${credential.baseUrl}/embeddings`;
  const allowPrivate = credentialAllowsPrivate(credential);
  await assertSafeUrl(url, { allowPrivate, what: "Embeddings endpoint" });
  const response = await safeFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: model || "text-embedding-3-small", input: texts }),
    signal: AbortSignal.timeout(30000),
  }, { allowPrivate, what: "Embeddings endpoint" });
  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 200);
    try {
      detail = JSON.parse(text).error?.message || detail;
    } catch {
      /* keep the raw excerpt */
    }
    throw new Error(`${credential.name} embeddings failed (${response.status}): ${detail}`);
  }
  const body = JSON.parse(text);
  const vectors = (body.data ?? []).map((entry) => normalize(entry.embedding ?? []));
  if (vectors.length !== texts.length || !vectors.every((vector) => vector.length)) {
    throw new Error("The embeddings endpoint returned an unexpected payload");
  }
  return vectors;
}

async function embed(texts, { userId, credentialId, backend, model }) {
  const spec = backend === "remote" ? { backend: "remote", model } : { backend: "local", model: LOCAL_MODEL };
  if (spec.backend === "remote") {
    try {
      return { ...spec, vectors: await remoteEmbed(texts, { userId, credentialId, model }), warning: null };
    } catch (err) {
      return {
        backend: "local",
        model: LOCAL_MODEL,
        vectors: texts.map(localEmbed),
        warning: `${err.message}. Used the local hashed embedding for this document instead.`,
      };
    }
  }
  return { ...spec, vectors: texts.map(localEmbed), warning: null };
}

export function chunkText(text) {
  const clean = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  const paragraphs = clean.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  const push = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = "";
  };
  for (const paragraph of paragraphs.length ? paragraphs : [clean]) {
    if (paragraph.length > CHUNK_SIZE) {
      push();
      for (let start = 0; start < paragraph.length; start += CHUNK_SIZE - CHUNK_OVERLAP) {
        chunks.push(paragraph.slice(start, start + CHUNK_SIZE));
      }
      continue;
    }
    if ((current + "\n\n" + paragraph).length > CHUNK_SIZE) push();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  push();
  return chunks;
}

// ---- knowledge bases ------------------------------------------------------

function publicBase(kb) {
  if (!kb) return null;
  return {
    id: kb.id,
    name: kb.name,
    description: kb.description,
    documents: kb.documents,
    chunks: kb.chunks,
    backend: kb.embeddingBackend,
    model: kb.embeddingModel,
    createdAt: kb.createdAt,
  };
}

export function listKnowledgeBases(userId) {
  return db.listKnowledgeBases(userId).map(publicBase);
}

export function createKnowledgeBase({ userId, name, description = "", backend = "local", model = "", credentialId = "" }) {
  const cleanName = String(name ?? "").trim();
  if (!cleanName) throw new Error("A knowledge base needs a name");
  return publicBase(
    db.createKnowledgeBase({
      userId,
      name: cleanName.slice(0, 120),
      description: String(description ?? "").slice(0, 400),
      embeddingBackend: backend === "remote" ? "remote" : "local",
      embeddingModel: model ? String(model).slice(0, 120) : "",
      credentialId,
    }),
  );
}

export function deleteKnowledgeBase(id, userId) {
  return db.deleteKnowledgeBase(id, userId);
}

export async function addDocument({ userId, kbId, title, text, source = "" }) {
  const kb = db.getKnowledgeBase(kbId, userId);
  if (!kb) throw new Error("That knowledge base was deleted");
  const body = String(text ?? "").trim();
  if (!body) throw new Error("A document needs some text");
  const label = String(title ?? "").trim() || body.split("\n")[0].slice(0, 80) || "Untitled document";

  const chunks = chunkText(body);
  const spec = backendFor(kb);
  const embedded = await embed(chunks, {
    userId,
    credentialId: kb.credentialId,
    backend: spec.backend,
    model: spec.model,
  });

  const document = db.insertKnowledgeDocument({
    userId,
    kbId,
    title: label.slice(0, 160),
    source: String(source ?? "").slice(0, 400),
    text: body,
    chunkCount: chunks.length,
  });
  db.insertKnowledgeChunks(
    chunks.map((chunk, ord) => ({
      kbId,
      docId: document.id,
      userId,
      ord,
      backend: embedded.backend,
      model: embedded.model,
      text: chunk,
      embedding: embedded.vectors[ord] ?? [],
    })),
  );

  return {
    document: db.getKnowledgeDocument(document.id, userId),
    chunks: chunks.length,
    backend: embedded.backend,
    model: embedded.model,
    warning: embedded.warning,
  };
}

export function deleteDocument(id, userId) {
  return db.deleteKnowledgeDocument(id, userId);
}

export function listDocuments(userId, kbId) {
  return db.listKnowledgeDocuments(userId, kbId);
}

// One embedding per (backend, model) pair, reused for every query in a search.
async function queryVectors(groups, query, userId, credentialIdOf) {
  const vectors = new Map();
  for (const group of groups) {
    const key = `${group.backend}|${group.model}|${group.kbId ?? ""}`;
    if (group.backend === "local") {
      vectors.set(key, localEmbed(query));
      continue;
    }
    try {
      const [vector] = await remoteEmbed([query], {
        userId,
        credentialId: credentialIdOf(group.kbId),
        model: group.model,
      });
      vectors.set(key, vector);
    } catch {
      vectors.set(key, null);
    }
  }
  return vectors;
}

export async function searchKnowledge({ userId, kbIds, query, topK = 5 }) {
  const ids = (Array.isArray(kbIds) ? kbIds : []).filter(Boolean);
  if (!ids.length) return { matches: [], warning: null };
  const bases = ids.map((id) => db.getKnowledgeBase(id, userId)).filter(Boolean);
  if (!bases.length) return { matches: [], warning: null };

  const chunks = db.listKnowledgeChunks(userId, bases.map((kb) => kb.id));
  if (!chunks.length) return { matches: [], warning: null };

  const groups = new Map();
  for (const chunk of chunks) {
    const key = `${chunk.backend}|${chunk.model}|${chunk.kbId}`;
    if (!groups.has(key)) {
      groups.set(key, { backend: chunk.backend, model: chunk.model, kbId: chunk.kbId });
    }
  }
  const credentialOf = (kbId) => bases.find((kb) => kb.id === kbId)?.credentialId || "";
  const vectors = await queryVectors([...groups.values()], String(query ?? ""), userId, credentialOf);

  const baseName = new Map(bases.map((kb) => [kb.id, kb.name]));
  const matches = [];
  let warning = null;
  for (const chunk of chunks) {
    const key = `${chunk.backend}|${chunk.model}|${chunk.kbId}`;
    const vector = vectors.get(key);
    if (!vector) {
      warning ??= "Some chunks use a remote embedding that is no longer reachable, so they were skipped.";
      continue;
    }
    const score = cosine(vector, chunk.embedding);
    if (score <= 0.02) continue;
    matches.push({
      score: Number(score.toFixed(4)),
      text: chunk.text,
      documentId: chunk.docId,
      documentTitle: chunk.title,
      knowledgeBase: baseName.get(chunk.kbId) ?? "knowledge base",
      ord: chunk.ord,
    });
  }
  matches.sort((a, b) => b.score - a.score);
  return { matches: matches.slice(0, Math.max(1, Math.min(20, Number(topK) || 5))), warning };
}

// ---- workspace memory -----------------------------------------------------

const MAX_MEMORIES_PER_QUERY = 400;

export function remember({ userId, workflowId = null, runId = null, nodeId = null, kind = "action", text }) {
  const body = String(text ?? "").trim();
  if (!body) return null;
  return db.insertMemory({
    userId,
    workflowId,
    runId,
    nodeId,
    kind,
    text: body.slice(0, 1200),
    embedding: localEmbed(body),
  });
}

function summarizeOutput(output) {
  if (output == null) return "";
  if (typeof output === "string") return output.slice(0, 400);
  if (typeof output !== "object") return String(output).slice(0, 400);
  for (const field of ["summary", "text", "markdown", "draft", "polished", "content", "answer", "stdout"]) {
    if (typeof output[field] === "string" && output[field].trim()) return output[field].trim().slice(0, 400);
  }
  try {
    return JSON.stringify(output).slice(0, 400);
  } catch {
    return "";
  }
}

// One line per node that ran: "Writing: <what it produced>".
export function rememberNode({ userId, workflowId, runId, node, output, status = "passed" }) {
  if (!userId || !node) return null;
  const summary = summarizeOutput(output);
  const prefix = status === "passed" ? `${node.title || node.type}` : `${node.title || node.type} failed`;
  return remember({
    userId,
    workflowId,
    runId,
    nodeId: node.id ?? null,
    kind: "action",
    text: summary ? `${prefix} → ${summary}` : prefix,
  });
}

export function recall({ userId, workflowId = null, query = "", recentLimit = 8, relevantLimit = 4 }) {
  const recent = db.listMemories(userId, workflowId ?? undefined, recentLimit);
  if (!db.listMemories(userId, workflowId ?? undefined, 1).length) {
    return { recent: [], relevant: [] };
  }
  const pool = db.listMemories(userId, workflowId ?? undefined, MAX_MEMORIES_PER_QUERY);
  const queryVector = localEmbed(query);
  const recentIds = new Set(recent.map((entry) => entry.id));
  const relevant = pool
    .filter((entry) => !recentIds.has(entry.id))
    .map((entry) => ({ ...entry, score: cosine(queryVector, entry.embedding) }))
    .filter((entry) => entry.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, relevantLimit)
    .map(({ embedding, ...rest }) => rest);
  return { recent, relevant };
}

export function listMemories(userId, { workflowId = null, limit = 60 } = {}) {
  return db.listMemories(userId, workflowId ?? undefined, Math.max(1, Math.min(200, limit)));
}

export function deleteMemory(id, userId) {
  return db.deleteMemory(id, userId);
}

// ---- node ----------------------------------------------------------------

function contextQuery(node, input) {
  const rendered = renderText(node.query ?? "", input);
  if (rendered && rendered.trim()) return rendered.trim();
  const shaped = node.prompt ? renderText(node.prompt, input) : "";
  return `${node.title ?? ""} ${shaped} ${JSON.stringify(input ?? {})}`.slice(0, 1200);
}

export async function runKnowledgeNode({ node, input, userId }) {
  const query = contextQuery(node, input);
  const kbIds = Array.isArray(node.kb_ids) ? node.kb_ids : [];
  const topK = Number(node.top_k) || 5;
  const logs = [`query: ${query.slice(0, 200)}`];

  const { matches, warning } = await searchKnowledge({ userId, kbIds, query, topK });
  logs.push(`${matches.length} chunk${matches.length === 1 ? "" : "s"} retrieved from ${kbIds.length} knowledge base${kbIds.length === 1 ? "" : "s"}`);
  if (warning) logs.push(warning);

  let memory = null;
  if (node.use_memory !== false) {
    memory = recall({ userId, workflowId: node._workflowId ?? null, query, recentLimit: 6, relevantLimit: 3 });
    if (memory.recent.length) logs.push(`${memory.recent.length} recent memor${memory.recent.length === 1 ? "y" : "ies"} attached`);
  }

  return {
    json: {
      query,
      matches: matches.map(({ score, text, documentTitle, knowledgeBase }) => ({
        score,
        source: documentTitle,
        knowledgeBase,
        text,
      })),
      memory: memory ? [...memory.recent, ...memory.relevant].map((entry) => entry.text) : [],
    },
    cost: 0,
    tokensIn: 0,
    tokensOut: 0,
    logs,
  };
}

// ---- agent context + tools ------------------------------------------------

export async function buildAgentContext({ node, input, userId, workflowId, useMemory }) {
  const query = contextQuery(node, input);
  const kbIds = Array.isArray(node.kb_ids) ? node.kb_ids.filter(Boolean) : [];
  const memoryOn = typeof useMemory === "boolean" ? useMemory : node.use_memory !== false;

  let knowledge = { matches: [], warning: null };
  if (kbIds.length) {
    knowledge = await searchKnowledge({
      userId,
      kbIds,
      query,
      topK: Math.max(1, Math.min(12, Number(node.kb_top_k) || 5)),
    });
  }
  let memory = { recent: [], relevant: [] };
  if (memoryOn) {
    memory = recall({ userId, workflowId: workflowId ?? null, query, recentLimit: 8, relevantLimit: 4 });
  }
  return { query, kbIds, knowledge, memory };
}

export function contextPrompt(context) {
  const parts = [];
  if (context.memory.recent.length || context.memory.relevant.length) {
    parts.push("What already happened in this workflow (newest first):");
    for (const entry of context.memory.recent) parts.push(`- ${entry.text}`);
    if (context.memory.relevant.length) {
      parts.push("Relevant older memory:");
      for (const entry of context.memory.relevant) parts.push(`- ${entry.text}`);
    }
  }
  if (context.knowledge.matches.length) {
    parts.push("Reference material from the attached knowledge bases:");
    for (const match of context.knowledge.matches) {
      parts.push(`- [${match.knowledgeBase} · ${match.documentTitle}] ${match.text}`);
    }
  }
  if (!parts.length) return "";
  return ["", "Use this context. Do not invent facts that contradict it.", ...parts].join("\n");
}

export function agentTools(context) {
  const tools = [];
  if (context.kbIds.length) {
    tools.push({
      type: "function",
      function: {
        name: "knowledge_search",
        description: "Search the attached knowledge bases and return the closest passages.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to look for" },
            top_k: { type: "number", description: "How many passages, 1-10" },
          },
          required: ["query"],
        },
      },
    });
  }
  tools.push({
    type: "function",
    function: {
      name: "remember",
      description: "Save one durable note for later steps and later runs of this workflow.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "What should be remembered" },
          kind: { type: "string", description: "note, decision or finding" },
        },
        required: ["text"],
      },
    },
  });
  return tools;
}

export async function runAgentTool(call, { userId, workflowId, runId, nodeId, kbIds }) {
  const name = call?.function?.name;
  let args = {};
  try {
    args = JSON.parse(call?.function?.arguments || "{}");
  } catch {
    args = {};
  }
  if (name === "knowledge_search") {
    const { matches, warning } = await searchKnowledge({
      userId,
      kbIds,
      query: String(args.query ?? ""),
      topK: Math.max(1, Math.min(10, Number(args.top_k) || 4)),
    });
    return {
      matches: matches.map((match) => ({
        score: match.score,
        source: match.documentTitle,
        knowledgeBase: match.knowledgeBase,
        text: match.text,
      })),
      warning,
    };
  }
  if (name === "remember") {
    const entry = remember({
      userId,
      workflowId,
      runId: runId ?? null,
      nodeId: nodeId ?? null,
      kind: String(args.kind ?? "note").slice(0, 40),
      text: String(args.text ?? ""),
    });
    return { saved: Boolean(entry) };
  }
  return { error: `Unknown tool: ${name}` };
}

export function knowledgeSummary(userId) {
  return listKnowledgeBases(userId);
}

export { randomUUID };
