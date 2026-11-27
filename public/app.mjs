// Sequor editor. Vanilla ES module: canvas, node panel, execution log and
// credentials all talk to the local API. No build step.

const $ = (selector, root = document) => root.querySelector(selector);

const NODE_W = 112;
const NODE_H = 112;
const PORT_Y = NODE_H / 2;
const COLUMN = 236;

const ICONS = {
  trigger:
    '<svg viewBox="0 0 24 24"><path d="M13 2.5 4.5 14H11l-1 7.5L18.5 10H12l1-7.5Z"/></svg>',
  agent:
    '<svg viewBox="0 0 24 24"><rect x="4.5" y="8" width="15" height="10.5" rx="3"/><path d="M12 3.2v4.3"/><circle cx="12" cy="3.2" r="1"/><circle cx="9.3" cy="12.6" r="1.15" fill="currentColor" stroke="none"/><circle cx="14.7" cy="12.6" r="1.15" fill="currentColor" stroke="none"/><path d="M9.7 15.8h4.6"/><path d="M4.5 11.5h-1.2M20.7 11.5h-1.2"/></svg>',
  check:
    '<svg viewBox="0 0 24 24"><path d="M12 3 19 6v5.6c0 4.3-2.9 7.2-7 8.9-4.1-1.7-7-4.6-7-8.9V6l7-3Z"/><path d="M8.8 12.2 11.2 14.6 15.4 10"/></svg>',
  http:
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.2"/><path d="M3.8 12h16.4"/><path d="M12 3.8c2.6 2.5 3.9 5.2 3.9 8.2s-1.3 5.7-3.9 8.2c-2.6-2.5-3.9-5.2-3.9-8.2s1.3-5.7 3.9-8.2Z"/></svg>',
  fetch:
    '<svg viewBox="0 0 24 24"><path d="M12 3.5v11"/><path d="M8 10.5l4 4 4-4"/><path d="M4.5 17.5v2h15v-2"/></svg>',
  mcp: '<svg viewBox="0 0 24 24"><path d="M8.5 3.5v9a3.5 3.5 0 0 0 7 0v-9"/><path d="M6 8.5h2.5M15.5 6H18"/><path d="M12 16v4.5"/></svg>',
  bash: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M7.5 9.5l3 2.5-3 2.5M13 15h3.5"/></svg>',
  code: '<svg viewBox="0 0 24 24"><path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/></svg>',
  rag: '<svg viewBox="0 0 24 24"><path d="M4.5 5.5h6a2.5 2.5 0 0 1 2.5 2.5v11a2 2 0 0 0-2-2H4.5z"/><path d="M19.5 5.5h-6A2.5 2.5 0 0 0 11 8v11a2 2 0 0 1 2-2h6.5z"/></svg>',
  if: '<svg viewBox="0 0 24 24"><path d="M12 3.5 20.5 12 12 20.5 3.5 12z"/><path d="M12 8v8"/></svg>',
  switch: '<svg viewBox="0 0 24 24"><path d="M3.5 12h4.5"/><path d="M8 12l5-6h5"/><path d="M8 12l5 6h5"/><path d="M18 3.5v5M15.5 6h5"/><path d="M18 15.5v5M15.5 18h5"/></svg>',
  filter: '<svg viewBox="0 0 24 24"><path d="M4 5.5h16l-6 7.2V18l-4 2.2v-7.5z"/></svg>',
  merge: '<svg viewBox="0 0 24 24"><path d="M4 5.5h4l4 6.5 4-6.5h4"/><path d="M12 12v8"/><path d="M9 17l3 3 3-3"/></svg>',
  set: '<svg viewBox="0 0 24 24"><path d="M4.5 19.5h4L19 9a2.1 2.1 0 0 0-3-3L5.5 16.5z"/><path d="M14.5 7.5 17 10"/></svg>',
  wait: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  limit: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h11M4 17h7"/><path d="M17 15.5l3 2-3 2"/></svg>',
  noop: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M8 12h8"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><path d="M8 4h8l4 4v8l-4 4H8l-4-4V8z"/><path d="M9 12h6"/></svg>',
};

const CONDITION_OPERATORS = [
  ["equals", "equals"],
  ["notEquals", "not equals"],
  ["contains", "contains"],
  ["notContains", "doesn't contain"],
  ["startsWith", "starts with"],
  ["endsWith", "ends with"],
  ["regex", "matches regex"],
  ["greater", "greater than"],
  ["greaterOrEqual", "greater or equal"],
  ["less", "less than"],
  ["lessOrEqual", "less or equal"],
  ["isEmpty", "is empty"],
  ["isNotEmpty", "is not empty"],
  ["isTrue", "is true"],
  ["isFalse", "is false"],
  ["exists", "exists"],
];

const NODE_META = {
  trigger: { label: "Trigger", color: "#e0973c", blurb: "Starts the workflow: manual, schedule or webhook" },
  agent: { label: "Agent", color: "#ea4b71", blurb: "One focused model call with an output contract" },
  check: { label: "Check", color: "#2fb6a3", blurb: "Reviews the handoff and sends weak work back" },
  if: { label: "IF", color: "#e0973c", blurb: "Two outputs: true and false, picked by conditions" },
  switch: { label: "Switch", color: "#e07b3c", blurb: "Routes data to the first matching rule's output" },
  filter: { label: "Filter", color: "#2fb6a3", blurb: "Keeps the data only when the conditions match" },
  merge: { label: "Merge", color: "#4c7ff0", blurb: "Combines the outputs of several branches" },
  set: { label: "Edit Fields", color: "#7c86ff", blurb: "Sets fields on the data before passing it on" },
  http: { label: "HTTP Request", color: "#4c7ff0", blurb: "Calls any API with the previous node's data" },
  fetch: { label: "Fetch", color: "#4c7ff0", blurb: "Downloads a URL and hands back its JSON or text" },
  mcp: { label: "MCP tool", color: "#9b6dff", blurb: "Calls one tool on an MCP server, no model involved" },
  bash: { label: "Run command", color: "#3ecf8e", blurb: "Runs a shell command on this machine" },
  code: { label: "Code", color: "#f0b429", blurb: "Runs JavaScript against the incoming data" },
  wait: { label: "Wait", color: "#b08968", blurb: "Pauses the run for a set time" },
  limit: { label: "Limit", color: "#4c7ff0", blurb: "Keeps only the first N items of an array" },
  noop: { label: "No Operation", color: "#8a8a8a", blurb: "Does nothing, passes data through" },
  stop: { label: "Stop and Error", color: "#e04f4f", blurb: "Stops the run with an error message" },
  rag: { label: "Knowledge search", color: "#2fb6a3", blurb: "Retrieves the closest passages from your knowledge bases" },
};

const state = {
  workflows: [],
  templates: [],
  credentials: [],
  providers: [],
  env: null,
  knowledge: [],
  kbSelected: null,
  kbDocs: [],
  kbDocsFor: null,
  memories: [],
  agent: null,
  agents: [],
  builtinTools: [],
  agentSelected: null,
  agentDraft: null,
  workflow: null,
  selected: null,
  selectedEdge: null,
  view: { zoom: 1, x: 0, y: 0 },
  saveTimer: null,
  run: null,
  stream: null,
  dockNode: null,
  ndvTab: "params",
  addFrom: null,
  flyout: null,
  user: null,
  authMode: "login",
  legacyCount: 0,
  signupOpen: true,
  capabilities: { exec: true },
};

const el = {
  name: $("#workflow-name"),
  saveState: $("#save-state"),
  activeToggle: $("#active-toggle"),
  activeLabel: $("#active-label"),
  nodes: $("#nodes"),
  canvas: $("#canvas"),
  canvasWrap: $("#canvas-wrap"),
  svg: $("#edges"),
  edgeLayer: $("#edge-layer"),
  tempEdge: $("#temp-edge"),
  zoomLabel: $("#zoom-label"),
  dock: $("#dock"),
  dockRows: $("#dock-rows"),
  dockDetail: $("#dock-detail"),
  dockDot: $("#dock-dot"),
  dockTitle: $("#dock-title"),
  dockMeta: $("#dock-meta"),
  ndv: $("#ndv"),
  ndvBody: $("#ndv-body"),
  ndvTitle: $("#ndv-title"),
  ndvType: $("#ndv-type"),
  ndvIcon: $("#ndv-icon"),
  flyout: $("#flyout"),
  flyoutTitle: $("#flyout-title"),
  flyoutBody: $("#flyout-body"),
  popover: $("#add-popover"),
  popList: $("#pop-list"),
  execTable: $("#exec-table"),
  credList: $("#cred-list"),
  credForm: $("#cred-form"),
  credNote: $("#cred-note"),
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text };
    }
  }
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/auth/")) {
      showGate(false, "Your session expired. Sign in again.");
    }
    throw new Error(body?.error || `${response.status} ${response.statusText}`);
  }
  return body;
}

function toast(message, kind = "") {
  const element = $("#toast");
  element.textContent = message;
  element.className = kind;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    element.hidden = true;
  }, kind === "error" ? 7000 : 3400);
}

function formatMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(tokensIn = 0, tokensOut = 0) {
  const total = (tokensIn ?? 0) + (tokensOut ?? 0);
  if (!total) return "—";
  if (total < 1000) return String(total);
  return `${(total / 1000).toFixed(1)}k`;
}

const money = (value) => (value > 0 ? ` · $${value.toFixed(4)}` : "");

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied.");
  } catch {
    toast("Copy failed — select the text manually.", "error");
  }
}

// ---------------------------------------------------------------------------
// state accessors
// ---------------------------------------------------------------------------

const nodesOf = () => state.workflow?.graph.nodes ?? [];
const nodeById = (id) => nodesOf().find((node) => node.id === id) ?? null;
const selectedNode = () => nodeById(state.selected);
const triggerNode = () => nodesOf().find((node) => node.type === "trigger") ?? null;
const credentialById = (id) => state.credentials.find((entry) => entry.id === id) ?? null;
const agentById = (id) => state.agents.find((entry) => entry.id === id) ?? null;
const enabledToolCount = (tools) => Object.values(tools ?? {}).filter(Boolean).length;

function modelFor(node) {
  const credential = credentialById(node.credential_id);
  const model = node.model || credential?.model || (state.env?.configured ? state.env.model : "");
  return model || "no model";
}

function conditionSummary(node) {
  const conditions = Array.isArray(node.conditions) ? node.conditions : [];
  if (!conditions.length) return "always true";
  return conditions
    .map((condition) =>
      `${String(condition.left || "value").replace(/[{}]/g, "").trim().slice(0, 14)} ${condition.operator || "equals"} ${String(
        condition.right ?? "",
      ).slice(0, 10)}`.trim(),
    )
    .join(node.combine === "or" ? " or " : " and ");
}

function subtitleFor(node) {
  if (node.type === "trigger") {
    if (node.mode === "schedule") {
      const every = Number(node.every_minutes) || 15;
      if (every % 1440 === 0) return every === 1440 ? "daily" : `every ${every / 1440} days`;
      if (every % 60 === 0) return `every ${every / 60}h`;
      return `every ${every}m`;
    }
    if (node.mode === "webhook") return "webhook";
    return "manual";
  }
  if (node.type === "http" || node.type === "fetch") {
    const method = String(node.method || "GET").toUpperCase();
    try {
      return `${method} · ${new URL(String(node.url ?? "").replace(/{{[^}]+}}/g, "x")).host}`;
    } catch {
      return `${method} · set a URL`;
    }
  }
  if (node.type === "mcp") return node.tool ? `MCP · ${node.tool}` : "MCP · list tools";
  if (node.type === "bash") return `bash · ${String(node.command || "set a command").split("\n")[0].slice(0, 22)}`;
  if (node.type === "code") return "JavaScript";
  if (node.type === "rag") {
    const count = (node.kb_ids ?? []).length;
    return `${count} knowledge base${count === 1 ? "" : "s"}`;
  }
  if (node.type === "if" || node.type === "filter") return conditionSummary(node);
  if (node.type === "switch") {
    const count = (node.rules ?? []).length;
    return `${count} rule${count === 1 ? "" : "s"}${node.fallback !== false ? " + default" : ""}`;
  }
  if (node.type === "set") {
    const count = Object.keys(node.assignments ?? {}).length;
    return `${count} field${count === 1 ? "" : "s"}`;
  }
  if (node.type === "merge") return node.mode === "append" ? "append items" : node.mode === "first" ? "first input" : "combine inputs";
  if (node.type === "wait") return `${Number(node.amount) || 0} ${node.unit || "seconds"}`;
  if (node.type === "limit") return `first ${Number(node.max) || 0} of ${node.field || "items"}`;
  if (node.type === "noop") return "pass through";
  if (node.type === "stop") return "stops the run";
  const agent = node.agent_id ? agentById(node.agent_id) : null;
  if (agent) return agent.name;
  return modelFor(node);
}

function webhookUrl(workflowId = state.workflow?.id) {
  const token = encodeURIComponent(state.workflow?.hookToken ?? "");
  return `${location.origin}/api/workflows/${workflowId}/hook?token=${token}`;
}

// ---------------------------------------------------------------------------
// layout helpers
// ---------------------------------------------------------------------------

function tidyLayout(graph) {
  const nodes = graph.nodes ?? [];
  if (!nodes.length) return graph;
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges ?? []) {
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
    adjacency.get(edge.from).push(edge.to);
    indegree.set(edge.to, indegree.get(edge.to) + 1);
  }

  const depth = new Map();
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  for (const id of queue) depth.set(id, 0);
  const seen = new Set(queue);
  while (queue.length) {
    const id = queue.shift();
    for (const next of adjacency.get(id)) {
      depth.set(next, Math.max(depth.get(next) ?? 0, depth.get(id) + 1));
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  nodes.forEach((node, index) => {
    if (!depth.has(node.id)) depth.set(node.id, index % 5);
  });

  const columns = new Map();
  for (const node of nodes) {
    const level = depth.get(node.id);
    if (!columns.has(level)) columns.set(level, []);
    columns.get(level).push(node);
  }

  const widest = Math.max(...[...columns.values()].map((column) => column.length));
  const middle = 120 + ((widest - 1) * 150) / 2;
  for (const [level, column] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    column.forEach((node, index) => {
      node.x = 96 + level * COLUMN;
      node.y = Math.round(middle + (index - (column.length - 1) / 2) * 172 - 56);
    });
  }
  return graph;
}

function looksVertical(graph) {
  const nodes = graph.nodes ?? [];
  if (nodes.length < 2) return false;
  const firstX = nodes[0].x;
  return nodes.every((node) => Math.abs(node.x - firstX) < 2);
}

function applyView() {
  el.canvas.style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.zoom})`;
  el.zoomLabel.textContent = `${Math.round(state.view.zoom * 100)}%`;
}

function canvasPoint(event) {
  const rect = el.canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / state.view.zoom,
    y: (event.clientY - rect.top) / state.view.zoom,
  };
}

function fitView() {
  const nodes = nodesOf();
  if (!nodes.length) {
    state.view = { zoom: 1, x: 60, y: 80 };
    applyView();
    return;
  }
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x)) + NODE_W;
  const maxY = Math.max(...nodes.map((node) => node.y)) + NODE_H + 40;
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const viewWidth = el.canvasWrap.clientWidth;
  const viewHeight = el.canvasWrap.clientHeight;
  const zoom = clamp(Math.min((viewWidth - 140) / width, (viewHeight - 150) / height), 0.32, 1.1);
  state.view = {
    zoom,
    x: (viewWidth - width * zoom) / 2 - minX * zoom,
    y: (viewHeight - height * zoom) / 2 - minY * zoom,
  };
  applyView();
}

function zoomBy(factor) {
  const wrapRect = el.canvasWrap.getBoundingClientRect();
  const px = wrapRect.width / 2;
  const py = wrapRect.height / 2;
  const worldX = (px - state.view.x) / state.view.zoom;
  const worldY = (py - state.view.y) / state.view.zoom;
  state.view.zoom = clamp(state.view.zoom * factor, 0.25, 1.9);
  state.view.x = px - worldX * state.view.zoom;
  state.view.y = py - worldY * state.view.zoom;
  applyView();
}

// ---------------------------------------------------------------------------
// canvas rendering
// ---------------------------------------------------------------------------

function nodeHtml(node) {
  const meta = NODE_META[node.type] ?? NODE_META.agent;
  return `
    <div class="node" data-id="${esc(node.id)}" style="left:${Number(node.x) || 0}px;top:${Number(node.y) || 0}px;--node-color:${meta.color}">
      <div class="node-card">
        <span class="node-badge"></span>
        <span class="port in"></span>
        <span class="node-icon">${ICONS[node.type] ?? ICONS.agent}</span>
        ${outputPorts(node)
          .map(
            (port) =>
              `<span class="port out${port.label ? " branch" : ""}" data-branch="${esc(port.branch)}" style="top:${Math.round(
                (portY(node, port.branch) / NODE_H) * 100,
              )}%" title="Drag to connect${port.label ? ` · ${port.label}` : ""}">${
                port.label ? `<em>${esc(port.label)}</em>` : ""
              }</span>`,
          )
          .join("")}
        <button class="add-handle" title="Add a connected node">+</button>
      </div>
      <div class="node-label">${esc(node.title || meta.label)}</div>
      <div class="node-sub">${esc(subtitleFor(node))}</div>
    </div>`;
}

function renderCanvas() {
  const graph = state.workflow?.graph ?? { nodes: [], edges: [] };
  el.nodes.innerHTML = graph.nodes.map(nodeHtml).join("");
  for (const card of el.nodes.querySelectorAll(".node")) {
    card.classList.toggle("selected", card.dataset.id === state.selected);
  }
  $("#empty-hint").hidden = graph.nodes.length > 0;
  applyView();
  drawEdges();
  applyBadges();
}

// Branching nodes carry one output port per branch; every other node has one.
function outputPorts(node) {
  if (node.type === "if") {
    return [
      { branch: "true", label: "true" },
      { branch: "false", label: "false" },
    ];
  }
  if (node.type === "switch") {
    const rules = Array.isArray(node.rules) ? node.rules : [];
    const ports = rules.map((rule, index) => ({ branch: String(index), label: String(index + 1) }));
    if (node.fallback !== false) ports.push({ branch: "fallback", label: "default" });
    return ports.length ? ports : [{ branch: "fallback", label: "default" }];
  }
  return [{ branch: "", label: "" }];
}

function portY(node, branch = "") {
  const ports = outputPorts(node);
  if (ports.length === 1) return PORT_Y;
  const index = Math.max(0, ports.findIndex((port) => port.branch === (branch ?? "")));
  return ((index + 1) / (ports.length + 1)) * NODE_H;
}

function nextBranchFor(node) {
  if (!node) return "";
  const ports = outputPorts(node);
  if (ports.length === 1) return "";
  const used = new Set(
    (state.workflow?.graph.edges ?? []).filter((edge) => edge.from === node.id && edge.branch).map((edge) => edge.branch),
  );
  const free = ports.find((port) => !used.has(port.branch));
  return (free ?? ports[ports.length - 1]).branch;
}

function outPoint(node, branch = "") {
  return { x: node.x + NODE_W, y: node.y + portY(node, branch) };
}

function inPoint(node) {
  return { x: node.x, y: node.y + PORT_Y };
}

function curve(from, to) {
  const bend = Math.max(48, Math.abs(to.x - from.x) * 0.42);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}

function drawEdges() {
  const graph = state.workflow?.graph;
  if (!graph) return;
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  el.edgeLayer.innerHTML = graph.edges
    .map((edge) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return "";
      const branch = edge.branch ?? "";
      const key = `${edge.from}|${branch}|${edge.to}`;
      const path = curve(outPoint(from, branch), inPoint(to));
      const selected = state.selectedEdge === key;
      const marker = selected ? "arrow-hot" : "arrow";
      const labelText =
        branch === "fallback"
          ? "default"
          : branch && /^\d+$/.test(branch) && from.type === "switch"
            ? `output ${Number(branch) + 1}`
            : branch || (from.type === "check" ? "pass" : "");
      const label = labelText
        ? `<text class="edge-label" x="${from.x + NODE_W + 6}" y="${from.y + portY(from, branch) - 7}">${esc(labelText)}</text>`
        : "";
      return `<path class="edge-hit" data-edge="${esc(key)}" d="${path}"></path>
        <path class="edge${selected ? " selected" : ""}" d="${path}" marker-end="url(#${marker})"></path>${label}`;
    })
    .join("");
}

function cardEl(id) {
  return el.nodes.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
}

function updateCard(node) {
  const card = cardEl(node.id);
  if (!card) return;
  const label = $(".node-label", card);
  const sub = $(".node-sub", card);
  if (label) label.textContent = node.title || NODE_META[node.type]?.label || node.type;
  if (sub) sub.textContent = subtitleFor(node);
}

function applyBadges() {
  const rows = state.run?.nodes ?? new Map();
  for (const card of el.nodes.querySelectorAll(".node")) {
    const row = rows.get(card.dataset.id);
    const status = row?.status;
    const badge = $(".node-badge", card);
    if (!status) {
      card.removeAttribute("data-status");
      if (badge) badge.textContent = "";
      continue;
    }
    card.dataset.status = status;
    if (badge) {
      badge.textContent =
        status === "passed"
          ? "✓"
          : status === "failed"
            ? "✕"
            : status === "cached"
              ? "↺"
              : status === "skipped"
                ? "–"
                : "•";
    }
  }
}

function selectNode(id) {
  state.selected = id;
  state.selectedEdge = null;
  for (const card of el.nodes.querySelectorAll(".node")) {
    card.classList.toggle("selected", card.dataset.id === id);
  }
  if (id) {
    state.dockNode = id;
    renderNdv();
    if (state.run) {
      renderDockRows();
      renderDockDetail();
    }
  } else {
    el.ndv.hidden = true;
  }
  updateNdvVisibility();
}

function updateNdvVisibility() {
  el.ndv.hidden = !selectedNode();
}

// ---------------------------------------------------------------------------
// pointer interaction
// ---------------------------------------------------------------------------

let drag = null;
let pan = null;
let connect = null;

el.nodes.addEventListener("pointerdown", (event) => {
  const card = event.target.closest(".node");
  if (!card) return;
  const node = nodeById(card.dataset.id);
  if (!node) return;

  if (event.target.closest(".add-handle")) {
    event.preventDefault();
    event.stopPropagation();
    const rect = el.canvasWrap.getBoundingClientRect();
    openAddPopover(event.clientX - rect.left, event.clientY - rect.top, node);
    return;
  }

  selectNode(node.id);
  const point = canvasPoint(event);

  const outPort = event.target.closest(".port.out");
  if (outPort) {
    connect = { from: node.id, branch: outPort.dataset.branch || "", x: point.x, y: point.y };
    drawTemp();
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  drag = { id: node.id, dx: point.x - node.x, dy: point.y - node.y, moved: false };
  card.classList.add("dragging");
  event.preventDefault();
});

el.canvasWrap.addEventListener("pointerdown", (event) => {
  if (event.target.closest(".node") || event.target.closest("button") || event.target.closest("#add-popover")) {
    return;
  }
  closePopover();
  selectNode(null);
  pan = { sx: event.clientX, sy: event.clientY, x: state.view.x, y: state.view.y };
  el.canvasWrap.classList.add("panning");
});

window.addEventListener("pointermove", (event) => {
  if (drag) {
    const node = nodeById(drag.id);
    if (!node) return;
    const point = canvasPoint(event);
    const x = Math.round(point.x - drag.dx);
    const y = Math.round(point.y - drag.dy);
    if (Math.abs(x - node.x) > 1 || Math.abs(y - node.y) > 1) drag.moved = true;
    node.x = x;
    node.y = y;
    const card = cardEl(drag.id);
    if (card) {
      card.style.left = `${x}px`;
      card.style.top = `${y}px`;
    }
    drawEdges();
    return;
  }
  if (connect) {
    const point = canvasPoint(event);
    connect.x = point.x;
    connect.y = point.y;
    drawTemp();
    return;
  }
  if (pan) {
    state.view.x = pan.x + (event.clientX - pan.sx);
    state.view.y = pan.y + (event.clientY - pan.sy);
    applyView();
  }
});

window.addEventListener("pointerup", (event) => {
  if (drag) {
    cardEl(drag.id)?.classList.remove("dragging");
    if (drag.moved) scheduleSave();
    drag = null;
  }
  if (connect) {
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".node");
    const from = connect.from;
    const branch = connect.branch;
    connect = null;
    drawTemp();
    if (target && target.dataset.id !== from) addEdge(from, target.dataset.id, branch);
  }
  if (pan) {
    pan = null;
    el.canvasWrap.classList.remove("panning");
  }
});

function drawTemp() {
  if (!connect) {
    el.tempEdge.setAttribute("d", "");
    return;
  }
  const from = nodeById(connect.from);
  if (!from) return;
  el.tempEdge.setAttribute("d", curve(outPoint(from, connect.branch), { x: connect.x, y: connect.y }));
}

el.canvasWrap.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const rect = el.canvasWrap.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const worldX = (px - state.view.x) / state.view.zoom;
    const worldY = (py - state.view.y) / state.view.zoom;
    const factor = event.deltaY < 0 ? 1.1 : 0.9;
    state.view.zoom = clamp(state.view.zoom * factor, 0.25, 1.9);
    state.view.x = px - worldX * state.view.zoom;
    state.view.y = py - worldY * state.view.zoom;
    applyView();
  },
  { passive: false },
);

el.canvasWrap.addEventListener("dblclick", (event) => {
  const card = event.target.closest(".node");
  if (card) {
    selectNode(card.dataset.id);
    openNdv();
    return;
  }
  if (event.target.closest("button") || event.target.closest("#add-popover")) return;
  const rect = el.canvasWrap.getBoundingClientRect();
  openAddPopover(event.clientX - rect.left, event.clientY - rect.top, null);
});

el.edgeLayer.addEventListener("click", (event) => {
  const hit = event.target.closest("[data-edge]");
  if (!hit) return;
  const key = hit.dataset.edge;
  state.selectedEdge = state.selectedEdge === key ? null : key;
  state.selected = null;
  for (const card of el.nodes.querySelectorAll(".node")) card.classList.remove("selected");
  el.ndv.hidden = true;
  drawEdges();
});

function addEdge(from, to, branch = "") {
  const graph = state.workflow?.graph;
  if (!graph) return;
  if (!nodeById(from) || !nodeById(to)) return;
  if (graph.edges.some((edge) => edge.from === from && edge.to === to && (edge.branch ?? "") === branch)) return;
  graph.edges.push(branch ? { from, to, branch } : { from, to });
  drawEdges();
  scheduleSave();
}

$("#zoombar").addEventListener("click", (event) => {
  const zoom = event.target.closest("[data-zoom]");
  if (zoom) {
    zoomBy(zoom.dataset.zoom === "in" ? 1.15 : 0.87);
    return;
  }
  if (event.target.closest("#zoom-fit")) fitView();
});

$("#tidy-rail").addEventListener("click", tidyAndSave);

function tidyAndSave() {
  if (!state.workflow) return;
  tidyLayout(state.workflow.graph);
  renderCanvas();
  fitView();
  scheduleSave();
}

// ---------------------------------------------------------------------------
// add-node popover
// ---------------------------------------------------------------------------

function openAddPopover(clientX, clientY, sourceNode) {
  state.addFrom = sourceNode?.id ?? null;
  el.popList.innerHTML = Object.entries(NODE_META)
    .filter(([type]) => state.capabilities?.exec !== false || (type !== "bash" && type !== "code"))
    .map(
      ([type, meta]) => `
      <button class="pop-item" data-type="${type}">
        <span class="pop-icon" style="--node-color:${meta.color}">${ICONS[type]}</span>
        <span class="pop-text"><strong>${meta.label}</strong><span>${esc(meta.blurb)}</span></span>
      </button>`,
    )
    .join("");

  el.popover.hidden = false;
  const wrapWidth = el.canvasWrap.clientWidth;
  const width = 244;
  const left = clamp(clientX, 12, Math.max(12, wrapWidth - width - 12));
  const top = clamp(clientY, 12, Math.max(12, el.canvasWrap.clientHeight - 260));
  el.popover.style.left = `${left}px`;
  el.popover.style.top = `${top}px`;
}

function closePopover() {
  el.popover.hidden = true;
  state.addFrom = null;
}

el.popList.addEventListener("click", (event) => {
  const item = event.target.closest("[data-type]");
  if (!item) return;
  const from = state.addFrom;
  const source = from ? nodeById(from) : null;
  const center = canvasPointAligned();
  const position = source ? { x: source.x + COLUMN, y: source.y } : center;
  const branch = nextBranchFor(source);
  closePopover();
  addNode(item.dataset.type, position, from, branch);
});

function canvasPointAligned() {
  return {
    x: (el.canvasWrap.clientWidth / 2 - state.view.x) / state.view.zoom - NODE_W / 2,
    y: (el.canvasWrap.clientHeight / 2 - state.view.y) / state.view.zoom - NODE_H / 2,
  };
}

$("#add-node-btn").addEventListener("click", (event) => {
  const rect = el.canvasWrap.getBoundingClientRect();
  openAddPopover(event.clientX - rect.left, event.clientY - rect.top + 10, null);
});

document.addEventListener("pointerdown", (event) => {
  if (!el.popover.hidden && !event.target.closest("#add-popover") && !event.target.closest(".add-handle") && !event.target.closest("#add-node-btn")) {
    closePopover();
  }
});

function nodeDefaults(type) {
  const base = {
    id: `${type}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    title: NODE_META[type].label,
    x: 0,
    y: 0,
  };
  if (type === "trigger") {
    return {
      ...base,
      title: "Trigger",
      mode: "manual",
      every_minutes: 15,
      sample_input: '{\n  "message": "hello"\n}',
    };
  }
  if (type === "http") {
    return {
      ...base,
      title: "HTTP Request",
      method: "GET",
      url: "https://httpbin.org/get",
      headers: "{}",
      body: "",
      credential_id: "",
      max_retries: 2,
      timeout_ms: 30000,
    };
  }
  if (type === "check") {
    return {
      ...base,
      title: "Check",
      prompt: "Reject the handoff if it is off-brief, incomplete or inconsistent. Otherwise pass it.",
      contract: {},
      credential_id: "",
      model: "",
      max_retries: 1,
      timeout_ms: 60000,
    };
  }
  if (type === "fetch") {
    return {
      ...base,
      title: "Fetch",
      method: "GET",
      url: "https://httpbin.org/json",
      format: "auto",
      headers: "{}",
      credential_id: "",
      max_retries: 2,
      timeout_ms: 30000,
    };
  }
  if (type === "mcp") {
    return {
      ...base,
      title: "MCP tool",
      transport: "http",
      server_url: "",
      command: "",
      cwd: "",
      tool: "",
      tool_args: "{}",
      credential_id: "",
      max_retries: 1,
      timeout_ms: 30000,
    };
  }
  if (type === "bash") {
    return {
      ...base,
      title: "Run command",
      command: 'echo "hello from Sequor"',
      cwd: "",
      max_retries: 0,
      timeout_ms: 60000,
    };
  }
  if (type === "code") {
    return {
      ...base,
      title: "Code",
      code: "// input is the previous node's output\nreturn { ...input, ran: true };",
      max_retries: 0,
      timeout_ms: 15000,
    };
  }
  if (type === "rag") {
    return {
      ...base,
      title: "Knowledge search",
      kb_ids: [],
      query: "",
      top_k: 5,
      use_memory: true,
      max_retries: 1,
      timeout_ms: 15000,
    };
  }
  if (type === "if") {
    return {
      ...base,
      title: "IF",
      conditions: [{ left: "{{ status }}", operator: "equals", right: "done" }],
      combine: "and",
      max_retries: 0,
      timeout_ms: 10000,
    };
  }
  if (type === "switch") {
    return {
      ...base,
      title: "Switch",
      rules: [{ left: "{{ status }}", operator: "equals", right: "done" }],
      fallback: true,
      max_retries: 0,
      timeout_ms: 10000,
    };
  }
  if (type === "filter") {
    return {
      ...base,
      title: "Filter",
      conditions: [{ left: "{{ status }}", operator: "equals", right: "done" }],
      combine: "and",
      max_retries: 0,
      timeout_ms: 10000,
    };
  }
  if (type === "merge") {
    return { ...base, title: "Merge", mode: "combine", max_retries: 0, timeout_ms: 10000 };
  }
  if (type === "set") {
    return {
      ...base,
      title: "Edit Fields",
      assignments: { status: "{{ status }}" },
      keep_input: true,
      max_retries: 0,
      timeout_ms: 10000,
    };
  }
  if (type === "wait") {
    return { ...base, title: "Wait", amount: 1, unit: "seconds", max_retries: 0, timeout_ms: 0 };
  }
  if (type === "limit") {
    return { ...base, title: "Limit", field: "items", max: 10, max_retries: 0, timeout_ms: 10000 };
  }
  if (type === "noop") {
    return { ...base, title: "No Operation", max_retries: 0, timeout_ms: 0 };
  }
  if (type === "stop") {
    return { ...base, title: "Stop and Error", message: "Workflow stopped on purpose.", max_retries: 0, timeout_ms: 0 };
  }
  return {
    ...base,
    title: "Agent",
    prompt: "Describe the one job this agent does, and only that.",
    contract: { summary: "string" },
    credential_id: "",
    model: "",
    temperature: 0.4,
    kb_ids: [],
    kb_top_k: 5,
    use_memory: true,
    max_retries: 1,
    timeout_ms: 90000,
  };
}

function addNode(type, position, fromId = null, branch = "") {
  if (!state.workflow) return;
  const node = nodeDefaults(type);
  node.x = Math.round(position?.x ?? 160);
  node.y = Math.round(position?.y ?? 160);
  state.workflow.graph.nodes.push(node);
  if (fromId) state.workflow.graph.edges.push(branch ? { from: fromId, to: node.id, branch } : { from: fromId, to: node.id });
  renderCanvas();
  selectNode(node.id);
  scheduleSave();
  toast(`${NODE_META[type].label} added.`);
}

// ---------------------------------------------------------------------------
// node detail panel
// ---------------------------------------------------------------------------

function openNdv() {
  if (!selectedNode()) return;
  state.ndvTab = "params";
  renderNdv();
}

function field(label, control, hint = "") {
  return `<label class="field"><span>${esc(label)}</span>${control}${hint ? `<span class="hint">${hint}</span>` : ""}</label>`;
}

function credentialSelect(node, { allowNone = true } = {}) {
  const options = [];
  if (allowNone) {
    options.push(
      `<option value="">${state.env?.configured ? `Environment key (${esc(state.env.model)})` : "No credential"}</option>`,
    );
  }
  for (const credential of state.credentials) {
    options.push(
      `<option value="${esc(credential.id)}" ${credential.id === node.credential_id ? "selected" : ""}>${esc(credential.name)} · ${esc(credential.hint)}</option>`,
    );
  }
  return `<select data-prop="credential_id" data-rerender="1">${options.join("")}</select>
    <div class="cred-hint">${state.credentials.length ? "Keys stay on the server." : "No key saved yet."}
      <button type="button" class="link-btn" data-goto="credentials">Manage credentials</button>
    </div>`;
}

function kbPicker(node) {
  const selected = new Set(Array.isArray(node.kb_ids) ? node.kb_ids : []);
  if (!state.knowledge.length) {
    return `<p class="hint">No knowledge bases yet. <button type="button" class="link-btn" data-goto="knowledge">Create one</button></p>`;
  }
  return `<div class="kb-picks">${state.knowledge
    .map(
      (kb) => `<label class="check-row"><input type="checkbox" data-kb="${esc(kb.id)}" ${
        selected.has(kb.id) ? "checked" : ""
      } /><span>${esc(kb.name)} <em class="muted">${kb.documents} doc${kb.documents === 1 ? "" : "s"} · ${kb.chunks} chunks</em></span></label>`,
    )
    .join("")}</div>`;
}

function agentSelect(node) {
  const current = node.agent_id ? agentById(node.agent_id) : null;
  const options = [`<option value="">No agent · pick a credential</option>`].concat(
    state.agents.map(
      (agent) =>
        `<option value="${esc(agent.id)}" ${agent.id === node.agent_id ? "selected" : ""}>${esc(agent.name)}${
          agent.model ? ` · ${esc(agent.model)}` : ""
        }</option>`,
    ),
  );
  const summary = current
    ? `${esc(current.model || "agent model")} · ${enabledToolCount(current.tools)} tools · ${current.skills.length} skills · ${
        current.mcpServers.filter((server) => server.enabled).length
      } MCP`
    : state.agents.length
      ? "Agents bundle the model, key, skills, MCP servers and tool permissions."
      : "No agents yet. Create one on the Agents tab, or import an opencode.json.";
  return `<select data-prop="agent_id" data-rerender="1">${options.join("")}</select>
    <div class="cred-hint">${summary}
      <button type="button" class="link-btn" data-goto="agents">${current ? "Edit agent" : "Manage agents"}</button>
    </div>`;
}

function operatorOptions(current) {
  return CONDITION_OPERATORS.map(
    ([value, label]) => `<option value="${value}" ${value === (current || "equals") ? "selected" : ""}>${label}</option>`,
  ).join("");
}

function conditionsEditor(node) {
  const conditions =
    Array.isArray(node.conditions) && node.conditions.length
      ? node.conditions
      : [{ left: "", operator: "equals", right: "" }];
  const rows = conditions
    .map(
      (condition, index) => `
      <div class="cond-row">
        <input data-cond="${index}:left" value="${esc(condition.left ?? "")}" placeholder="{{ field }}" spellcheck="false" />
        <select data-cond="${index}:operator">${operatorOptions(condition.operator)}</select>
        <input data-cond="${index}:right" value="${esc(condition.right ?? "")}" placeholder="value" spellcheck="false" />
        <button class="icon-x sm" type="button" data-cond-remove="${index}" title="Remove condition">✕</button>
      </div>`,
    )
    .join("");
  const combine =
    conditions.length > 1
      ? field(
          "Match",
          `<select data-prop="combine" data-rerender="1">
            <option value="and" ${node.combine !== "or" ? "selected" : ""}>all conditions (AND)</option>
            <option value="or" ${node.combine === "or" ? "selected" : ""}>any condition (OR)</option>
          </select>`,
        )
      : "";
  return `<div class="ndv-section">
    <h3>Conditions</h3>
    <p class="hint">Templates work here: <span class="mono">{{ status }}</span>, or a bare field name like <span class="mono">status</span>. Values compare as numbers when both look numeric.</p>
    ${combine}
    <div class="cond-list">${rows}</div>
    <button class="btn sm" type="button" data-cond-add>Add condition</button>
  </div>`;
}

function rulesEditor(node) {
  const rules =
    Array.isArray(node.rules) && node.rules.length ? node.rules : [{ left: "", operator: "equals", right: "" }];
  const rows = rules
    .map(
      (rule, index) => `
      <div class="cond-row rule">
        <span class="rule-out">${index + 1}</span>
        <input data-rule="${index}:left" value="${esc(rule.left ?? "")}" placeholder="{{ field }}" spellcheck="false" />
        <select data-rule="${index}:operator">${operatorOptions(rule.operator)}</select>
        <input data-rule="${index}:right" value="${esc(rule.right ?? "")}" placeholder="value" spellcheck="false" />
        <button class="icon-x sm" type="button" data-rule-remove="${index}" title="Remove rule">✕</button>
      </div>`,
    )
    .join("");
  return `<div class="ndv-section">
    <h3>Rules</h3>
    <p class="hint">The first matching rule fires its own output. Each rule gets a numbered port on the right edge of the node.</p>
    <div class="cond-list">${rows}</div>
    <button class="btn sm" type="button" data-rule-add>Add rule</button>
    <label class="check-row"><input type="checkbox" data-prop="fallback" ${node.fallback !== false ? "checked" : ""} /><span>Send unmatched data to the default output</span></label>
  </div>`;
}

function paramsHtml(node) {
  if (node.type === "trigger") {
    const parts = [
      field(
        "Trigger type",
        `<select data-prop="mode" data-rerender="1">
          <option value="manual" ${node.mode !== "webhook" && node.mode !== "schedule" ? "selected" : ""}>Manual</option>
          <option value="schedule" ${node.mode === "schedule" ? "selected" : ""}>Schedule</option>
          <option value="webhook" ${node.mode === "webhook" ? "selected" : ""}>Webhook</option>
        </select>`,
      ),
    ];

    if (node.mode === "schedule") {
      parts.push(
        field(
          "Run every (minutes)",
          `<input type="number" min="1" data-prop="every_minutes" value="${Number(node.every_minutes) || 15}" />`,
          "The server fires this while the workflow is Active. The payload below is sent each time.",
        ),
      );
    }

    if (node.mode === "webhook") {
      parts.push(`
        <div class="ndv-section">
          <h3>Webhook URL</h3>
          <div class="copy-row">
            <input readonly value="${esc(webhookUrl())}" id="hook-url" />
            <button class="btn sm" type="button" id="copy-hook">Copy</button>
            <button class="btn sm" type="button" data-rotate-hook>Rotate</button>
          </div>
          <p class="hint">POST any JSON to this URL. Every call starts a real run:
            <span class="mono">curl -X POST -H 'content-type: application/json' -d '{"event":"ping"}' ${esc(webhookUrl())}</span>
          </p>
        </div>`);
    }

    parts.push(
      field(
        "Payload (JSON)",
        `<textarea rows="8" data-jsontext="sample_input" spellcheck="false">${esc(node.sample_input ?? "{}")}</textarea>
         <div class="json-error" data-error="sample_input"></div>`,
        "Used by manual runs and by the schedule trigger.",
      ),
    );
    return parts.join("");
  }

  if (node.type === "http") {
    return `
      <div class="ndv-row">
        <label class="field"><span>Method</span>
          <select data-prop="method">
            ${["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]
              .map(
                (method) =>
                  `<option value="${method}" ${String(node.method || "GET").toUpperCase() === method ? "selected" : ""}>${method}</option>`,
              )
              .join("")}
          </select>
        </label>
        <label class="field"><span>Timeout (ms)</span>
          <input type="number" min="1000" step="1000" data-prop="timeout_ms" value="${Number(node.timeout_ms) || 30000}" />
        </label>
      </div>
      ${field(
        "URL",
        `<input data-prop="url" value="${esc(node.url ?? "")}" placeholder="https://api.example.com/items" spellcheck="false" />`,
        "Use <span class='mono'>{{ field }}</span> to inject the previous node's output, e.g. <span class='mono'>https://api.github.com/repos/{{ repo }}/issues</span>.",
      )}
      ${field(
        "Headers (JSON)",
        `<textarea rows="4" data-json="headers" spellcheck="false">${esc(node.headers && node.headers !== "" ? node.headers : "{}")}</textarea>
         <div class="json-error" data-error="headers"></div>`,
      )}
      ${field(
        "Body",
        `<textarea rows="6" data-prop="body" spellcheck="false" placeholder='{ "text": "{{ summary }}" }'>${esc(node.body ?? "")}</textarea>`,
        "JSON is sent as JSON. Any other text is sent as-is.",
      )}
      ${field("Auth", credentialSelect(node), "When set, sent as <span class='mono'>Authorization: Bearer …</span>.")}
      ${field(
        "Retries",
        `<input type="number" min="0" max="10" data-prop="max_retries" value="${Number(node.max_retries ?? 2)}" />`,
        "A non-2xx response is an error, so retries re-send the request.",
      )}`;
  }

  if (node.type === "fetch") {
    return `${field(
      "URL",
      `<input data-prop="url" value="${esc(node.url ?? "")}" placeholder="https://api.example.com/items.json" spellcheck="false" />`,
      "Templates work here: <span class='mono'>https://api.github.com/repos/{{ repo }}</span>.",
    )}
    <div class="ndv-row">
      ${field(
        "Method",
        `<select data-prop="method">${["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]
          .map(
            (method) =>
              `<option value="${method}" ${String(node.method || "GET").toUpperCase() === method ? "selected" : ""}>${method}</option>`,
          )
          .join("")}</select>`,
      )}
      ${field(
        "Format",
        `<select data-prop="format">
          <option value="auto" ${node.format !== "json" && node.format !== "text" ? "selected" : ""}>Auto</option>
          <option value="json" ${node.format === "json" ? "selected" : ""}>JSON only</option>
          <option value="text" ${node.format === "text" ? "selected" : ""}>Text</option>
        </select>`,
      )}
    </div>
    ${field(
      "Headers (JSON)",
      `<textarea rows="3" data-json="headers" spellcheck="false">${esc(node.headers && node.headers !== "" ? node.headers : "{}")}</textarea>
       <div class="json-error" data-error="headers"></div>`,
    )}
    ${field("Auth", credentialSelect(node), "Sent as <span class='mono'>Authorization: Bearer …</span> when set.")}
    ${field("Retries", `<input type="number" min="0" max="10" data-prop="max_retries" value="${Number(node.max_retries ?? 2)}" />`)}`;
  }

  if (node.type === "mcp") {
    const transport = node.transport === "stdio" ? "stdio" : "http";
    return `${field(
      "Transport",
      `<select data-prop="transport" data-rerender="1">
        <option value="http" ${transport === "http" ? "selected" : ""}>Streamable HTTP</option>
        <option value="stdio" ${transport === "stdio" ? "selected" : ""}>stdio command</option>
      </select>`,
    )}
    ${
      transport === "http"
        ? field(
            "Server URL",
            `<input data-prop="server_url" value="${esc(node.server_url ?? "")}" placeholder="https://mcp.example.com/mcp" spellcheck="false" />`,
            "The MCP endpoint. Add a credential above for a bearer token.",
          )
        : field(
            "Command",
            `<input data-prop="command" value="${esc(node.command ?? "")}" placeholder="npx -y @modelcontextprotocol/server-filesystem /tmp" spellcheck="false" />`,
            "Started with <span class='mono'>bash -lc</span> on this machine and spoken to over stdio.",
          )
    }
    ${field(
      "Tool",
      `<input data-prop="tool" value="${esc(node.tool ?? "")}" placeholder="leave empty to list tools" spellcheck="false" />`,
      "No model is called: this node speaks MCP directly.",
    )}
    ${field(
      "Arguments (JSON)",
      `<textarea rows="5" data-json="tool_args" spellcheck="false">${esc(node.tool_args || "{}")}</textarea>
       <div class="json-error" data-error="tool_args"></div>`,
      "Templates work here too: <span class='mono'>{\"path\": \"{{ file }}\"}</span>",
    )}
    ${field("Auth", credentialSelect(node))}`;
  }

  if (node.type === "bash") {
    return `${field(
      "Command",
      `<textarea rows="7" class="mono-input" data-prop="command" spellcheck="false">${esc(node.command ?? "")}</textarea>`,
      "Runs with <span class='mono'>bash -lc</span>. The previous output is on stdin as JSON and in <span class='mono'>$SEQUOR_INPUT</span>.",
    )}
    ${field(
      "Working directory",
      `<input data-prop="cwd" value="${esc(node.cwd ?? "")}" placeholder="defaults to the Sequor folder" spellcheck="false" />`,
    )}
    ${field("Timeout (ms)", `<input type="number" min="1000" step="1000" data-prop="timeout_ms" value="${Number(node.timeout_ms) || 60000}" />`, "A command that exits non-zero is a node error, so retries mean something.")}`;
  }

  if (node.type === "code") {
    return `<div class="ndv-section">
      <h3>JavaScript</h3>
      <p class="hint">Body of an async function. <span class="mono">input</span> holds the previous node's output; return a JSON object. <span class="mono">console.log</span> lands in the node log.</p>
      <textarea rows="14" class="code-input" data-prop="code" spellcheck="false">${esc(node.code ?? "")}</textarea>
    </div>
    ${field("Timeout (ms)", `<input type="number" min="100" step="500" data-prop="timeout_ms" value="${Number(node.timeout_ms) || 15000}" />`, "Code runs in a vm context, not a hardened sandbox. Treat it as your own machine.")}`;
  }

  if (node.type === "rag") {
    return `${kbPicker(node)}
      ${field(
        "Query (template)",
        `<input data-prop="query" value="${esc(node.query ?? "")}" placeholder="{{ message }}" spellcheck="false" />`,
        "Leave empty to search with the previous node's whole output.",
      )}
      <div class="ndv-row">
        ${field("Passages", `<input type="number" min="1" max="20" data-prop="top_k" value="${Number(node.top_k) || 5}" />`)}
        ${field("Retries", `<input type="number" min="0" max="5" data-prop="max_retries" value="${Number(node.max_retries ?? 1)}" />`)}
      </div>
      <label class="check-row"><input type="checkbox" data-prop="use_memory" ${node.use_memory !== false ? "checked" : ""} /><span>Include workspace memory in the results</span></label>
      <button type="button" class="link-btn" data-goto="knowledge">Manage knowledge</button>`;
  }

  if (node.type === "if") {
    return `${conditionsEditor(node)}
      <p class="hint">This node has two outputs: drag from <span class="mono">true</span> or <span class="mono">false</span> on its right edge. The side that does not fire is skipped, along with everything only it feeds.</p>`;
  }

  if (node.type === "filter") {
    return `${conditionsEditor(node)}
      <p class="hint">Keeps the incoming data when the conditions match. When they don't, the node passes nothing on and its downstream nodes are skipped.</p>`;
  }

  if (node.type === "switch") return rulesEditor(node);

  if (node.type === "set") {
    return `${field(
      "Fields to set (JSON)",
      `<textarea rows="7" data-json="assignments" spellcheck="false">${esc(JSON.stringify(node.assignments ?? {}, null, 2))}</textarea>
       <div class="json-error" data-error="assignments"></div>`,
      "Values accept templates: <span class='mono'>{\"title\": \"{{ name }} — done\"}</span>.",
    )}
    <label class="check-row"><input type="checkbox" data-prop="keep_input" ${node.keep_input !== false ? "checked" : ""} /><span>Keep the other input fields</span></label>`;
  }

  if (node.type === "merge") {
    return `${field(
      "Mode",
      `<select data-prop="mode" data-rerender="1">
        <option value="combine" ${node.mode !== "append" && node.mode !== "first" ? "selected" : ""}>Combine fields from every input</option>
        <option value="append" ${node.mode === "append" ? "selected" : ""}>Append the items of every input</option>
        <option value="first" ${node.mode === "first" ? "selected" : ""}>Keep only the first input</option>
      </select>`,
      "Connect more than one node into Merge; the run waits for all of them.",
    )}
    <p class="hint">Inputs merge in the order their connections were made.</p>`;
  }

  if (node.type === "wait") {
    return `<div class="ndv-row">
      ${field("Amount", `<input type="number" min="0" step="1" data-prop="amount" value="${Number(node.amount) || 0}" />`)}
      ${field(
        "Unit",
        `<select data-prop="unit">
          <option value="seconds" ${node.unit !== "minutes" && node.unit !== "hours" ? "selected" : ""}>Seconds</option>
          <option value="minutes" ${node.unit === "minutes" ? "selected" : ""}>Minutes</option>
          <option value="hours" ${node.unit === "hours" ? "selected" : ""}>Hours</option>
        </select>`,
      )}
    </div>
    <p class="hint">The run pauses here until the wait is over. Cancelling the run ends the wait; the cap is one hour.</p>`;
  }

  if (node.type === "limit") {
    return `<div class="ndv-row">
      ${field(
        "Field",
        `<input data-prop="field" value="${esc(node.field ?? "items")}" placeholder="items" spellcheck="false" />`,
        "Top-level key that holds the array.",
      )}
      ${field("Keep first", `<input type="number" min="0" data-prop="max" value="${Number(node.max) || 0}" />`)}
    </div>`;
  }

  if (node.type === "noop") {
    return `<p class="hint">Does nothing and passes its input through. Useful as a join point or as a readable end of a branch.</p>`;
  }

  if (node.type === "stop") {
    return field(
      "Error message",
      `<input data-prop="message" value="${esc(node.message ?? "")}" placeholder="Stop the run" spellcheck="false" />`,
      "Throws here, so the run is marked failed with this message.",
    );
  }

  const promptLabel = node.type === "check" ? "Review instruction" : "Prompt";
  const parts = [
    field("Agent", agentSelect(node), "The agent supplies the model, key, skills and the tools this step may use."),
    field(
      promptLabel,
      `<textarea rows="10" data-prop="prompt" spellcheck="false" placeholder="${
        node.type === "check" ? "Reject the handoff if…" : "What this agent should do, and only that"
      }">${esc(node.prompt ?? "")}</textarea>`,
      "Templates work here too: <span class='mono'>{{ topic }}</span> is replaced with the incoming value.",
    ),
    `<div class="ndv-row">
      ${node.agent_id ? "" : field("Credential", credentialSelect(node))}
      ${field("Model override", `<input data-prop="model" value="${esc(node.model ?? "")}" placeholder="${esc(agentById(node.agent_id)?.model || credentialById(node.credential_id)?.model || state.env?.model || "provider default")}" />`)}
    </div>`,
  ];

  if (node.type === "agent") {
    parts.push(`
      <div class="ndv-section">
        <h3>Output contract</h3>
        <p class="hint">The next node only receives fields that pass this contract. A rejected attempt is retried with the validation error as feedback.</p>
        <textarea rows="7" data-json="contract" spellcheck="false">${esc(JSON.stringify(node.contract ?? {}, null, 2))}</textarea>
        <div class="json-error" data-error="contract"></div>
        <p class="hint">Types: <span class="mono">string number boolean array object datetime</span>, enums <span class="mono">pass|fail</span>, optional with <span class="mono">?</span>.</p>
      </div>`);
  } else {
    parts.push(`
      <div class="ndv-section">
        <h3>Feedback loop</h3>
        <p class="hint">On a fail verdict this node re-runs its upstream agent with the reason as feedback, up to
        ${Number(node.max_retries ?? 0)} time${Number(node.max_retries ?? 0) === 1 ? "" : "s"}, then stops the run.</p>
      </div>`);
  }

  if (node.type === "agent") {
    parts.push(`
      <div class="ndv-section">
        <h3>Knowledge &amp; workspace memory</h3>
        <p class="hint">Attached bases are retrieved for every attempt. The agent can also call
          <span class="mono">knowledge_search</span> and <span class="mono">remember</span> as tools.</p>
        ${kbPicker(node)}
        <div class="ndv-row">
          ${field("Passages per attempt", `<input type="number" min="1" max="12" data-prop="kb_top_k" value="${Number(node.kb_top_k) || 5}" />`)}
          <label class="check-row top"><input type="checkbox" data-prop="use_memory" ${node.use_memory !== false ? "checked" : ""} /><span>Read &amp; write workspace memory</span></label>
        </div>
        <p class="hint">Memory records what every earlier node and earlier run did, so this step starts informed.</p>
        <button type="button" class="link-btn" data-goto="knowledge">Manage knowledge</button>
      </div>`);
  }
  return parts.join("");
}

function settingsHtml(node) {
  const parts = [];
  if (node.type !== "trigger") {
    parts.push(`
      <div class="ndv-row">
        ${field("Retries", `<input type="number" min="0" max="10" data-prop="max_retries" value="${Number(node.max_retries ?? 0)}" />`)}
        ${field("Timeout (ms)", `<input type="number" min="0" step="1000" data-prop="timeout_ms" value="${Number(node.timeout_ms ?? 60000)}" />`)}
      </div>`);
  }
  if (node.type === "agent") {
    parts.push(
      field(
        "Temperature",
        `<input type="number" min="0" max="2" step="0.1" data-prop="temperature" value="${Number(node.temperature ?? 0.4)}" />`,
      ),
    );
  }
  parts.push(`
    <div class="ndv-section">
      <h3>Node</h3>
      <p class="hint">ID</p>
      <div class="copy-row">
        <input readonly value="${esc(node.id)}" />
        <button class="btn sm" type="button" data-copy="${esc(node.id)}">Copy</button>
      </div>
      <p class="hint">On failure the run stops at this node. Resume restores every passed node and re-runs from here.</p>
    </div>`);
  return parts.join("");
}

function outputHtml(node) {
  const row = state.run?.nodes?.get(node.id);
  if (!row) {
    return `<div class="ndv-empty">No output yet. Run the workflow to see what this node receives and returns.</div>`;
  }
  const bits = [];
  const stats = [];
  if (row.attempts) stats.push(`${row.attempts} attempt${row.attempts > 1 ? "s" : ""}`);
  if (row.durationMs != null) stats.push(formatMs(row.durationMs));
  const tokens = formatTokens(row.tokensIn, row.tokensOut);
  if (tokens !== "—") stats.push(`${tokens} tokens`);
  bits.push(
    `<div class="detail-head"><strong>${esc(node.title)}</strong><span class="chip ${esc(row.status)}">${esc(row.status)}</span>${stats
      .map((entry) => `<span>${esc(entry)}</span>`)
      .join("")}</div>`,
  );

  if (row.error) bits.push(`<div class="detail-section"><h4>Error</h4><pre class="error">${esc(row.error)}</pre></div>`);
  bits.push(
    `<div class="detail-section"><h4>Output</h4><pre>${
      row.output == null ? "—" : esc(JSON.stringify(row.output, null, 2))
    }</pre></div>`,
  );
  if (row.logs?.length) {
    bits.push(
      `<div class="detail-section"><h4>Log</h4><ul class="detail-logs">${row.logs
        .map((line) => `<li>${esc(line)}</li>`)
        .join("")}</ul></div>`,
    );
  }
  return bits.join("");
}

function renderNdv() {
  const node = selectedNode();
  if (!node) {
    el.ndv.hidden = true;
    return;
  }
  const meta = NODE_META[node.type] ?? NODE_META.agent;
  el.ndv.hidden = false;
  el.ndv.style.setProperty("--node-color", meta.color);
  el.ndvIcon.innerHTML = ICONS[node.type] ?? ICONS.agent;
  if (document.activeElement !== el.ndvTitle) el.ndvTitle.value = node.title || meta.label;
  const kindLabel =
    node.type === "trigger"
      ? node.mode || "manual"
      : node.type === "http" || node.type === "fetch"
        ? String(node.method || "GET").toUpperCase()
        : node.type === "mcp"
          ? node.transport || "http"
          : node.type === "agent" || node.type === "check"
            ? "model call"
            : ["if", "switch", "filter", "merge", "set", "wait", "limit", "noop", "stop"].includes(node.type)
              ? "built-in"
              : "no model";
  el.ndvType.textContent = `${meta.label} · ${kindLabel}`;

  for (const tab of document.querySelectorAll(".ndv-tab")) {
    tab.classList.toggle("active", tab.dataset.tab === state.ndvTab);
  }

  if (state.ndvTab === "params") el.ndvBody.innerHTML = paramsHtml(node);
  else if (state.ndvTab === "settings") el.ndvBody.innerHTML = settingsHtml(node);
  else el.ndvBody.innerHTML = outputHtml(node);
}

document.querySelector(".ndv-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]");
  if (!tab) return;
  state.ndvTab = tab.dataset.tab;
  renderNdv();
});

el.ndvTitle.addEventListener("input", (event) => {
  const node = selectedNode();
  if (!node) return;
  node.title = event.target.value;
  updateCard(node);
  scheduleSave();
});

el.ndvBody.addEventListener("input", (event) => {
  const node = selectedNode();
  if (!node) return;
  const target = event.target;

  if (target.dataset.json) {
    const prop = target.dataset.json;
    const error = $(`[data-error="${prop}"]`);
    try {
      const parsed = JSON.parse(target.value || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("must be a JSON object");
      }
      node[prop] = prop === "headers" ? JSON.stringify(parsed, null, 2) : parsed;
      if (error) error.textContent = "";
      updateCard(node);
      scheduleSave();
    } catch (err) {
      if (error) error.textContent = `Invalid JSON: ${err.message}`;
    }
    return;
  }

  if (target.dataset.jsontext) {
    const prop = target.dataset.jsontext;
    const error = $(`[data-error="${prop}"]`);
    try {
      JSON.parse(target.value || "{}");
      node[prop] = target.value;
      if (error) error.textContent = "";
      scheduleSave();
    } catch (err) {
      if (error) error.textContent = err.message;
    }
    return;
  }

  if (target.dataset.cond) {
    const node = selectedNode();
    if (!node) return;
    const [index, key] = target.dataset.cond.split(":");
    const conditions = Array.isArray(node.conditions) ? [...node.conditions] : [];
    while (conditions.length <= Number(index)) conditions.push({ left: "", operator: "equals", right: "" });
    conditions[Number(index)] = { ...conditions[Number(index)], [key]: target.value };
    node.conditions = conditions;
    updateCard(node);
    scheduleSave();
    return;
  }

  if (target.dataset.rule) {
    const node = selectedNode();
    if (!node) return;
    const [index, key] = target.dataset.rule.split(":");
    const rules = Array.isArray(node.rules) ? [...node.rules] : [];
    while (rules.length <= Number(index)) rules.push({ left: "", operator: "equals", right: "" });
    rules[Number(index)] = { ...rules[Number(index)], [key]: target.value };
    node.rules = rules;
    updateCard(node);
    scheduleSave();
    return;
  }

  const prop = target.dataset.prop;
  if (!prop) return;
  let value;
  if (target.type === "checkbox") value = target.checked;
  else if (target.type === "number") value = Number(target.value) || 0;
  else value = target.value;
  node[prop] = value;
  updateCard(node);
  scheduleSave();
});

el.ndvBody.addEventListener("change", (event) => {
  const pick = event.target.closest("[data-kb]");
  if (pick) {
    const node = selectedNode();
    if (!node) return;
    const chosen = new Set(Array.isArray(node.kb_ids) ? node.kb_ids : []);
    if (pick.checked) chosen.add(pick.dataset.kb);
    else chosen.delete(pick.dataset.kb);
    node.kb_ids = [...chosen];
    updateCard(node);
    scheduleSave();
    return;
  }
  if (event.target.matches("[data-rerender]")) renderNdv();
});

el.ndvBody.addEventListener("click", async (event) => {
  const node = selectedNode();
  if (node && (event.target.closest("[data-cond-add]") || event.target.closest("[data-cond-remove]"))) {
    const conditions = Array.isArray(node.conditions) ? [...node.conditions] : [];
    const remove = event.target.closest("[data-cond-remove]");
    if (remove) conditions.splice(Number(remove.dataset.condRemove), 1);
    else conditions.push({ left: "", operator: "equals", right: "" });
    node.conditions = conditions;
    updateCard(node);
    renderNdv();
    renderCanvas();
    scheduleSave();
    return;
  }
  if (node && (event.target.closest("[data-rule-add]") || event.target.closest("[data-rule-remove]"))) {
    const rules = Array.isArray(node.rules) ? [...node.rules] : [];
    const remove = event.target.closest("[data-rule-remove]");
    if (remove) rules.splice(Number(remove.dataset.ruleRemove), 1);
    else rules.push({ left: "", operator: "equals", right: "" });
    node.rules = rules;
    updateCard(node);
    renderNdv();
    renderCanvas();
    scheduleSave();
    return;
  }
  const goto = event.target.closest("[data-goto]");
  if (goto) {
    switchView(goto.dataset.goto);
    return;
  }
  const copy = event.target.closest("[data-copy]");
  if (copy) {
    copyText(copy.dataset.copy);
    return;
  }
  if (event.target.closest("#copy-hook")) {
    copyText(webhookUrl());
    return;
  }
  if (event.target.closest("[data-rotate-hook]")) {
    if (!confirm("Rotate this webhook token? Existing URLs stop working.")) return;
    try {
      const result = await api(`/api/workflows/${state.workflow.id}/hook-token`, { method: "POST" });
      state.workflow.hookToken = result.hookToken;
      renderNdv();
      toast("Webhook token rotated. The old URL no longer runs this workflow.");
    } catch (err) {
      toast(err.message, "error");
    }
  }
});

$("#ndv-close").addEventListener("click", () => selectNode(null));
$("#ndv-delete").addEventListener("click", deleteSelectedNode);

function deleteSelectedNode() {
  const node = selectedNode();
  if (!node || !state.workflow) return;
  const graph = state.workflow.graph;
  graph.nodes = graph.nodes.filter((entry) => entry.id !== node.id);
  graph.edges = graph.edges.filter((edge) => edge.from !== node.id && edge.to !== node.id);
  state.selected = null;
  el.ndv.hidden = true;
  renderCanvas();
  scheduleSave();
}

$("#workflow-name").addEventListener("input", (event) => {
  if (!state.workflow) return;
  state.workflow.name = event.target.value;
  scheduleSave();
});

// ---------------------------------------------------------------------------
// saving
// ---------------------------------------------------------------------------

async function saveNow() {
  if (!state.workflow) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  try {
    const { workflow } = await api(`/api/workflows/${state.workflow.id}`, {
      method: "PUT",
      body: JSON.stringify({
        name: state.workflow.name,
        description: state.workflow.description,
        graph: state.workflow.graph,
      }),
    });
    state.workflow.updatedAt = workflow.updatedAt;
    state.workflows = state.workflows.map((entry) =>
      entry.id === workflow.id ? { ...entry, name: workflow.name, updatedAt: workflow.updatedAt } : entry,
    );
    el.saveState.textContent = "Saved";
    setTimeout(() => {
      if (el.saveState.textContent === "Saved") el.saveState.textContent = "";
    }, 1800);
    renderFlyout();
  } catch (err) {
    el.saveState.textContent = "Save failed";
    toast(err.message, "error");
  }
}

function scheduleSave() {
  el.saveState.textContent = "Saving…";
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, 600);
}

$("#save-btn").addEventListener("click", () => saveNow().then(() => toast("Workflow saved.")));

// ---------------------------------------------------------------------------
// workflow loading
// ---------------------------------------------------------------------------

async function refreshWorkflows() {
  const { workflows } = await api("/api/workflows");
  state.workflows = workflows;
  renderFlyout();
}

async function selectWorkflow(id, { route = true } = {}) {
  closeStream();
  const { workflow } = await api(`/api/workflows/${id}`);
  state.workflow = workflow;
  state.selected = null;
  state.selectedEdge = null;
  state.run = null;
  state.dockNode = null;
  setDock(false);
  el.ndv.hidden = true;
  el.name.value = workflow.name;

  // Workflows seeded by the first build were stacked vertically; lay them out
  // left-to-right once so the connections read the n8n way.
  if (looksVertical(workflow.graph)) {
    tidyLayout(workflow.graph);
    saveNow();
  }

  renderTopbar();
  renderCanvas();
  fitView();
  renderFlyout();
  if (route) pushRoute(`/workflow/${workflow.id}`);
}

function renderTopbar() {
  const workflow = state.workflow;
  if (!workflow) return;
  el.name.value = workflow.name;
  const active = Boolean(workflow.active);
  el.activeToggle.checked = active;
  el.activeLabel.textContent = active ? "Active" : "Inactive";
  const trigger = triggerNode();
  const supportsActive = trigger && (trigger.mode === "schedule" || trigger.mode === "webhook");
  $("#active-wrap").title = supportsActive
    ? "Run this workflow automatically while Active"
    : "Set the trigger to Schedule or Webhook to activate this workflow";
  $("#active-wrap").style.opacity = supportsActive ? "1" : "0.6";

  if (workflow.active) {
    el.activeToggle.checked = true;
    el.activeLabel.textContent = "Active";
  }
}

el.activeToggle.addEventListener("change", async (event) => {
  if (!state.workflow) return;
  const active = event.target.checked;
  const trigger = triggerNode();
  if (active && (!trigger || (trigger.mode !== "schedule" && trigger.mode !== "webhook"))) {
    event.target.checked = false;
    toast("Pick a Schedule or Webhook trigger before activating.", "error");
    return;
  }
  try {
    const { workflow } = await api(`/api/workflows/${state.workflow.id}`, {
      method: "PUT",
      body: JSON.stringify({ active }),
    });
    state.workflow.active = workflow.active;
    state.workflows = state.workflows.map((entry) =>
      entry.id === workflow.id ? { ...entry, active: workflow.active } : entry,
    );
    renderTopbar();
    renderFlyout();
    toast(active ? "Workflow active. The server will fire it." : "Workflow set inactive.");
  } catch (err) {
    event.target.checked = !active;
    toast(err.message, "error");
  }
});

async function createWorkflow({ route = true } = {}) {
  const { workflow } = await api("/api/workflows", {
    method: "POST",
    body: JSON.stringify({ name: "Untitled workflow" }),
  });
  await refreshWorkflows();
  await selectWorkflow(workflow.id, { route });
  switchView("editor", { route });
  addNode("trigger", { x: 120, y: 160 });
}

async function deleteWorkflow(id) {
  const workflow = state.workflows.find((entry) => entry.id === id);
  if (!workflow) return;
  if (!confirm(`Delete "${workflow.name}"? Its executions are removed too.`)) return;
  await api(`/api/workflows/${id}`, { method: "DELETE" });
  await refreshWorkflows();
  if (state.workflow?.id === id) {
    if (state.workflows.length) await selectWorkflow(state.workflows[0].id);
    else await createWorkflow();
  }
}

async function useTemplate(key) {
  const { workflow } = await api(`/api/templates/${key}`, { method: "POST" });
  await refreshWorkflows();
  await selectWorkflow(workflow.id);
  switchView("editor");
  closeFlyout();
  toast(`"${workflow.name}" added. Double-click a node to edit it.`);
}

// ---------------------------------------------------------------------------
// flyout
// ---------------------------------------------------------------------------

function openFlyout(kind) {
  state.flyout = kind;
  el.flyout.hidden = false;
  el.flyoutTitle.textContent = kind === "templates" ? "Templates" : "Workflows";
  for (const button of document.querySelectorAll(".rail-btn[data-panel]")) {
    button.classList.toggle("active", button.dataset.panel === kind && kind !== "executions" && kind !== "credentials");
  }
  renderFlyout();
}

function closeFlyout() {
  state.flyout = null;
  el.flyout.hidden = true;
  syncRail();
}

function renderFlyout() {
  if (el.flyout.hidden) return;
  if (state.flyout === "templates") {
    el.flyoutBody.innerHTML = `<div class="side-group-title">Start from</div>${state.templates
      .map(
        (template) => `
        <button class="tpl-card" data-template="${esc(template.key)}">
          <strong>${esc(template.name)}</strong>
          <span>${esc(template.description)}</span>
          <em class="tpl-tag ${template.needsModel ? "" : "offline"}">${template.needsModel ? "needs a model" : "runs without a model"}</em>
        </button>`,
      )
      .join("")}`;
    return;
  }

  el.flyoutBody.innerHTML = `
    <button class="btn wide" id="new-workflow">+ New workflow</button>
    <div class="side-group-title">Your workflows</div>
    ${state.workflows
      .map(
        (workflow) => `
      <div class="wf-row ${state.workflow?.id === workflow.id ? "active" : ""}" data-workflow="${esc(workflow.id)}">
        <span class="wf-dot ${workflow.active ? "active" : ""}"></span>
        <span class="wf-name">${esc(workflow.name)}</span>
        <button class="wf-del" data-delete="${esc(workflow.id)}" title="Delete workflow">✕</button>
      </div>`,
      )
      .join("")}`;
}

el.flyoutBody.addEventListener("click", async (event) => {
  const template = event.target.closest("[data-template]");
  if (template) return useTemplate(template.dataset.template).catch((err) => toast(err.message, "error"));

  const remove = event.target.closest("[data-delete]");
  if (remove) {
    event.stopPropagation();
    await deleteWorkflow(remove.dataset.delete).catch((err) => toast(err.message, "error"));
    return;
  }

  const workflow = event.target.closest("[data-workflow]");
  if (workflow) {
    await selectWorkflow(workflow.dataset.workflow);
    switchView("editor");
    return;
  }

  if (event.target.closest("#new-workflow")) {
    createWorkflow().catch((err) => toast(err.message, "error"));
  }
});

$("#flyout-close").addEventListener("click", closeFlyout);

document.querySelectorAll(".rail-btn[data-panel]").forEach((button) => {
  button.addEventListener("click", () => {
    const panel = button.dataset.panel;
    if (panel === "executions" || panel === "credentials" || panel === "knowledge" || panel === "agents") {
      closeFlyout();
      switchView(panel);
      return;
    }
    if (state.flyout === panel && !el.flyout.hidden) closeFlyout();
    else openFlyout(panel);
  });
});

function syncRail() {
  const view = document.querySelector(".view.active")?.id.replace("-view", "") ?? "editor";
  for (const button of document.querySelectorAll(".rail-btn")) {
    const panel = button.dataset.panel;
    if (!panel) continue;
    button.classList.toggle("active", panel === view);
  }
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

function switchView(name, { route = true, replace = false } = {}) {
  for (const tab of document.querySelectorAll(".tb-tab")) {
    tab.classList.toggle("active", tab.dataset.view === name);
  }
  for (const view of document.querySelectorAll(".view")) {
    view.classList.toggle("active", view.id === `${name}-view`);
  }
  if (name !== "editor") el.ndv.hidden = true;
  else if (selectedNode()) el.ndv.hidden = false;
  syncRail();
  if (name === "executions") loadExecutions().catch((err) => toast(err.message, "error"));
  if (name === "credentials") renderCredentials();
  if (name === "knowledge") refreshKnowledge().catch((err) => toast(err.message, "error"));
  if (name === "agents") refreshAgents().catch((err) => toast(err.message, "error"));
  if (route) pushRoute(routePath(name, state.workflow?.id), replace);
}

document.querySelector(".tb-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-view]");
  if (tab) switchView(tab.dataset.view);
});

// ---------------------------------------------------------------------------
// routes: /workflow/:id, /workflow/:id/executions/:runId, /executions …
// ---------------------------------------------------------------------------

function currentRoute() {
  const parts = location.pathname.split("/").filter(Boolean);
  if (parts[0] === "workflow") {
    return {
      view: "editor",
      workflowId: parts[1] || null,
      runId: parts[2] === "executions" ? parts[3] || null : null,
    };
  }
  if (["executions", "credentials", "knowledge", "agents"].includes(parts[0])) {
    return { view: parts[0], workflowId: null, runId: null };
  }
  return { view: "editor", workflowId: null, runId: null };
}

function routePath(view, workflowId) {
  if (view !== "editor") return `/${view}`;
  return workflowId ? `/workflow/${workflowId}` : "/";
}

function pushRoute(path, replace = false) {
  if (location.pathname === path) return;
  if (replace) history.replaceState({}, "", path);
  else history.pushState({}, "", path);
}

// A refresh (or a closed tab) re-attaches to the execution that is still
// running, using the same server-side snapshot the SSE stream starts with.
async function restoreRunningExecution(workflowId) {
  const { runs } = await api(`/api/runs?workflowId=${encodeURIComponent(workflowId)}&limit=5`);
  const running = runs.find((run) => run.status === "running");
  if (!running) return;
  const payload = await api(`/api/runs/${running.id}`);
  openRun(payload, { route: false });
  pushRoute(`/workflow/${workflowId}/executions/${running.id}`, true);
  toast("Reattached to the execution that is still running.");
}

async function applyRoute() {
  const route = currentRoute();
  if (route.workflowId === "new") {
    await createWorkflow({ route: false });
    pushRoute(`/workflow/${state.workflow.id}`, true);
    return;
  }
  if (route.workflowId && route.workflowId !== state.workflow?.id) {
    try {
      await selectWorkflow(route.workflowId, { route: false });
    } catch {
      if (state.workflows.length) await selectWorkflow(state.workflows[0].id, { route: false });
      else await createWorkflow();
      toast("That workflow link no longer exists.", "error");
    }
  } else if (!state.workflow) {
    if (state.workflows.length) await selectWorkflow(state.workflows[0].id, { route: false });
    else await createWorkflow();
  }

  if (route.view !== "editor") {
    switchView(route.view, { route: false });
    pushRoute(routePath(route.view), true);
    return;
  }

  switchView("editor", { route: false });
  if (route.runId) {
    const payload = await api(`/api/runs/${route.runId}`);
    if (payload.run.workflowId !== state.workflow?.id) {
      await selectWorkflow(payload.run.workflowId, { route: false });
    }
    openRun(payload, { route: false });
    pushRoute(`/workflow/${payload.run.workflowId}/executions/${payload.run.id}`, true);
    return;
  }
  if (state.workflow) {
    pushRoute(`/workflow/${state.workflow.id}`, true);
    await restoreRunningExecution(state.workflow.id);
  }
}

window.addEventListener("popstate", () => {
  applyRoute().catch((err) => toast(err.message, "error"));
});

// ---------------------------------------------------------------------------
// run + dock
// ---------------------------------------------------------------------------

function closeStream() {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
}

// Opening the log dock shrinks the canvas; shift the view by half the dock so
// nodes stay centred instead of sliding under the zoom controls.
function setDock(visible) {
  if (el.dock.hidden === !visible) return;
  el.dock.hidden = !visible;
  const height = visible ? el.dock.offsetHeight || 292 : 292;
  state.view.y += visible ? -height / 2 : height / 2;
  applyView();
}

function openRun(payload, { route = true } = {}) {
  state.run = {
    run: payload.run,
    nodes: new Map((payload.nodes ?? []).map((row) => [row.nodeId, row])),
  };
  const graphNodes = payload.run.graph?.nodes ?? [];
  state.dockNode =
    (state.dockNode && graphNodes.some((node) => node.id === state.dockNode) && state.dockNode) ||
    graphNodes[0]?.id ||
    null;
  setDock(true);
  renderDock();
  applyBadges();
  if (payload.run.status === "running") subscribeRun(payload.run.id);
  else closeStream();
  if (route && payload.run?.workflowId) {
    pushRoute(`/workflow/${payload.run.workflowId}/executions/${payload.run.id}`);
  }
  if (payload.error) toast(payload.error, "error");
}

function subscribeRun(runId) {
  closeStream();
  const stream = new EventSource(`/api/runs/${runId}/events`);
  state.stream = stream;

  stream.onmessage = (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    if (!state.run) return;
    if (event.type === "snapshot") {
      state.run = {
        run: event.run,
        nodes: new Map((event.nodes ?? []).map((row) => [row.nodeId, row])),
      };
    } else if (event.type === "node") {
      const previous = state.run.nodes.get(event.node.nodeId) ?? {};
      state.run.nodes.set(event.node.nodeId, { ...previous, ...event.node });
    } else if (event.type === "run") {
      state.run.run = { ...state.run.run, ...event.run };
    }
    renderDock();
    applyBadges();
    if (state.ndvTab === "output" && selectedNode()) renderNdv();
    if (["completed", "failed", "cancelled"].includes(state.run.run.status)) closeStream();
  };
}

function renderDock() {
  if (!state.run) return;
  const { run, nodes } = state.run;
  el.dockDot.className = `status-dot ${run.status}`;
  el.dockTitle.textContent = `Execution ${run.id.slice(0, 8)}`;
  const totalTokens = formatTokens(run.tokensIn, run.tokensOut);
  el.dockMeta.textContent = [
    run.status,
    run.trigger,
    formatMs(run.durationMs),
    totalTokens !== "—" ? `${totalTokens} tokens` : "",
    run.resumeOf ? `resumed from ${run.resumeOf.slice(0, 8)}` : "",
  ]
    .filter(Boolean)
    .join(" · ") + money(run.cost);
  el.dockMeta.title = run.error ?? "";
  $("#dock-resume").hidden = run.status !== "failed";
  $("#dock-cancel").hidden = run.status !== "running";
  renderDockRows();
  renderDockDetail();
}

function renderDockRows() {
  if (!state.run) return;
  const { run, nodes } = state.run;
  el.dockRows.innerHTML = (run.graph?.nodes ?? [])
    .map((node) => {
      const row = nodes.get(node.id);
      const meta = NODE_META[node.type] ?? NODE_META.agent;
      return `
        <button class="log-row ${state.dockNode === node.id ? "selected" : ""}" data-node-id="${esc(node.id)}" data-status="${esc(row?.status ?? "idle")}">
          <span class="log-icon" style="--node-color:${meta.color}">${ICONS[node.type] ?? ICONS.agent}</span>
          <span class="log-name">${esc(node.title || meta.label)}</span>
          <span class="log-status">${esc(row?.status ?? "waiting")}</span>
          <span class="log-time">${formatMs(row?.durationMs)}</span>
          <span class="log-tokens">${formatTokens(row?.tokensIn, row?.tokensOut)}</span>
        </button>`;
    })
    .join("");
}

function renderDockDetail() {
  if (!state.run) return;
  const row = state.run.nodes.get(state.dockNode);
  const node = (state.run.run.graph?.nodes ?? []).find((entry) => entry.id === state.dockNode);
  if (!node) {
    el.dockDetail.innerHTML = `<div class="dock-empty">Select a node to inspect its output.</div>`;
    return;
  }
  if (!row) {
    el.dockDetail.innerHTML = `<div class="dock-empty">"${esc(node.title)}" has not run yet.</div>`;
    return;
  }
  const stats = [];
  if (row.attempts) stats.push(`${row.attempts} attempt${row.attempts > 1 ? "s" : ""}`);
  if (row.durationMs != null) stats.push(formatMs(row.durationMs));
  const tokens = formatTokens(row.tokensIn, row.tokensOut);
  if (tokens !== "—") stats.push(`${tokens} tokens`);
  const parts = [
    `<div class="detail-head"><strong>${esc(node.title)}</strong><span class="chip ${esc(row.status)}">${esc(row.status)}</span>
      ${stats.map((entry) => `<span>${esc(entry)}</span>`).join("")}</div>`,
  ];
  if (row.logs?.length) {
    parts.push(
      `<div class="detail-section"><h4>Log</h4><ul class="detail-logs">${row.logs
        .map((line) => `<li>${esc(line)}</li>`)
        .join("")}</ul></div>`,
    );
  }
  if (row.error) {
    parts.push(`<div class="detail-section"><h4>Error</h4><pre class="error">${esc(row.error)}</pre></div>`);
  }
  const output = row.output ?? row.rawOutput;
  if (output != null) {
    parts.push(
      `<div class="detail-section"><h4>${row.output ? "Output" : "Rejected output"}</h4><pre>${esc(
        JSON.stringify(output, null, 2),
      )}</pre></div>`,
    );
  }
  if (state.run.run.error && state.run.run.status === "failed") {
    parts.push(
      `<div class="detail-section"><h4>Run stopped</h4><pre class="error">${esc(state.run.run.error)}</pre></div>`,
    );
  }
  el.dockDetail.innerHTML = parts.join("");
}

el.dockRows.addEventListener("click", (event) => {
  const row = event.target.closest("[data-node-id]");
  if (!row) return;
  state.dockNode = row.dataset.nodeId;
  state.selected = row.dataset.nodeId;
  for (const card of el.nodes.querySelectorAll(".node")) {
    card.classList.toggle("selected", card.dataset.id === state.selected);
  }
  renderDockRows();
  renderDockDetail();
});

async function runWorkflow() {
  if (!state.workflow) return;
  const button = $("#run-btn");
  button.disabled = true;
  try {
    await saveNow();
    const trigger = triggerNode();
    let input = {};
    if (trigger?.sample_input?.trim()) {
      try {
        input = JSON.parse(trigger.sample_input);
      } catch (err) {
        toast(`The trigger payload is not valid JSON: ${err.message}`, "error");
        return;
      }
    }
    const payload = await api(`/api/workflows/${state.workflow.id}/run`, {
      method: "POST",
      body: JSON.stringify({ input }),
    });
    if (state.run?.run?.status === "running") closeStream();
    openRun(payload);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function resumeRun() {
  const runId = state.run?.run?.id;
  if (!runId) return;
  try {
    const payload = await api(`/api/runs/${runId}/resume`, { method: "POST" });
    openRun(payload);
    toast("Resumed: passed nodes were restored, not re-run.");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function cancelRun() {
  const runId = state.run?.run?.id;
  if (!runId) return;
  try {
    const payload = await api(`/api/runs/${runId}/cancel`, { method: "POST" });
    if (state.run) state.run.run = { ...state.run.run, ...payload.run };
    renderDock();
  } catch (err) {
    toast(err.message, "error");
  }
}

$("#run-btn").addEventListener("click", runWorkflow);
$("#dock-resume").addEventListener("click", resumeRun);
$("#dock-cancel").addEventListener("click", cancelRun);
$("#dock-close").addEventListener("click", () => setDock(false));

// ---------------------------------------------------------------------------
// executions view
// ---------------------------------------------------------------------------

async function loadExecutions() {
  if (!state.workflow) return;
  const { runs } = await api(`/api/runs?workflowId=${encodeURIComponent(state.workflow.id)}&limit=80`);
  $("#exec-sub").textContent = `${state.workflow.name} · ${runs.length} recent execution${runs.length === 1 ? "" : "s"}`;
  if (!runs.length) {
    el.execTable.innerHTML = `<div class="empty-state">No executions yet. Run the workflow from the editor.</div>`;
    return;
  }
  el.execTable.innerHTML = `
    <table class="exec-table">
      <thead><tr><th>Status</th><th>Execution</th><th>Started</th><th>Duration</th><th>Trigger</th><th>Tokens</th><th>Cost</th></tr></thead>
      <tbody>
        ${runs
          .map(
            (run) => `
          <tr data-run="${esc(run.id)}">
            <td><span class="chip ${esc(run.status)}">${esc(run.status)}</span></td>
            <td class="exec-id">${esc(run.id.slice(0, 8))}</td>
            <td>${esc(new Date(run.startedAt).toLocaleString())}</td>
            <td>${formatMs(run.durationMs)}</td>
            <td>${esc(run.trigger)}</td>
            <td>${formatTokens(run.tokensIn, run.tokensOut)}</td>
            <td>${run.cost ? `$${run.cost.toFixed(4)}` : "—"}</td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

el.execTable.addEventListener("click", async (event) => {
  const row = event.target.closest("[data-run]");
  if (!row) return;
  try {
    const payload = await api(`/api/runs/${row.dataset.run}`);
    if (payload.run.workflowId !== state.workflow?.id) {
      await selectWorkflow(payload.run.workflowId, { route: false });
    }
    switchView("editor", { route: false });
    openRun(payload);
  } catch (err) {
    toast(err.message, "error");
  }
});

$("#refresh-exec").addEventListener("click", () => loadExecutions().catch((err) => toast(err.message, "error")));

// ---------------------------------------------------------------------------
// credentials view
// ---------------------------------------------------------------------------

function renderCredentialForm() {
  const select = $("#cred-provider");
  const applyProvider = () => {
    const provider = state.providers.find((entry) => entry.id === select.value);
    $("#cred-base").value = provider?.baseUrl ?? "";
    $("#cred-model").value = provider?.model ?? "";
    $("#cred-note").textContent = provider?.keyless
      ? "No key needed for a local Ollama server. Start it with `ollama serve`."
      : provider?.keysUrl
        ? `Create a key at ${provider.keysUrl}`
        : "Any OpenAI-compatible endpoint works.";
    $("#cred-note").className = "form-note";
  };

  if (!select.dataset.ready) {
    select.innerHTML = state.providers
      .map((provider) => `<option value="${esc(provider.id)}">${esc(provider.label)}</option>`)
      .join("");
    select.addEventListener("change", applyProvider);
    select.dataset.ready = "1";
  }
  if (!select.value) select.value = "openai";
  if (!$("#cred-base").value) applyProvider();
}

function renderCredentials() {
  renderCredentialForm();
  const rows = state.credentials
    .map(
      (credential) => `
      <div class="cred-card" data-credential="${esc(credential.id)}">
        <span class="cred-avatar">${esc(credential.provider.slice(0, 2))}</span>
        <div class="cred-main">
          <div class="cred-name">${esc(credential.name)} <span class="mono">${esc(credential.hint)}</span></div>
          <div class="cred-sub">${esc(credential.baseUrl)}${credential.model ? ` · ${esc(credential.model)}` : ""}</div>
        </div>
        <div class="cred-actions">
          <button class="btn sm" data-test="${esc(credential.id)}">Test</button>
          <button class="btn sm ghost" data-remove="${esc(credential.id)}">Delete</button>
        </div>
      </div>`,
    )
    .join("");

  const envCard = state.env?.configured
    ? `<div class="cred-card">
        <span class="cred-avatar">ENV</span>
        <div class="cred-main">
          <div class="cred-name">Environment key</div>
          <div class="cred-sub">${esc(state.env.base)} · ${esc(state.env.model)} · from SEQUOR_API_KEY</div>
        </div>
        <div class="cred-actions"><span class="chip completed">connected</span></div>
      </div>`
    : "";

  el.credList.innerHTML =
    (envCard + rows) ||
    `<div class="empty-state">No credentials yet. Add a provider on the right, then pick it on an agent node.</div>`;
}

el.credList.addEventListener("click", async (event) => {
  const test = event.target.closest("[data-test]");
  if (test) {
    test.disabled = true;
    test.textContent = "Testing…";
    try {
      const result = await api(`/api/credentials/${test.dataset.test}/test`, { method: "POST" });
      toast(result.message, result.ok ? "" : "error");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      test.disabled = false;
      test.textContent = "Test";
    }
    return;
  }
  const remove = event.target.closest("[data-remove]");
  if (remove) {
    if (!confirm("Delete this credential? Nodes using it will need a new one.")) return;
    await api(`/api/credentials/${remove.dataset.remove}`, { method: "DELETE" }).catch((err) =>
      toast(err.message, "error"),
    );
    const { credentials } = await api("/api/credentials");
    state.credentials = credentials;
    renderCredentials();
    renderTopbar();
    toast("Credential deleted.");
  }
});

el.credForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const note = el.credNote;
  const payload = {
    provider: $("#cred-provider").value,
    name: $("#cred-name").value,
    apiKey: $("#cred-key").value,
    baseUrl: $("#cred-base").value,
    model: $("#cred-model").value,
  };
  try {
    await api("/api/credentials", { method: "POST", body: JSON.stringify(payload) });
    $("#cred-key").value = "";
    $("#cred-name").value = "";
    const { credentials } = await api("/api/credentials");
    state.credentials = credentials;
    renderCredentials();
    renderModelStatus();
    toast("Credential saved. Pick it on an agent node.");
  } catch (err) {
    note.textContent = err.message;
    note.className = "form-note error";
  }
});

function renderModelStatus() {
  const live = state.credentials.length > 0 || state.env?.configured;
  const chip = $("#rail-model");
  chip.classList.toggle("live", live);
  chip.title = live
    ? `${state.credentials.length} stored credential${state.credentials.length === 1 ? "" : "s"}${state.env?.configured ? " + environment key" : ""}`
    : "No model connected — open Credentials";
}

// ---------------------------------------------------------------------------
// keyboard
// ---------------------------------------------------------------------------

window.addEventListener("keydown", (event) => {
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  if (event.key === "Escape") {
    if (!el.popover.hidden) closePopover();
    else if (!el.flyout.hidden) closeFlyout();
    else if (!el.ndv.hidden) selectNode(null);
    else selectNode(null);
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    runWorkflow();
    return;
  }
  if (typing) return;
  if ((event.key === "Delete" || event.key === "Backspace") && state.workflow) {
    if (state.selectedEdge) {
      const [from, to] = state.selectedEdge.split("|");
      state.workflow.graph.edges = state.workflow.graph.edges.filter(
        (edge) => !(edge.from === from && edge.to === to),
      );
      state.selectedEdge = null;
      drawEdges();
      scheduleSave();
      return;
    }
    if (state.selected) deleteSelectedNode();
  }
});

// ---------------------------------------------------------------------------
// layout: drag the sidebar, node panel, dock and dock columns to resize them
// ---------------------------------------------------------------------------

const LAYOUT_KEY = "sequor.layout";
const LAYOUT_DEFAULTS = { flyout: 296, ndv: 468, dock: 292, split: 55 };
const LAYOUT_RANGES = {
  flyout: [200, 640],
  ndv: [320, 900],
  dock: [120, 720],
  split: [22, 78],
};

const layout = (() => {
  const values = { ...LAYOUT_DEFAULTS };
  try {
    const stored = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
    for (const key of Object.keys(values)) {
      if (Number.isFinite(stored[key])) values[key] = stored[key];
    }
  } catch {
    // an unreadable layout just means default sizes
  }
  return values;
})();

function applyLayout() {
  const [flyoutMin, flyoutMax] = LAYOUT_RANGES.flyout;
  const [ndvMin, ndvMax] = LAYOUT_RANGES.ndv;
  const [dockMin, dockMax] = LAYOUT_RANGES.dock;
  const room = Math.max(0, window.innerWidth - 300);
  const heightRoom = Math.max(0, window.innerHeight - 180);
  const style = document.documentElement.style;
  style.setProperty("--flyout-w", `${Math.round(clamp(layout.flyout, flyoutMin, Math.max(flyoutMin, Math.min(flyoutMax, room))))}px`);
  style.setProperty("--ndv-w", `${Math.round(clamp(layout.ndv, ndvMin, Math.max(ndvMin, Math.min(ndvMax, room))))}px`);
  style.setProperty("--dock-h", `${Math.round(clamp(layout.dock, dockMin, Math.max(dockMin, Math.min(dockMax, heightRoom))))}px`);
  style.setProperty("--dock-split", `${layout.split.toFixed(2)}%`);
}

function saveLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // the sizes still apply for this page view
  }
}

function setupResizer(selector, options) {
  const { key, axis, invert = false, step = 16, scale = (delta) => delta } = options;
  const handle = $(selector);
  if (!handle) return;
  const [min, max] = LAYOUT_RANGES[key];
  const write = (value) => {
    layout[key] = clamp(value, min, max);
    applyLayout();
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // capture is unavailable for some synthetic or interrupted pointers
    }
    handle.classList.add("dragging");
    const bodyClass = axis === "x" ? "resizing-x" : "resizing-y";
    document.body.classList.add(bodyClass);
    const start = axis === "x" ? event.clientX : event.clientY;
    const base = layout[key];

    const move = (moveEvent) => {
      const current = axis === "x" ? moveEvent.clientX : moveEvent.clientY;
      write(base + scale(current - start) * (invert ? -1 : 1));
    };
    const finish = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      handle.classList.remove("dragging");
      document.body.classList.remove(bodyClass);
      saveLayout();
    };

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  });

  handle.addEventListener("dblclick", () => {
    write(LAYOUT_DEFAULTS[key]);
    saveLayout();
  });

  handle.addEventListener("keydown", (event) => {
    const negative = axis === "x" ? "ArrowLeft" : "ArrowUp";
    const positive = axis === "x" ? "ArrowRight" : "ArrowDown";
    if (event.key !== negative && event.key !== positive) return;
    event.preventDefault();
    const direction = event.key === positive ? 1 : -1;
    write(layout[key] + direction * step * (invert ? -1 : 1));
    saveLayout();
  });
}

setupResizer("#flyout-resizer", { key: "flyout", axis: "x" });
setupResizer("#ndv-resizer", { key: "ndv", axis: "x", invert: true });
setupResizer("#dock-resizer", { key: "dock", axis: "y", invert: true });
setupResizer("#dock-split-resizer", {
  key: "split",
  axis: "x",
  step: 1,
  scale: (delta) => {
    const width = $(".dock-body")?.getBoundingClientRect().width || 0;
    return width ? (delta / width) * 100 : 0;
  },
});

applyLayout();

window.addEventListener("resize", () => {
  applyLayout();
  if (state.workflow) applyView();
});

// ---------------------------------------------------------------------------
// agents view
// ---------------------------------------------------------------------------

async function refreshAgents() {
  const [{ agents }, { credentials }] = await Promise.all([api("/api/agents"), api("/api/credentials")]);
  state.agents = agents;
  state.credentials = credentials;
  if (!state.agents.some((entry) => entry.id === state.agentSelected)) {
    state.agentSelected = state.agents[0]?.id ?? null;
  }
  if (state.agentSelected && state.agentDraft?.id !== state.agentSelected) {
    const { agent } = await api(`/api/agents/${state.agentSelected}`);
    state.agentDraft = structuredClone(agent);
  }
  if (!state.agentSelected) state.agentDraft = null;
  renderAgentList();
  renderAgentMain();
}

function renderAgentList() {
  const list = $("#agent-list");
  if (!list) return;
  list.innerHTML = state.agents.length
    ? state.agents
        .map(
          (agent) => `
      <div class="agent-row ${state.agentSelected === agent.id ? "active" : ""}" data-agent-id="${esc(agent.id)}" role="button" tabindex="0">
        <span class="agent-row-name">${esc(agent.name)}</span>
        <span class="agent-row-meta">${esc(agent.model || "no model")} · ${enabledToolCount(agent.tools)} tools · ${agent.skills.length} skills${
          agent.source === "opencode.json" ? " · imported" : ""
        }</span>
        <button class="agent-row-del" data-del-agent="${esc(agent.id)}" title="Delete agent">✕</button>
      </div>`,
        )
        .join("")
    : `<p class="empty-state small">No agents yet. Import an opencode.json or start blank.</p>`;
}

function renderAgentMain() {
  const main = $("#agent-main");
  const draft = state.agentDraft;
  if (!main) return;
  if (!draft) {
    main.innerHTML = `<section class="agent-panel"><h2>Agent</h2><p class="hint">An agent bundles a model, a credential, a system prompt, skills, MCP servers and the built-in tools it may use. Import an opencode.json to fill all of it at once, then pick the agent on any Agent node instead of a bare credential.</p></section>`;
    return;
  }

  const credentialOptions = [`<option value="">No credential · environment key</option>`]
    .concat(
      state.credentials.map(
        (credential) =>
          `<option value="${esc(credential.id)}" ${credential.id === draft.credentialId ? "selected" : ""}>${esc(credential.name)} · ${esc(credential.hint)}</option>`,
      ),
    )
    .join("");

  const tools = state.builtinTools.length
    ? state.builtinTools
    : [
        { key: "file_search", label: "File search", hint: "List and read files" },
        { key: "file_write", label: "File write", hint: "Create and overwrite files" },
        { key: "bash", label: "Run commands", hint: "Shell access" },
        { key: "web", label: "Web fetch", hint: "GET URLs" },
        { key: "knowledge", label: "Knowledge search", hint: "Retrieval" },
        { key: "memory", label: "Workspace memory", hint: "Remember and recall" },
      ];

  const skillRows = draft.skills.length
    ? draft.skills
        .map(
          (skill, index) => `
      <div class="agent-item">
        <div class="agent-item-head">
          <input data-skill-index="${index}" data-skill-field="name" value="${esc(skill.name)}" placeholder="Skill name" />
          <button type="button" data-del-skill="${index}" title="Remove skill">✕</button>
        </div>
        <input data-skill-index="${index}" data-skill-field="description" value="${esc(skill.description)}" placeholder="When to use it" />
        <textarea rows="4" data-skill-index="${index}" data-skill-field="instructions" placeholder="Instructions given to the model">${esc(skill.instructions)}</textarea>
      </div>`,
        )
        .join("")
    : `<p class="empty-state small">No skills yet.</p>`;

  const mcpRows = draft.mcpServers.length
    ? draft.mcpServers
        .map(
          (server, index) => `
      <div class="agent-item">
        <div class="agent-item-head">
          <input data-mcp-index="${index}" data-mcp-field="name" value="${esc(server.name)}" placeholder="Server name" />
          <label class="check-row inline"><input type="checkbox" data-mcp-index="${index}" data-mcp-field="enabled" ${server.enabled ? "checked" : ""} /><span>enabled</span></label>
          <button type="button" data-del-mcp="${index}" title="Remove server">✕</button>
        </div>
        <div class="agent-grid">
          <label class="field"><span>Transport</span>
            <select data-mcp-index="${index}" data-mcp-field="transport">
              <option value="http" ${server.transport !== "stdio" ? "selected" : ""}>Streamable HTTP</option>
              <option value="stdio" ${server.transport === "stdio" ? "selected" : ""}>stdio command</option>
            </select>
          </label>
          <label class="field"><span>${server.transport === "stdio" ? "Command" : "Server URL"}</span>
            <input data-mcp-index="${index}" data-mcp-field="${server.transport === "stdio" ? "command" : "url"}" value="${esc(
              server.transport === "stdio" ? server.command : server.url,
            )}" placeholder="${server.transport === "stdio" ? "npx -y some-mcp-server" : "https://mcp.example.com/mcp"}" spellcheck="false" />
          </label>
        </div>
        <p class="hint">${server.transport === "stdio" ? "Started with bash -lc in the agent workspace." : "Called with the Streamable HTTP transport."}</p>
      </div>`,
        )
        .join("")
    : `<p class="empty-state small">No MCP servers yet.</p>`;

  main.innerHTML = `
    <form id="agent-form" autocomplete="off">
      <section class="agent-panel">
        <div class="agent-panel-head"><h2>${esc(draft.name || "Agent")}</h2><span class="page-sub">${esc(draft.source ?? "manual")}</span></div>
        <div class="agent-grid">
          <label class="field"><span>Name</span><input data-agent-field="name" value="${esc(draft.name)}" /></label>
          <label class="field"><span>Model</span><input data-agent-field="model" value="${esc(draft.model)}" placeholder="vendor/model" spellcheck="false" /></label>
          <label class="field"><span>Credential / API key</span><select data-agent-field="credentialId">${credentialOptions}</select></label>
          <label class="field"><span>Workspace folder</span><input data-agent-field="workspace" value="${esc(draft.workspace)}" placeholder="data/agent-workspace/${esc(draft.id)}" spellcheck="false" /></label>
        </div>
        <label class="field"><span>Description</span><input data-agent-field="description" value="${esc(draft.description)}" placeholder="What this agent is for" /></label>
        <label class="field"><span>System prompt</span><textarea rows="6" data-agent-field="systemPrompt" placeholder="How this agent should work">${esc(draft.systemPrompt)}</textarea></label>
      </section>

      <section class="agent-panel">
        <div class="agent-panel-head"><h2>Built-in tools &amp; MCPs</h2><span class="page-sub">File access stays inside the workspace folder above.</span></div>
        <div class="tool-grid">
          ${tools
            .map(
              (entry) => `<label class="tool-toggle"><input type="checkbox" data-tool="${esc(entry.key)}" ${
                draft.tools?.[entry.key] ? "checked" : ""
              } /><span><strong>${esc(entry.label)}</strong><em>${esc(entry.hint)}</em></span></label>`,
            )
            .join("")}
        </div>
      </section>

      <section class="agent-panel">
        <div class="agent-panel-head"><h2>Skills</h2><button type="button" class="btn sm" data-add-skill>Add skill</button></div>
        ${skillRows}
      </section>

      <section class="agent-panel">
        <div class="agent-panel-head"><h2>MCP servers</h2><button type="button" class="btn sm" data-add-mcp>Add MCP server</button></div>
        ${mcpRows}
      </section>

      ${
        draft.plugins.length
          ? `<section class="agent-panel"><h2>Plugins</h2><p class="hint">Imported from the config. This runtime records them but does not execute plugin hooks.</p><ul class="agent-list-plain">${draft.plugins
              .map((plugin) => `<li>${esc(plugin)}</li>`)
              .join("")}</ul></section>`
          : ""
      }

      <footer class="agent-actions">
        <button class="btn primary" type="submit">Save agent</button>
        <button class="btn" type="button" data-test-agent>Test agent</button>
        <button class="btn danger" type="button" data-del-agent-current>Delete agent</button>
        <span class="agent-test-result" data-test-result></span>
      </footer>
    </form>`;
}

function agentPayload(draft) {
  return {
    name: draft.name,
    description: draft.description,
    model: draft.model,
    credentialId: draft.credentialId,
    systemPrompt: draft.systemPrompt,
    skills: draft.skills,
    mcpServers: draft.mcpServers,
    tools: draft.tools,
    workspace: draft.workspace,
  };
}

async function saveAgentDraft() {
  const draft = state.agentDraft;
  if (!draft) return;
  try {
    const { agent } = await api(`/api/agents/${draft.id}`, {
      method: "PUT",
      body: JSON.stringify(agentPayload(draft)),
    });
    state.agents = state.agents.map((entry) => (entry.id === agent.id ? agent : entry));
    state.agentDraft = structuredClone(agent);
    renderAgentList();
    renderAgentMain();
    toast(`"${agent.name}" saved.`);
  } catch (err) {
    toast(err.message, "error");
  }
}

$("#new-agent").addEventListener("click", async () => {
  try {
    const { agent } = await api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "New agent" }),
    });
    state.agents.push(agent);
    state.agentSelected = agent.id;
    state.agentDraft = structuredClone(agent);
    renderAgentList();
    renderAgentMain();
  } catch (err) {
    toast(err.message, "error");
  }
});

async function adoptImportedAgent(result) {
  const { credentials } = await api("/api/credentials");
  state.credentials = credentials;
  state.agents = state.agents.filter((entry) => entry.id !== result.agent.id).concat(result.agent);
  state.agentSelected = result.agent.id;
  state.agentDraft = structuredClone(result.agent);
  renderAgentList();
  renderAgentMain();
  const skills = result.agent.skills.length;
  const servers = result.agent.mcpServers.length;
  toast(
    `Imported "${result.agent.name}" · ${skills} skill${skills === 1 ? "" : "s"} · ${servers} MCP server${servers === 1 ? "" : "s"}. ${result.credentialNote}`,
  );
}

async function importAgentFiles(fileList) {
  const files = [];
  for (const file of Array.from(fileList ?? [])) {
    files.push({ name: file.webkitRelativePath || file.name, content: await file.text() });
  }
  if (!files.length) return;
  try {
    const result = await api("/api/agents/import", { method: "POST", body: JSON.stringify({ files }) });
    await adoptImportedAgent(result);
  } catch (err) {
    toast(err.message, "error");
  }
}

$("#agent-import").addEventListener("change", async (event) => {
  const files = Array.from(event.target.files ?? []);
  event.target.value = "";
  await importAgentFiles(files);
});

$("#agent-paste-toggle").addEventListener("click", () => {
  const panel = $("#agent-import-panel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) $("#agent-paste-config").focus();
});

$("#agent-import-close").addEventListener("click", () => {
  $("#agent-import-panel").hidden = true;
});

$("#agent-paste-import").addEventListener("click", async () => {
  const config = $("#agent-paste-config").value.trim();
  const instructions = $("#agent-paste-instructions").value;
  const name = $("#agent-paste-name").value.trim();
  if (!config) return toast("Paste an opencode.json first.", "error");
  const files = instructions.trim() ? [{ name: "AGENTS.md", content: instructions }] : [];
  try {
    const result = await api("/api/agents/import", {
      method: "POST",
      body: JSON.stringify({ config, files, name }),
    });
    await adoptImportedAgent(result);
    $("#agent-paste-config").value = "";
    $("#agent-paste-instructions").value = "";
    $("#agent-paste-name").value = "";
    $("#agent-import-panel").hidden = true;
  } catch (err) {
    toast(err.message, "error");
  }
});

const agentsView = $("#agents-view");
agentsView.addEventListener("dragover", (event) => {
  event.preventDefault();
  agentsView.classList.add("dropping");
});
agentsView.addEventListener("dragleave", (event) => {
  if (!agentsView.contains(event.relatedTarget)) agentsView.classList.remove("dropping");
});
agentsView.addEventListener("drop", (event) => {
  event.preventDefault();
  agentsView.classList.remove("dropping");
  importAgentFiles(event.dataTransfer?.files ?? []);
});

$("#agent-list").addEventListener("click", async (event) => {
  const remove = event.target.closest("[data-del-agent]");
  if (remove) {
    event.stopPropagation();
    if (!confirm("Delete this agent? Nodes using it fall back to their credential.")) return;
    try {
      await api(`/api/agents/${remove.dataset.delAgent}`, { method: "DELETE" });
      state.agents = state.agents.filter((entry) => entry.id !== remove.dataset.delAgent);
      if (state.agentSelected === remove.dataset.delAgent) {
        state.agentSelected = state.agents[0]?.id ?? null;
        state.agentDraft = null;
      }
      await refreshAgents();
    } catch (err) {
      toast(err.message, "error");
    }
    return;
  }
  const row = event.target.closest("[data-agent-id]");
  if (!row) return;
  state.agentSelected = row.dataset.agentId;
  try {
    const { agent } = await api(`/api/agents/${state.agentSelected}`);
    state.agentDraft = structuredClone(agent);
    renderAgentList();
    renderAgentMain();
  } catch (err) {
    toast(err.message, "error");
  }
});

$("#agent-main").addEventListener("input", (event) => {
  const draft = state.agentDraft;
  if (!draft) return;
  const target = event.target;
  if (target.dataset.agentField) {
    draft[target.dataset.agentField] = target.value;
    return;
  }
  if (target.dataset.tool) {
    draft.tools = { ...draft.tools, [target.dataset.tool]: target.checked };
    return;
  }
  if (target.dataset.skillIndex !== undefined && target.dataset.skillField) {
    const skill = draft.skills[Number(target.dataset.skillIndex)];
    if (skill) skill[target.dataset.skillField] = target.value;
    return;
  }
  if (target.dataset.mcpIndex !== undefined && target.dataset.mcpField) {
    const server = draft.mcpServers[Number(target.dataset.mcpIndex)];
    if (!server) return;
    server[target.dataset.mcpField] = target.type === "checkbox" ? target.checked : target.value;
  }
});

$("#agent-main").addEventListener("change", (event) => {
  if (event.target.matches('[data-mcp-field="transport"]')) renderAgentMain();
});

$("#agent-main").addEventListener("click", async (event) => {
  const draft = state.agentDraft;
  if (!draft) return;
  const testButton = event.target.closest("[data-test-agent]");
  if (testButton) {
    const result = document.querySelector("[data-test-result]");
    testButton.disabled = true;
    if (result) {
      result.textContent = "Saving and calling the model…";
      result.className = "agent-test-result";
    }
    try {
      const { agent } = await api(`/api/agents/${draft.id}`, {
        method: "PUT",
        body: JSON.stringify(agentPayload(draft)),
      });
      state.agentDraft = structuredClone(agent);
      state.agents = state.agents.map((entry) => (entry.id === agent.id ? agent : entry));
      const test = await api(`/api/agents/${agent.id}/test`, { method: "POST" });
      if (result) {
        result.textContent = `${test.reply || "(empty reply)"} · ${test.model} · ${test.latencyMs} ms · ${
          test.tools.length
        } tools`;
        result.className = "agent-test-result ok";
      }
    } catch (err) {
      if (result) {
        result.textContent = err.message;
        result.className = "agent-test-result error";
      }
      toast(err.message, "error");
    } finally {
      testButton.disabled = false;
    }
    return;
  }
  if (event.target.closest("[data-add-skill]")) {
    draft.skills.push({ name: `Skill ${draft.skills.length + 1}`, description: "", instructions: "" });
    renderAgentMain();
    return;
  }
  const delSkill = event.target.closest("[data-del-skill]");
  if (delSkill) {
    draft.skills.splice(Number(delSkill.dataset.delSkill), 1);
    renderAgentMain();
    return;
  }
  if (event.target.closest("[data-add-mcp]")) {
    draft.mcpServers.push({ name: `mcp-${draft.mcpServers.length + 1}`, transport: "http", url: "", command: "", headers: {}, env: {}, enabled: true });
    renderAgentMain();
    return;
  }
  const delMcp = event.target.closest("[data-del-mcp]");
  if (delMcp) {
    draft.mcpServers.splice(Number(delMcp.dataset.delMcp), 1);
    renderAgentMain();
    return;
  }
  if (event.target.closest("[data-del-agent-current]")) {
    if (!confirm("Delete this agent? Nodes using it fall back to their credential.")) return;
    api(`/api/agents/${draft.id}`, { method: "DELETE" })
      .then(async () => {
        state.agents = state.agents.filter((entry) => entry.id !== draft.id);
        state.agentSelected = state.agents[0]?.id ?? null;
        state.agentDraft = null;
        await refreshAgents();
      })
      .catch((err) => toast(err.message, "error"));
  }
});

$("#agent-main").addEventListener("submit", (event) => {
  if (event.target.id !== "agent-form") return;
  event.preventDefault();
  saveAgentDraft();
});

// ---------------------------------------------------------------------------
// knowledge view
// ---------------------------------------------------------------------------

function renderKbCredentialOptions() {
  const select = $("#kb-credential");
  if (!select) return;
  const current = select.value;
  select.innerHTML = state.credentials.length
    ? state.credentials
        .map((credential) => `<option value="${esc(credential.id)}">${esc(credential.name)}</option>`)
        .join("")
    : `<option value="">Environment key</option>`;
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

async function refreshKnowledge() {
  const { knowledge } = await api("/api/knowledge");
  state.knowledge = knowledge;
  renderKbCredentialOptions();
  if (!state.knowledge.some((kb) => kb.id === state.kbSelected)) {
    state.kbSelected = state.knowledge[0]?.id ?? null;
    state.kbDocsFor = null;
  }
  await loadKnowledgeDocs();
  await loadMemories();
  renderKnowledge();
}

async function loadKnowledgeDocs() {
  if (!state.kbSelected) {
    state.kbDocs = [];
    state.kbDocsFor = null;
    return;
  }
  if (state.kbDocsFor === state.kbSelected) return;
  try {
    const { documents } = await api(`/api/knowledge/${state.kbSelected}/documents`);
    state.kbDocs = documents;
    state.kbDocsFor = state.kbSelected;
  } catch {
    state.kbDocs = [];
    state.kbDocsFor = null;
  }
}

async function loadMemories() {
  const { memories } = await api("/api/memory?limit=80");
  state.memories = memories;
}

function memoryRows() {
  if (!state.memories.length) {
    return `<p class="empty-state small">Nothing remembered yet. Run a workflow and every node writes its own line.</p>`;
  }
  return `<div class="memory-list">${state.memories
    .map(
      (entry) => `
      <div class="memory-row">
        <time>${esc(new Date(entry.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</time>
        <p>${esc(entry.text)}</p>
        <button data-del-memory="${esc(entry.id)}" title="Forget this">✕</button>
      </div>`,
    )
    .join("")}</div>`;
}

function renderKnowledge() {
  const items = $("#kb-items");
  if (!items) return;
  items.innerHTML = state.knowledge.length
    ? state.knowledge
        .map(
          (kb) => `
      <div class="kb-row ${state.kbSelected === kb.id ? "active" : ""}" data-kb-id="${esc(kb.id)}" role="button" tabindex="0">
        <span class="kb-row-name">${esc(kb.name)}</span>
        <span class="kb-row-meta">${kb.documents} doc${kb.documents === 1 ? "" : "s"} · ${kb.chunks} chunks · ${esc(kb.backend)}</span>
        <button class="kb-row-del" data-del-kb="${esc(kb.id)}" title="Delete knowledge base">✕</button>
      </div>`,
        )
        .join("")
    : `<p class="empty-state small">No knowledge bases yet.</p>`;

  const kb = state.knowledge.find((entry) => entry.id === state.kbSelected) ?? null;
  const agentNote = state.agent ? `${state.agent.runtime} · ${state.agent.defaultModel}` : "";
  const docs = kb && state.kbDocsFor === kb.id ? state.kbDocs : [];

  const main = $("#kb-main");
  if (!main) return;
  main.innerHTML = `
    ${
      kb
        ? `<section class="kb-panel">
      <header class="kb-head"><h2>${esc(kb.name)}</h2><span class="page-sub">${esc(kb.backend)} embeddings${
        kb.model ? ` · ${esc(kb.model)}` : ""
      } · ${kb.chunks} chunks</span></header>
      <form class="doc-form" id="doc-form" autocomplete="off">
        <label class="field"><span>Document title</span><input id="doc-title" placeholder="Notes for ${esc(kb.name)}" /></label>
        <label class="field"><span>Text</span><textarea id="doc-text" rows="7" placeholder="Paste the material this workflow can use. It is chunked and embedded when you save."></textarea></label>
        <div class="doc-form-foot"><span class="form-note" id="doc-note"></span><button class="btn primary sm" type="submit">Add document</button></div>
      </form>
      <div class="doc-list">${
        docs.length
          ? docs
              .map(
                (doc) => `<div class="doc-row"><div class="doc-row-main"><strong>${esc(doc.title)}</strong><span>${doc.chunkCount} chunks · ${esc(
                  doc.text.slice(0, 120),
                )}…</span></div><button data-del-doc="${esc(doc.id)}" title="Delete document">✕</button></div>`,
              )
              .join("")
          : `<p class="empty-state small">No documents in this base yet.</p>`
      }</div>
    </section>`
        : `<section class="kb-panel"><h2>Knowledge</h2><p class="hint">Create a knowledge base on the left, add documents, then attach it to an agent node or a Knowledge search node. Retrieval is real: chunks are embedded and ranked by cosine similarity.</p></section>`
    }

    <section class="kb-panel">
      <header class="kb-head"><h2>Workspace memory</h2><span class="page-sub">${esc(agentNote)}</span></header>
      <p class="hint">Every node that runs writes one line here. Agents read the recent lines plus the closest older ones before acting, so a new step knows what earlier steps and earlier runs did.</p>
      ${memoryRows()}
    </section>`;
}

$("#refresh-kb").addEventListener("click", () => refreshKnowledge().catch((err) => toast(err.message, "error")));

$("#kb-backend").addEventListener("change", () => {
  $("#kb-remote").hidden = $("#kb-backend").value !== "remote";
});

$("#kb-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#kb-name");
  const name = input.value.trim();
  if (!name) return;
  const backend = $("#kb-backend").value;
  const body = { name, backend };
  if (backend === "remote") {
    body.credentialId = $("#kb-credential").value;
    body.model = $("#kb-model").value.trim();
  }
  try {
    const { knowledgeBase } = await api("/api/knowledge", {
      method: "POST",
      body: JSON.stringify(body),
    });
    input.value = "";
    state.kbSelected = knowledgeBase.id;
    state.kbDocsFor = null;
    await refreshKnowledge();
    toast(`"${knowledgeBase.name}" created.`);
  } catch (err) {
    toast(err.message, "error");
  }
});

$("#kb-items").addEventListener("click", async (event) => {
  const remove = event.target.closest("[data-del-kb]");
  if (remove) {
    event.stopPropagation();
    if (!confirm("Delete this knowledge base, its documents and its chunks?")) return;
    try {
      await api(`/api/knowledge/${remove.dataset.delKb}`, { method: "DELETE" });
      if (state.kbSelected === remove.dataset.delKb) {
        state.kbSelected = null;
        state.kbDocsFor = null;
      }
      await refreshKnowledge();
    } catch (err) {
      toast(err.message, "error");
    }
    return;
  }
  const row = event.target.closest("[data-kb-id]");
  if (!row) return;
  state.kbSelected = row.dataset.kbId;
  state.kbDocsFor = null;
  await refreshKnowledge().catch((err) => toast(err.message, "error"));
});

$("#kb-main").addEventListener("submit", async (event) => {
  if (event.target.id !== "doc-form") return;
  event.preventDefault();
  const text = $("#doc-text").value.trim();
  const note = $("#doc-note");
  if (!text) {
    note.textContent = "Paste some text first.";
    note.className = "form-note";
    return;
  }
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  note.textContent = "Chunking and embedding…";
  note.className = "form-note";
  try {
    const result = await api(`/api/knowledge/${state.kbSelected}/documents`, {
      method: "POST",
      body: JSON.stringify({ title: $("#doc-title").value, text }),
    });
    state.kbDocsFor = null;
    await refreshKnowledge();
    toast(`Saved · ${result.chunks} chunk${result.chunks === 1 ? "" : "s"} embedded with ${result.backend}.`);
    if (result.warning) toast(result.warning, "error");
  } catch (err) {
    note.textContent = err.message;
    note.className = "form-note";
  } finally {
    button.disabled = false;
  }
});

$("#kb-main").addEventListener("click", async (event) => {
  const doc = event.target.closest("[data-del-doc]");
  if (doc) {
    if (!confirm("Delete this document and its chunks?")) return;
    try {
      await api(`/api/knowledge/${state.kbSelected}/documents/${doc.dataset.delDoc}`, { method: "DELETE" });
      state.kbDocsFor = null;
      await refreshKnowledge();
    } catch (err) {
      toast(err.message, "error");
    }
    return;
  }
  const memory = event.target.closest("[data-del-memory]");
  if (memory) {
    try {
      await api(`/api/memory/${memory.dataset.delMemory}`, { method: "DELETE" });
      await refreshKnowledge();
    } catch (err) {
      toast(err.message, "error");
    }
  }
});

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

function renderUser() {
  const user = state.user;
  const initials = (user?.name || user?.email || "S").trim().charAt(0).toUpperCase() || "S";
  $("#user-initials").textContent = initials;
  $("#user-name").textContent = user?.name || "Account";
  $("#user-email").textContent = user?.email || "";
}

function setAuthMode(mode) {
  if (mode === "signup" && !state.signupOpen) return;
  state.authMode = mode;
  const signup = mode === "signup";
  $("#auth-title").textContent = signup ? "Create your account" : "Sign in";
  $("#auth-sub").textContent = signup
    ? state.legacyCount
      ? `First account on this server: it adopts the ${state.legacyCount} workflow${
          state.legacyCount === 1 ? "" : "s"
        } and credentials already stored here.`
      : "Create the first account to start building."
    : "Your workflows, runs and credentials belong to your account.";
  $("#auth-name-field").hidden = !signup;
  $("#auth-submit").textContent = signup ? "Create account" : "Sign in";
  $("#auth-toggle").textContent = signup ? "Already have an account? Sign in" : "Create an account";
  $("#auth-password").setAttribute("autocomplete", signup ? "new-password" : "current-password");
  $("#auth-error").textContent = "";
  $("#auth-error").className = "auth-error";
}

function showGate(needsSetup = false, message = "") {
  $("#auth-gate").hidden = false;
  setAuthMode(needsSetup ? "signup" : "login");
  if (message) $("#auth-error").textContent = message;
  setTimeout(() => $("#auth-email").focus(), 60);
}

function hideGate() {
  $("#auth-gate").hidden = true;
}

async function bootWorkspace() {
  const data = await api("/api/state");
  state.user = data.user ?? null;
  state.workflows = data.workflows;
  state.templates = data.templates;
  state.credentials = data.credentials ?? [];
  state.providers = data.providers ?? [];
  state.env = data.env;
  state.knowledge = data.knowledge ?? [];
  state.agents = data.agents ?? [];
  state.builtinTools = data.builtinTools ?? [];
  state.capabilities = data.capabilities ?? { exec: true };
  state.agent = data.agent ?? null;
  renderUser();
  renderModelStatus();
  renderCredentialForm();
  renderFlyout();
  await applyRoute();
  hideGate();
}

async function start() {
  el.tempEdge.classList.add("temp-edge");
  try {
    const session = await api("/api/auth/session");
    state.legacyCount = session.legacy ?? 0;
    state.signupOpen = session.signupOpen !== false;
    $("#auth-toggle").hidden = !state.signupOpen;
    if (session.user) {
      state.user = session.user;
      await bootWorkspace();
    } else {
      showGate(session.needsSetup);
    }
  } catch (err) {
    showGate(false, `Could not reach the server: ${err.message}`);
  }
}

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#auth-submit");
  const error = $("#auth-error");
  button.disabled = true;
  error.textContent = "";
  error.className = "auth-error";
  try {
    const body =
      state.authMode === "signup"
        ? {
            name: $("#auth-name").value,
            email: $("#auth-email").value,
            password: $("#auth-password").value,
          }
        : { email: $("#auth-email").value, password: $("#auth-password").value };
    await api(`/api/auth/${state.authMode}`, { method: "POST", body: JSON.stringify(body) });
    $("#auth-password").value = "";
    await bootWorkspace();
    toast(state.authMode === "signup" ? "Account created. Welcome to Sequor." : "Signed in.");
  } catch (err) {
    $("#auth-gate").hidden = false;
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$("#auth-toggle").addEventListener("click", () => {
  setAuthMode(state.authMode === "signup" ? "login" : "signup");
});

$("#user-btn").addEventListener("click", (event) => {
  event.stopPropagation();
  $("#user-menu").hidden = !$("#user-menu").hidden;
});

document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("#user-menu") && !event.target.closest("#user-btn")) {
    $("#user-menu").hidden = true;
  }
});

$("#logout-btn").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    /* the cookie is cleared server-side either way */
  }
  closeStream();
  location.reload();
});

start();
