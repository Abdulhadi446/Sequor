// Agents: a named runtime configuration for a task.
//
// An agent is more than a key. It carries a model, a credential, a system
// prompt, skills, MCP servers and the built-in tools it may use (file search,
// file write, shell, web fetch, knowledge, memory). It can be written by hand
// or imported from an opencode.json file, which is parsed into the same shape.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "./db.js";
import * as credentials from "./credentials.js";
import { openMcpSession, runBashNode, runFetchNode } from "./nodes.js";
import { remember, searchKnowledge } from "./knowledge.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const BUILTIN_TOOLS = [
  { key: "file_search", label: "File search", hint: "List and read files inside the agent workspace" },
  { key: "file_write", label: "File write", hint: "Create and overwrite files inside the agent workspace" },
  { key: "bash", label: "Run commands", hint: "Run shell commands with the workspace as cwd" },
  { key: "web", label: "Web fetch", hint: "GET URLs and return their text or JSON" },
  { key: "knowledge", label: "Knowledge search", hint: "Search the knowledge bases attached to the node" },
  { key: "memory", label: "Workspace memory", hint: "Read earlier steps and write notes for later ones" },
];

const TOOL_DEFAULTS = {
  file_search: true,
  file_write: false,
  bash: false,
  web: true,
  knowledge: true,
  memory: true,
};

const MAX_SKILL_CHARS = 9000;
const MAX_READ_BYTES = 128 * 1024;
const MAX_WRITE_BYTES = 512 * 1024;
const MAX_LIST_ENTRIES = 300;

function clampTools(raw) {
  const tools = { ...TOOL_DEFAULTS };
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(TOOL_DEFAULTS)) {
      if (typeof raw[key] === "boolean") tools[key] = raw[key];
    }
  }
  return tools;
}

function normalizeSkill(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name ?? "").trim().slice(0, 120);
  if (!name) return null;
  return {
    name,
    description: String(raw.description ?? "").slice(0, 400),
    instructions: String(raw.instructions ?? raw.content ?? raw.body ?? "").slice(0, 12000),
  };
}

function normalizeMcp(raw, fallbackName = "mcp") {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name ?? fallbackName).trim().slice(0, 80) || fallbackName;
  const transport = raw.transport === "stdio" || raw.type === "local" || raw.command ? "stdio" : "http";
  const entry = {
    name,
    transport,
    url: String(raw.url ?? "").trim(),
    command: Array.isArray(raw.command) ? raw.command.map(String).join(" ") : String(raw.command ?? "").trim(),
    headers: raw.headers && typeof raw.headers === "object" ? raw.headers : {},
    env: raw.env && typeof raw.env === "object" ? raw.env : raw.environment && typeof raw.environment === "object" ? raw.environment : {},
    cwd: String(raw.cwd ?? ""),
    enabled: raw.enabled !== false && raw.disabled !== true,
  };
  if (transport === "stdio" && !entry.command) return null;
  if (transport === "http" && !entry.url) return null;
  return entry;
}

function safeJson(value, fallback) {
  if (value == null) return fallback;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function mapAgent(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description ?? "",
    model: row.model ?? "",
    credentialId: row.credential_id ?? "",
    systemPrompt: row.system_prompt ?? "",
    skills: safeJson(row.skills, []).map(normalizeSkill).filter(Boolean),
    mcpServers: safeJson(row.mcp_servers, []).map((entry) => normalizeMcp(entry)).filter(Boolean),
    plugins: safeJson(row.plugins, []).map(String),
    tools: clampTools(safeJson(row.tools, {})),
    workspace: row.workspace ?? "",
    source: row.source ?? "manual",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---- opencode.json -------------------------------------------------------

// opencode.jsonc allows comments; strip them without touching string bodies.
export function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        out += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index++;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index++;
      continue;
    }
    out += char;
  }
  return out;
}

function shellQuote(part) {
  const value = String(part);
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function denyRule(rules, action) {
  return rules.some(
    (rule) => rule && String(rule.effect).toLowerCase() === "deny" && String(rule.action).toLowerCase() === action,
  );
}


// ---- uploaded companion files -------------------------------------------
//
// An opencode setup is rarely one file: opencode.json references AGENTS.md
// and skill folders, and skills live in their own markdown. The browser can
// send those files alongside the config, so their contents are baked into the
// agent instead of leaving placeholders.

function fileBaseName(path) {
  return String(path).replace(/\\/g, "/").split("/").pop() || "skill";
}

function parseSkillMarkdown(text, fallbackName, path) {
  const raw = String(text);
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  let name = fallbackName;
  let description = "";
  let body = raw;
  if (front) {
    body = raw.slice(front[0].length);
    for (const line of front[1].split(/\r?\n/)) {
      const match = /^(name|description)\s*:\s*(.+)$/i.exec(line.trim());
      if (!match) continue;
      const value = String(match[2]).trim().replace(/^["']|["']$/g, "");
      if (match[1].toLowerCase() === "name") name = value;
      else description = value;
    }
  }
  return {
    name: String(name || fallbackName).slice(0, 120),
    description: description.slice(0, 400),
    instructions: body.trim().slice(0, 12000),
    path,
  };
}

export function uploadedSkills(files = []) {
  const skills = [];
  for (const file of Array.isArray(files) ? files : []) {
    const path = String(file?.name ?? "").replace(/\\/g, "/");
    const content = String(file?.content ?? "");
    if (!path || !content.trim()) continue;
    if (/(^|\/)opencode\.jsonc?$/i.test(path)) continue;
    if (!/\.(md|mdx|txt)$/i.test(path)) continue;
    const base = fileBaseName(path);
    const parent = path.split("/").slice(-2, -1)[0] || "";
    const fallback = /^agents\.md$/i.test(base)
      ? "AGENTS.md"
      : /^skill\.md$/i.test(base) && parent
        ? parent
        : base.replace(/\.[^.]+$/, "");
    const skill = parseSkillMarkdown(content, fallback, path);
    if (!skill.instructions) continue;
    skills.push(skill);
  }
  return skills;
}

export function parseOpencodeConfig(raw, { name = "", files = [] } = {}) {
  let config = raw;
  if (typeof raw === "string") {
    try {
      config = JSON.parse(stripJsonComments(raw));
    } catch (err) {
      throw new Error(`That file is not valid opencode.json: ${err.message}`);
    }
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("An opencode config must be a JSON object");
  }

  const model = String(config.model ?? "").trim();
  const providerId = model.includes("/") ? model.split("/")[0] : "";
  const providers = config.provider && typeof config.provider === "object" ? config.provider : {};
  const providerEntry =
    (providerId && providers[providerId]) ||
    Object.entries(providers).find(([, entry]) => entry?.options?.apiKey)?.[1] ||
    Object.values(providers)[0] ||
    null;
  const options = providerEntry?.options ?? {};
  const providerKey = providerId || Object.keys(providers)[0] || "";
  const known = credentials.PROVIDERS.find((provider) => provider.id === providerKey) ?? null;
  const baseUrl = String(options.baseURL ?? options.baseUrl ?? options.base_url ?? known?.baseUrl ?? "").replace(/\/+$/, "");
  const apiKey = String(options.apiKey ?? "");
  // opencode writes models as "provider/model", but OpenRouter's own router
  // models live inside its namespace (openrouter/free, openrouter/auto), so
  // only drop the prefix when a vendor namespace follows it.
  let modelName = model;
  if (providerKey && model.startsWith(`${providerKey}/`)) {
    const bare = model.slice(providerKey.length + 1);
    const keepNamespace = providerKey === "openrouter" && !bare.includes("/");
    modelName = keepNamespace ? model : bare;
  }

  const tools = {};
  const toolsConfig = config.tools ?? {};
  const permission = config.permission ?? {};
  const permissionRules = Array.isArray(config.permissions) ? config.permissions : [];
  const off = (value) => value === false || String(value).toLowerCase() === "deny";
  tools.file_search =
    !off(toolsConfig.read) &&
    !off(toolsConfig.grep) &&
    !off(toolsConfig.glob) &&
    !off(permission.read) &&
    !denyRule(permissionRules, "read");
  tools.file_write =
    !off(toolsConfig.write) &&
    !off(toolsConfig.edit) &&
    !off(permission.edit) &&
    !denyRule(permissionRules, "edit");
  tools.bash =
    !off(toolsConfig.bash) &&
    !off(toolsConfig.shell) &&
    !off(permission.bash) &&
    !off(permission.shell) &&
    !denyRule(permissionRules, "shell") &&
    !denyRule(permissionRules, "bash");
  tools.web = !off(toolsConfig.webfetch) && !off(permission.webfetch) && !denyRule(permissionRules, "webfetch");
  tools.knowledge = !off(toolsConfig.knowledge) && !denyRule(permissionRules, "knowledge");
  tools.memory = !off(toolsConfig.memory) && !denyRule(permissionRules, "memory");

  const mcpRaw = config.mcp?.servers ?? config.mcp ?? {};
  const mcpServers = [];
  if (mcpRaw && typeof mcpRaw === "object") {
    for (const [serverName, entry] of Object.entries(mcpRaw)) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.enabled === false || entry.disabled === true) {
        const disabled = normalizeMcp({ ...entry, name: serverName, enabled: false }, serverName);
        if (disabled) mcpServers.push(disabled);
        continue;
      }
      const normalized = normalizeMcp({ ...entry, name: serverName }, serverName);
      if (normalized) mcpServers.push(normalized);
    }
  }

  const skills = [];
  const seen = new Set();
  const pushSkill = (skill) => {
    const normalized = normalizeSkill(skill);
    if (!normalized || seen.has(normalized.name)) return;
    seen.add(normalized.name);
    skills.push(normalized);
  };
  const rawSkills = Array.isArray(config.skills) ? config.skills : [];
  for (const skill of rawSkills) {
    if (typeof skill === "string") pushSkill({ name: skill, description: "Imported skill", instructions: "" });
    else pushSkill(skill);
  }
  const agentMap = config.agents ?? config.agent ?? {};
  if (agentMap && typeof agentMap === "object") {
    for (const [agentName, entry] of Object.entries(agentMap)) {
      if (!entry || typeof entry !== "object") continue;
      const instructions = String(entry.prompt ?? entry.system ?? entry.instructions ?? "");
      if (!instructions && !entry.description) continue;
      pushSkill({ name: agentName, description: entry.description ?? "", instructions });
    }
  }
  const uploads = uploadedSkills(files);
  const instructions = config.instructions;
  const instructionList = Array.isArray(instructions) ? instructions : instructions ? [instructions] : [];
  for (const reference of instructionList) {
    const path = String(reference).replace(/^\.\//, "");
    const base = path.split("/").pop() || path;
    const match =
      uploads.find((file) => file.path === path || file.path.endsWith(`/${path}`)) ??
      uploads.find((file) => file.path.startsWith(`${path.replace(/\/$/, "")}/`)) ??
      uploads.find((file) => fileBaseName(file.path).toLowerCase() === base.toLowerCase());
    pushSkill({
      name: base || path,
      description: match
        ? `Loaded from ${match.path}`
        : `Referenced by opencode.json (${path}). Paste its contents to make it available.`,
      instructions: match ? match.instructions : "",
    });
  }
  for (const file of uploads) {
    const existing = skills.find((skill) => skill.name.toLowerCase() === file.name.toLowerCase());
    if (existing) {
      if (!existing.instructions) {
        existing.instructions = file.instructions;
        if (file.description && (!existing.description || existing.description === "Imported skill")) {
          existing.description = file.description;
        } else if (!existing.description) {
          existing.description = `Loaded from ${file.path}`;
        }
      }
      continue;
    }
    pushSkill({
      name: file.name,
      description: file.description || `Uploaded ${file.path}`,
      instructions: file.instructions,
    });
  }

  const plugins = Array.isArray(config.plugin) ? config.plugin.map(String) : [];
  const defaultAgent = agentMap?.[config.default_agent ?? ""] ?? Object.values(agentMap ?? {})[0] ?? null;
  const systemPrompt = String(
    defaultAgent?.prompt ?? defaultAgent?.system ?? config.system ?? config.instructions_text ?? "",
  ).slice(0, 20000);

  return {
    name: String(name || config.name || defaultAgent?.name || "Imported agent").slice(0, 120),
    description: String(config.description ?? defaultAgent?.description ?? "").slice(0, 400),
    model: modelName,
    provider: { id: providerKey, baseUrl, apiKey },
    systemPrompt,
    skills,
    mcpServers,
    plugins,
    tools: clampTools(tools),
    source: "opencode.json",
  };
}

// ---- CRUD ----------------------------------------------------------------

export function listAgents(userId) {
  return db.listAgents(userId).map(mapAgent);
}

export function getAgent(id, userId) {
  return mapAgent(db.getAgent(id, userId));
}

export function createAgent(userId, body = {}) {
  const name = String(body.name ?? "").trim() || "Untitled agent";
  return mapAgent(
    db.createAgent({
      userId,
      name,
      description: String(body.description ?? "").slice(0, 400),
      model: String(body.model ?? "").slice(0, 160),
      credentialId: String(body.credentialId ?? ""),
      systemPrompt: String(body.systemPrompt ?? "").slice(0, 20000),
      skills: (Array.isArray(body.skills) ? body.skills : []).map(normalizeSkill).filter(Boolean),
      mcpServers: (Array.isArray(body.mcpServers) ? body.mcpServers : []).map((entry) => normalizeMcp(entry)).filter(Boolean),
      plugins: (Array.isArray(body.plugins) ? body.plugins : []).map(String),
      tools: clampTools(body.tools),
      workspace: String(body.workspace ?? "").slice(0, 500),
      source: String(body.source ?? "manual").slice(0, 40),
      config: body.config ?? {},
    }),
  );
}

export function updateAgent(id, userId, body = {}) {
  const existing = getAgent(id, userId);
  if (!existing) return null;
  return mapAgent(
    db.updateAgent(id, userId, {
      name: body.name === undefined ? existing.name : String(body.name).trim().slice(0, 120) || existing.name,
      description: body.description === undefined ? existing.description : String(body.description).slice(0, 400),
      model: body.model === undefined ? existing.model : String(body.model).slice(0, 160),
      credentialId: body.credentialId === undefined ? existing.credentialId : String(body.credentialId),
      systemPrompt:
        body.systemPrompt === undefined ? existing.systemPrompt : String(body.systemPrompt).slice(0, 20000),
      skills:
        body.skills === undefined
          ? existing.skills
          : (Array.isArray(body.skills) ? body.skills : []).map(normalizeSkill).filter(Boolean),
      mcpServers:
        body.mcpServers === undefined
          ? existing.mcpServers
          : (Array.isArray(body.mcpServers) ? body.mcpServers : []).map((entry) => normalizeMcp(entry)).filter(Boolean),
      plugins: body.plugins === undefined ? existing.plugins : (Array.isArray(body.plugins) ? body.plugins : []).map(String),
      tools: body.tools === undefined ? existing.tools : clampTools(body.tools),
      workspace: body.workspace === undefined ? existing.workspace : String(body.workspace).slice(0, 500),
    }),
  );
}

export function deleteAgent(id, userId) {
  return db.deleteAgent(id, userId);
}

// Import creates the agent and, when the file carries a key, a matching
// encrypted credential so the key never lives in the agent record.
export function importOpencodeConfig(userId, raw, { name = "", files = [] } = {}) {
  const companions = (Array.isArray(files) ? files : [])
    .map((file) => ({ name: String(file?.name ?? "").replace(/\\/g, "/"), content: String(file?.content ?? "") }))
    .filter((file) => file.name && file.content.trim());
  let configRaw = raw;
  if (configRaw == null || configRaw === "") {
    const configFile = companions.find((file) => /(^|\/)opencode\.jsonc?$/i.test(file.name));
    if (!configFile) {
      throw new Error("No opencode.json found. Paste the config text or upload opencode.json with the other files.");
    }
    configRaw = configFile.content;
  }
  const parsed = parseOpencodeConfig(configRaw, { name, files: companions });
  let credentialId = "";
  let credentialNote = "";
  if (parsed.provider.apiKey) {
    if (!parsed.provider.baseUrl) {
      throw new Error("This config has an API key but no provider base URL, so the key cannot be used");
    }
    const provider = credentials.PROVIDERS.find((entry) => entry.id === parsed.provider.id);
    const credential = credentials.createCredential(
      {
        provider: provider?.id ?? "custom",
        name: `${parsed.name} · key`,
        baseUrl: parsed.provider.baseUrl,
        model: parsed.model,
        apiKey: parsed.provider.apiKey,
      },
      userId,
    );
    credentialId = credential.id;
    credentialNote = "An encrypted credential was created from the config's API key.";
  }

  const agent = createAgent(userId, {
    name: parsed.name,
    description: parsed.description,
    model: parsed.model,
    credentialId,
    systemPrompt: parsed.systemPrompt,
    skills: parsed.skills,
    mcpServers: parsed.mcpServers,
    plugins: parsed.plugins,
    tools: parsed.tools,
    source: parsed.source,
    config: {},
  });
  return { agent, credentialNote };
}

// ---- prompt --------------------------------------------------------------

export function agentSystemPrompt(agent, nodePrompt) {
  const parts = [];
  if (agent?.systemPrompt?.trim()) parts.push(agent.systemPrompt.trim());
  if (nodePrompt?.trim()) parts.push(nodePrompt.trim());
  if (agent?.skills?.length) {
    const lines = ["Skills you have (use them when relevant):"];
    let budget = MAX_SKILL_CHARS;
    for (const skill of agent.skills) {
      const block = [`## ${skill.name}`, skill.description, skill.instructions].filter(Boolean).join("\n");
      if (block.length > budget) break;
      budget -= block.length;
      lines.push(block);
    }
    parts.push(lines.join("\n\n"));
  }
  if (agent?.plugins?.length) {
    parts.push(
      `Plugins declared by this agent's config: ${agent.plugins.join(", ")}. This runtime records them but does not execute their hooks.`,
    );
  }
  return parts.join("\n\n") || "You are one focused step in a larger workflow. Do only your step.";
}

// ---- tools ---------------------------------------------------------------

function workspaceRoot(agent) {
  const root = agent.workspace ? resolve(agent.workspace) : join(projectRoot, "data", "agent-workspace", agent.id);
  return root;
}

function ensureWorkspace(root) {
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return root;
}

function safePath(root, requested) {
  const target = resolve(root, String(requested ?? "."));
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`"${requested}" is outside this agent's workspace`);
  }
  return target;
}

function walk(root, dir, depth, out) {
  if (out.length >= MAX_LIST_ENTRIES || depth > 4) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_LIST_ENTRIES) return;
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, full, depth + 1, out);
    else {
      try {
        out.push({ path: relative(root, full), size: statSync(full).size });
      } catch {
        /* skip unreadable entries */
      }
    }
  }
}

function matchPattern(path, pattern) {
  if (!pattern) return true;
  const value = String(pattern).trim();
  if (value.includes("*")) {
    const regex = new RegExp(`^${value.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return regex.test(path.split("/").pop()) || regex.test(path);
  }
  return path.toLowerCase().includes(value.toLowerCase());
}

function tool(name, description, properties, required = []) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required },
    },
  };
}

const READ_DESCRIPTION = "Works only inside this agent's workspace folder.";

export class AgentToolbox {
  constructor({ agent, userId, workflowId, runId, nodeId, kbIds = [] }) {
    this.agent = agent;
    this.userId = userId;
    this.workflowId = workflowId ?? null;
    this.runId = runId ?? null;
    this.nodeId = nodeId ?? null;
    this.kbIds = kbIds;
    this.mcp = [];
    this.mcpTools = [];
    this.logs = [];
    this.root = workspaceRoot(agent);
  }

  definitions() {
    const tools = [];
    if (this.agent.tools.file_search) {
      tools.push(
        tool(
          "list_files",
          `List files in the agent workspace. ${READ_DESCRIPTION}`,
          { path: { type: "string", description: "Folder relative to the workspace root" }, pattern: { type: "string", description: "Filename filter, * allowed" } },
        ),
        tool("read_file", `Read a UTF-8 text file. ${READ_DESCRIPTION}`, { path: { type: "string" } }, ["path"]),
      );
    }
    if (this.agent.tools.file_write) {
      tools.push(
        tool(
          "write_file",
          `Create or overwrite a text file. ${READ_DESCRIPTION}`,
          { path: { type: "string" }, content: { type: "string" } },
          ["path", "content"],
        ),
      );
    }
    if (this.agent.tools.bash) {
      tools.push(
        tool("run_command", "Run a shell command in the agent workspace and return stdout/stderr.", {
          command: { type: "string" },
        }, ["command"]),
      );
    }
    if (this.agent.tools.web) {
      tools.push(tool("fetch_url", "GET a URL and return its status and body.", { url: { type: "string" } }, ["url"]));
    }
    if (this.agent.tools.knowledge && this.kbIds.length) {
      tools.push(
        tool("knowledge_search", "Search the knowledge bases attached to this node.", {
          query: { type: "string" },
          top_k: { type: "number" },
        }, ["query"]),
      );
    }
    if (this.agent.tools.memory) {
      tools.push(
        tool("remember", "Save a durable note for later steps and runs of this workflow.", {
          text: { type: "string" },
          kind: { type: "string" },
        }, ["text"]),
      );
    }
    for (const entry of this.mcpTools) tools.push(entry.definition);
    return tools;
  }

  async connectMcp() {
    for (const server of this.agent.mcpServers.filter((entry) => entry.enabled)) {
      const timeout = 20000;
      try {
        const session = await openMcpSession(server, timeout);
        const listing = await session.call("tools/list", {});
        const prefix = `mcp__${server.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}__`;
        let count = 0;
        for (const entry of listing.tools ?? []) {
          const toolName = `${prefix}${entry.name}`.slice(0, 60);
          this.mcpTools.push({
            server,
            session,
            original: entry.name,
            definition: tool(
              toolName,
              `${entry.description ?? entry.name} (MCP server: ${server.name})`,
              entry.inputSchema?.properties ?? { input: { type: "object", description: "Tool arguments as an object" } },
              entry.inputSchema?.required ?? [],
            ),
          });
          count++;
        }
        this.mcp.push({ server, session });
        this.logs.push(`MCP ${server.name}: ${count} tool${count === 1 ? "" : "s"}`);
      } catch (err) {
        this.logs.push(`MCP ${server.name} unavailable: ${err.message}`);
      }
    }
  }

  async call(name, args = {}) {
    const input = args && typeof args === "object" ? args : {};
    if (name === "list_files") {
      const root = ensureWorkspace(this.root);
      const target = safePath(root, input.path ?? ".");
      if (!existsSync(target)) throw new Error(`No such path: ${input.path ?? "."}`);
      const files = [];
      if (statSync(target).isDirectory()) walk(root, target, 0, files);
      else files.push({ path: relative(root, target), size: statSync(target).size });
      const filtered = files.filter((entry) => matchPattern(entry.path, input.pattern));
      return { count: filtered.length, files: filtered.slice(0, MAX_LIST_ENTRIES) };
    }
    if (name === "read_file") {
      const root = ensureWorkspace(this.root);
      const target = safePath(root, input.path);
      const stat = statSync(target);
      if (!stat.isFile()) throw new Error(`${input.path} is not a file`);
      if (stat.size > MAX_READ_BYTES) throw new Error(`${input.path} is larger than ${MAX_READ_BYTES} bytes`);
      const buffer = readFileSync(target);
      if (buffer.includes(0)) throw new Error(`${input.path} looks binary`);
      return { path: relative(root, target), bytes: buffer.length, text: buffer.toString("utf8") };
    }
    if (name === "write_file") {
      if (!this.agent.tools.file_write) throw new Error("File write is disabled for this agent");
      const root = ensureWorkspace(this.root);
      const target = safePath(root, input.path);
      const content = String(input.content ?? "");
      if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new Error(`Refusing to write more than ${MAX_WRITE_BYTES} bytes`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      return { path: relative(root, target), bytes: Buffer.byteLength(content) };
    }
    if (name === "run_command") {
      if (!this.agent.tools.bash) throw new Error("Shell access is disabled for this agent");
      const root = ensureWorkspace(this.root);
      const result = await runBashNode({
        node: { command: String(input.command ?? ""), cwd: root, timeout_ms: 60000 },
        input: {},
      });
      return { exitCode: result.json.exitCode, stdout: result.json.stdout, stderr: result.json.stderr };
    }
    if (name === "fetch_url") {
      if (!this.agent.tools.web) throw new Error("Web fetch is disabled for this agent");
      const result = await runFetchNode({ node: { url: String(input.url ?? ""), format: "auto", headers: "{}" }, input: {} });
      return { status: result.json.status, contentType: result.json.contentType, body: result.json.body };
    }
    if (name === "knowledge_search") {
      const { matches } = await searchKnowledge({
        userId: this.userId,
        kbIds: this.kbIds,
        query: String(input.query ?? ""),
        topK: Math.max(1, Math.min(10, Number(input.top_k) || 4)),
      });
      return { matches: matches.map((match) => ({ score: match.score, source: match.documentTitle, text: match.text })) };
    }
    if (name === "remember") {
      const entry = remember({
        userId: this.userId,
        workflowId: this.workflowId,
        runId: this.runId,
        nodeId: this.nodeId,
        kind: String(input.kind ?? "note").slice(0, 40),
        text: String(input.text ?? ""),
      });
      return { saved: Boolean(entry) };
    }
    const mcpTool = this.mcpTools.find((entry) => entry.definition.function.name === name);
    if (mcpTool) {
      const result = await mcpTool.session.call("tools/call", { name: mcpTool.original, arguments: input });
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content.filter((item) => item?.type === "text").map((item) => item.text).join("\n");
      if (result.isError) throw new Error(text.slice(0, 500) || "MCP tool returned an error");
      return { text, content: result.content ?? null };
    }
    throw new Error(`Unknown tool: ${name}`);
  }

  async close() {
    for (const entry of this.mcp) {
      try {
        entry.session.close?.();
      } catch {
        /* ignore shutdown errors */
      }
    }
    this.mcp = [];
  }
}

export async function createToolbox(options) {
  const toolbox = new AgentToolbox(options);
  await toolbox.connectMcp();
  return toolbox;
}
