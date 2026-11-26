import { randomUUID } from "node:crypto";
import * as db from "./db.js";
import { runAgent, runCheck } from "./agent.js";
import { runHttpNode } from "./http-node.js";
import {
  runBashNode,
  runCodeNode,
  runFetchNode,
  runMcpNode,
  runIfNode,
  runSwitchNode,
  runFilterNode,
  runMergeNode,
  runSetNode,
  runWaitNode,
  runLimitNode,
  runNoOpNode,
  runStopNode,
} from "./nodes.js";
import { rememberNode, runKnowledgeNode } from "./knowledge.js";
import { validateContract } from "./contract.js";
import { renderText } from "./template.js";

class NodeFailure extends Error {}
class CancelError extends Error {}

const activeRuns = new Map();
const listeners = new Map();

export function subscribeRun(runId, handler) {
  if (!listeners.has(runId)) listeners.set(runId, new Set());
  listeners.get(runId).add(handler);
  return () => {
    const set = listeners.get(runId);
    if (!set) return;
    set.delete(handler);
    if (!set.size) listeners.delete(runId);
  };
}

function emit(runId, event) {
  const set = listeners.get(runId);
  if (!set) return;
  for (const handler of set) {
    try {
      handler(event);
    } catch {
      /* a broken subscriber must not kill a run */
    }
  }
}

export function topoSort(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const ids = new Set(nodes.map((node) => node.id));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const adjacency = new Map(nodes.map((node) => [node.id, []]));

  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue;
    adjacency.get(edge.from).push(edge.to);
    indegree.set(edge.to, indegree.get(edge.to) + 1);
  }

  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of adjacency.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }

  if (order.length !== nodes.length) {
    const stuck = nodes.filter((node) => !order.includes(node.id)).map((node) => node.title || node.id);
    return { order, error: `The graph has a cycle through: ${stuck.join(", ")}` };
  }
  return { order, error: null };
}

// Nodes whose outgoing edges depend on which output fired.
const BRANCHING = new Set(["if", "switch", "filter"]);

function mergeOutputs(edges, outputs, runInput) {
  if (!edges.length) return { ...runInput };
  const merged = {};
  for (const edge of edges) Object.assign(merged, outputs.get(edge.from) ?? {});
  return merged;
}

function collectInput(graph, nodeId, outputs, runInput) {
  return mergeOutputs(
    (graph.edges ?? []).filter((edge) => edge.to === nodeId),
    outputs,
    runInput,
  );
}

// A source without branches fires every outgoing edge. A branching node fires
// only the edges whose branch it chose; an unlabelled edge fires whenever the
// node fired anything at all, so older or hand-written graphs still work.
function edgeFired(edge, branches) {
  if (!branches) return true;
  if (!edge.branch) return branches.size > 0;
  return branches.has(edge.branch);
}

function withTimeout(promise, ms) {
  const timeout = Number(ms);
  if (!Number.isFinite(timeout) || timeout <= 0) return promise;
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`node timed out after ${timeout}ms`)), timeout);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function persistNode(runId, node, patch) {
  const row = {
    runId,
    nodeId: node.id,
    title: node.title || node.type,
    nodeType: node.type,
    status: patch.status,
    attempts: patch.attempts ?? 0,
    output: patch.output == null ? null : JSON.stringify(patch.output),
    error: patch.error ?? null,
    logs: patch.logs ?? [],
    cost: patch.cost ?? 0,
    tokensIn: patch.tokensIn ?? 0,
    tokensOut: patch.tokensOut ?? 0,
    durationMs: patch.durationMs ?? null,
  };
  db.upsertRunNode(row);
  emit(runId, {
    type: "node",
    node: {
      nodeId: node.id,
      title: row.title,
      nodeType: node.type,
      status: row.status,
      attempts: row.attempts,
      output: patch.output ?? null,
      rawOutput: patch.rawOutput ?? null,
      error: row.error,
      logs: [...row.logs],
      cost: row.cost,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      durationMs: row.durationMs,
    },
  });
}

async function executeAgentNode(ctx, { initialFeedback = "", attemptOffset = 0 } = {}) {
  const { runId, node, input, ctl } = ctx;
  const totalAttempts = (local) => attemptOffset + local;
  const maxRetries = Number.isFinite(node.max_retries) ? Math.max(0, Math.floor(node.max_retries)) : 1;
  const maxAttempts = maxRetries + 1;
  const startedAt = Date.now();
  const logs = [];
  let feedback = initialFeedback;
  let cost = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let attempts = 0;
  let lastError = "agent failed";
  let lastRaw = null;

  persistNode(runId, node, {
    status: "running",
    attempts: 0,
    logs: [`${node.title} started`, feedback ? `re-running after check feedback: ${feedback}` : null].filter(
      Boolean,
    ),
  });

  while (attempts < maxAttempts) {
    attempts++;
    if (ctl?.cancelled) throw new CancelError("run cancelled");

    let result;
    try {
      result = await withTimeout(
        runAgent({
          node: { ...node, prompt: renderText(node.prompt ?? "", input), _runId: runId },
          input,
          attempt: attempts,
          feedback,
          signal: ctl?.signal,
          userId: ctx.userId,
          workflowId: ctx.workflowId,
        }),
        node.timeout_ms,
      );
    } catch (err) {
      lastError = err.message;
      logs.push(`attempt ${attempts} errored: ${err.message}`);
      persistNode(runId, node, {
        status: attempts < maxAttempts ? "retrying" : "failed",
        attempts: totalAttempts(attempts),
        error: err.message,
        logs,
        cost,
        tokensIn,
        tokensOut,
        durationMs: Date.now() - startedAt,
      });
      ctx.nodeAttempts?.set(node.id, totalAttempts(attempts));
      feedback = err.message;
      continue;
    }

    cost += result.cost ?? 0;
    tokensIn += result.tokensIn ?? 0;
    tokensOut += result.tokensOut ?? 0;
    logs.push(...(result.logs ?? []));
    lastRaw = result.json;
    const validation = validateContract(result.json, node.contract);

    if (validation.ok) {
      logs.push(`contract satisfied on attempt ${attempts}`);
      ctx.nodeAttempts?.set(node.id, totalAttempts(attempts));
      persistNode(runId, node, {
        status: "passed",
        attempts: totalAttempts(attempts),
        output: result.json,
        logs,
        cost,
        tokensIn,
        tokensOut,
        durationMs: Date.now() - startedAt,
      });
      return { output: result.json, cost, tokensIn, tokensOut, attempts };
    }

    lastError = `output contract rejected: ${validation.errors.join("; ")}`;
    logs.push(`attempt ${attempts} rejected by contract: ${validation.errors.join("; ")}`);
    ctx.nodeAttempts?.set(node.id, totalAttempts(attempts));
    persistNode(runId, node, {
      status: attempts < maxAttempts ? "retrying" : "failed",
      attempts: totalAttempts(attempts),
      rawOutput: lastRaw,
      error: lastError,
      logs,
      cost,
      tokensIn,
      tokensOut,
      durationMs: Date.now() - startedAt,
    });
    feedback = lastError;
  }

  throw new NodeFailure(lastError);
}

async function executeHttpNode(ctx) {
  const { runId, node, input, ctl } = ctx;
  const maxRetries = Number.isFinite(node.max_retries) ? Math.max(0, Math.floor(node.max_retries)) : 1;
  const maxAttempts = maxRetries + 1;
  const startedAt = Date.now();
  const logs = [];
  let attempts = 0;
  let lastError = "request failed";

  persistNode(runId, node, { status: "running", attempts: 0, logs: [`${node.title} started`] });

  while (attempts < maxAttempts) {
    attempts++;
    if (ctl?.cancelled) throw new CancelError("run cancelled");
    try {
      const result = await withTimeout(
        runHttpNode({ node, input, signal: ctl?.signal, userId: ctx.userId }),
        node.timeout_ms,
      );
      logs.push(...(result.logs ?? []));
      persistNode(runId, node, {
        status: "passed",
        attempts,
        output: result.json,
        logs,
        durationMs: Date.now() - startedAt,
      });
      return { output: result.json, branches: result.branches ?? null, cost: 0, tokensIn: 0, tokensOut: 0 };
    } catch (err) {
      lastError = err.message;
      logs.push(`attempt ${attempts} errored: ${err.message}`);
      persistNode(runId, node, {
        status: attempts < maxAttempts ? "retrying" : "failed",
        attempts,
        error: err.message,
        logs,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  throw new NodeFailure(lastError);
}

// Fetch, MCP, bash, code and knowledge nodes share one retry loop: a thrown
// error is retried up to max_retries, exactly like a model call.
async function executeDirectNode(ctx, runner) {
  const { runId, node, input, ctl } = ctx;
  const maxRetries = Number.isFinite(node.max_retries) ? Math.max(0, Math.floor(node.max_retries)) : 1;
  const maxAttempts = maxRetries + 1;
  const startedAt = Date.now();
  const logs = [];
  let attempts = 0;
  let lastError = "node failed";

  persistNode(runId, node, { status: "running", attempts: 0, logs: [`${node.title} started`] });

  while (attempts < maxAttempts) {
    attempts++;
    if (ctl?.cancelled) throw new CancelError("run cancelled");
    try {
      const result = await withTimeout(
        runner({ node, input, inputs: ctx.inputs, signal: ctl?.signal, userId: ctx.userId }),
        node.timeout_ms,
      );
      logs.push(...(result.logs ?? []));
      persistNode(runId, node, {
        status: "passed",
        attempts,
        output: result.json,
        logs,
        durationMs: Date.now() - startedAt,
      });
      return { output: result.json, branches: result.branches ?? null, cost: 0, tokensIn: 0, tokensOut: 0 };
    } catch (err) {
      lastError = err.message;
      logs.push(`attempt ${attempts} errored: ${err.message}`);
      persistNode(runId, node, {
        status: attempts < maxAttempts ? "retrying" : "failed",
        attempts,
        error: err.message,
        logs,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  throw new NodeFailure(lastError);
}

async function executeCheckNode(ctx) {
  const { runId, node, graph, outputs, runInput, byId, ctl } = ctx;
  let input = ctx.input;
  const startedAt = Date.now();
  const logs = [];
  let cost = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let rounds = 0;
  let feedback = "";

  const maxRetries = Number.isFinite(node.max_retries) ? Math.max(0, Math.floor(node.max_retries)) : 1;
  const upstreamIds = (graph.edges ?? []).filter((edge) => edge.to === node.id).map((edge) => edge.from);
  const upstreamNode = upstreamIds.length === 1 ? byId.get(upstreamIds[0]) : null;
  const canLoop = upstreamNode && upstreamNode.type === "agent";

  persistNode(runId, node, { status: "running", attempts: 0, logs: [`${node.title} started`] });

  while (true) {
    if (ctl?.cancelled) throw new CancelError("run cancelled");
    rounds++;

    let verdict;
    try {
      const result = await withTimeout(
        runCheck({
          node: { ...node, prompt: renderText(node.prompt ?? "", input), _runId: runId },
          input,
          attempt: rounds,
          feedback,
          signal: ctl?.signal,
          userId: ctx.userId,
        }),
        node.timeout_ms,
      );
      cost += result.cost ?? 0;
      tokensIn += result.tokensIn ?? 0;
      tokensOut += result.tokensOut ?? 0;
      logs.push(...(result.logs ?? []));
      verdict = result.json ?? {};
    } catch (err) {
      verdict = { pass: false, reason: err.message };
      logs.push(`review attempt ${rounds} errored: ${err.message}`);
    }

    const passed = verdict.pass === true || verdict.pass === "true";
    const reason = String(verdict.reason ?? (passed ? "passed" : "failed"));

    if (passed) {
      logs.push(`verdict: pass — ${reason}`);
      const output = { ...input, _check: { pass: true, reason } };
      persistNode(runId, node, {
        status: "passed",
        attempts: rounds,
        output,
        logs,
        cost,
        tokensIn,
        tokensOut,
        durationMs: Date.now() - startedAt,
      });
      return { output, cost, tokensIn, tokensOut };
    }

    feedback = reason;
    logs.push(`verdict: fail — ${reason}`);

    if (!canLoop || rounds > maxRetries || ctl?.cancelled) {
      persistNode(runId, node, {
        status: "failed",
        attempts: rounds,
        error: reason,
        logs,
        cost,
        tokensIn,
        tokensOut,
        durationMs: Date.now() - startedAt,
      });
      throw new NodeFailure(`${node.title} rejected the handoff: ${reason}`);
    }

    logs.push(`sending feedback to "${upstreamNode.title}" for another attempt`);
    persistNode(runId, node, {
      status: "retrying",
      attempts: rounds,
      error: reason,
      logs,
      cost,
      tokensIn,
      tokensOut,
      durationMs: Date.now() - startedAt,
    });

    const rerunInput = collectInput(graph, upstreamNode.id, outputs, runInput);
    const redo = await executeAgentNode(
      { ...ctx, node: upstreamNode, input: rerunInput },
      { initialFeedback: feedback, attemptOffset: ctx.nodeAttempts?.get(upstreamNode.id) ?? 0 },
    );
    outputs.set(upstreamNode.id, redo.output);
    cost += redo.cost;
    tokensIn += redo.tokensIn ?? 0;
    tokensOut += redo.tokensOut ?? 0;
    input = collectInput(graph, node.id, outputs, runInput);
  }
}

async function execute(runId, graph, order, runInput, cache, userId, workflowId) {
  const ctl = { cancelled: false };
  activeRuns.set(runId, ctl);
  const startedAt = Date.now();
  const byId = new Map((graph.nodes ?? []).map((node) => [node.id, node]));
  const outputs = new Map(cache ?? []);
  const cached = cache ?? new Map();
  const live = new Map();
  const nodeBranches = new Map();
  const nodeAttempts = new Map();
  let totalCost = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;

  try {
    for (const nodeId of order) {
      const node = byId.get(nodeId);
      if (!node) continue;

      if (cached.has(nodeId) && !BRANCHING.has(node.type)) {
        persistNode(runId, node, {
          status: "cached",
          attempts: 0,
          output: cached.get(nodeId),
          logs: ["restored from the previous run, not re-executed"],
          durationMs: 0,
        });
        live.set(nodeId, true);
        nodeBranches.set(nodeId, null);
        continue;
      }

      if (ctl.cancelled) throw new CancelError("run cancelled");

      const incoming = (graph.edges ?? []).filter((edge) => edge.to === nodeId);
      const activeEdges = incoming.filter(
        (edge) => live.get(edge.from) === true && edgeFired(edge, nodeBranches.get(edge.from)),
      );

      if (incoming.length && !activeEdges.length) {
        persistNode(runId, node, {
          status: "skipped",
          attempts: 0,
          output: null,
          logs: ["skipped: no incoming branch fired"],
          durationMs: 0,
        });
        live.set(nodeId, false);
        continue;
      }

      const input = mergeOutputs(activeEdges, outputs, runInput);
      const inputs = activeEdges.length ? activeEdges.map((edge) => outputs.get(edge.from) ?? {}) : [{ ...runInput }];
      let result;

      if (node.type === "trigger") {
        result = { output: { ...runInput }, cost: 0, tokensIn: 0, tokensOut: 0 };
        persistNode(runId, node, {
          status: "passed",
          attempts: 1,
          output: result.output,
          logs: [
            `${node.mode === "webhook" ? "webhook" : node.mode === "schedule" ? "schedule" : "manual"} trigger fired`,
            `payload fields: ${Object.keys(runInput).join(", ") || "none"}`,
          ],
          durationMs: 0,
        });
      } else if (node.type === "check") {
        result = await executeCheckNode({
          runId,
          node,
          input,
          graph,
          outputs,
          runInput,
          byId,
          ctl,
          nodeAttempts,
          userId,
        });
      } else if (node.type === "http") {
        result = await executeHttpNode({ runId, node, input, ctl, userId });
      } else if (node.type === "fetch") {
        result = await executeDirectNode({ runId, node, input, ctl, userId }, runFetchNode);
      } else if (node.type === "mcp") {
        result = await executeDirectNode({ runId, node, input, ctl, userId }, runMcpNode);
      } else if (node.type === "bash") {
        result = await executeDirectNode({ runId, node, input, ctl, userId }, runBashNode);
      } else if (node.type === "code") {
        result = await executeDirectNode({ runId, node, input, ctl, userId }, runCodeNode);
      } else if (node.type === "set") {
        result = await executeDirectNode({ runId, node, input, ctl, userId }, runSetNode);
      } else if (node.type === "if") {
        result = await executeDirectNode({ runId, node, input, ctl, userId }, runIfNode);
      } else if (node.type === "switch") {
        result = await executeDirectNode({ runId, node, input, ctl, userId }, runSwitchNode);
      } else if (node.type === "filter") {
        result = await executeDirectNode({ runId, node, input, ctl, userId }, runFilterNode);
      } else if (node.type === "merge") {
        result = await executeDirectNode({ runId, node, input, ctl, userId, inputs }, runMergeNode);
      } else if (node.type === "wait") {
        result = await executeDirectNode({ runId, node, input, ctl, userId }, runWaitNode);
      } else if (node.type === "limit") {
        result = await executeDirectNode({ runId, node, input, ctl, userId }, runLimitNode);
      } else if (node.type === "noop") {
        result = await executeDirectNode({ runId, node, input, ctl, userId }, runNoOpNode);
      } else if (node.type === "stop") {
        result = await executeDirectNode({ runId, node, input, ctl, userId }, runStopNode);
      } else if (node.type === "rag") {
        result = await executeDirectNode({ runId, node, input, ctl, userId }, (args) =>
          runKnowledgeNode({ ...args, node: { ...args.node, _workflowId: workflowId } }),
        );
      } else {
        result = await executeAgentNode({
          runId,
          node,
          input,
          outputs,
          graph,
          runInput,
          byId,
          ctl,
          nodeAttempts,
          userId,
          workflowId,
        });
      }

      outputs.set(nodeId, result.output);
      live.set(nodeId, true);
      nodeBranches.set(nodeId, result.branches ?? null);
      try {
        if (node.type !== "trigger") {
          rememberNode({ userId, workflowId, runId, node, output: result.output });
        }
      } catch {
        // memory is a convenience; it must never fail an execution
      }
      totalCost += result.cost ?? 0;
      totalTokensIn += result.tokensIn ?? 0;
      totalTokensOut += result.tokensOut ?? 0;
    }

    const durationMs = Date.now() - startedAt;
    db.finishRun(runId, "completed", null, totalCost, durationMs, totalTokensIn, totalTokensOut);
    emit(runId, {
      type: "run",
      run: {
        id: runId,
        status: "completed",
        cost: totalCost,
        tokensIn: totalTokensIn,
        tokensOut: totalTokensOut,
        durationMs,
        error: null,
      },
    });
  } catch (err) {
    const cancelled = err instanceof CancelError;
    const durationMs = Date.now() - startedAt;
    db.finishRun(
      runId,
      cancelled ? "cancelled" : "failed",
      cancelled ? null : err.message,
      totalCost,
      durationMs,
      totalTokensIn,
      totalTokensOut,
    );
    emit(runId, {
      type: "run",
      run: {
        id: runId,
        status: cancelled ? "cancelled" : "failed",
        cost: totalCost,
        tokensIn: totalTokensIn,
        tokensOut: totalTokensOut,
        durationMs,
        error: cancelled ? null : err.message,
      },
    });
  } finally {
    activeRuns.delete(runId);
  }
}

export function startRun({ workflow, input = {}, trigger = "manual", cache = null, resumeOf = null }) {
  const graph = workflow.graph ?? { nodes: [], edges: [] };
  const { order, error } = topoSort(graph);
  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  const userId = workflow.userId ?? null;

  db.insertRun({
    id: runId,
    userId,
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: error ? "failed" : "running",
    trigger,
    input,
    graph,
    resumeOf,
    error,
    startedAt,
  });

  if (error) {
    db.finishRun(runId, "failed", error, 0, 0);
    return { runId, error };
  }

  if (!graph.nodes?.length) {
    const message = "This workflow has no nodes yet.";
    db.finishRun(runId, "failed", message, 0, 0);
    return { runId, error: message };
  }

  execute(runId, graph, order, input, cache, userId, workflow.id).catch((err) => {
    db.finishRun(runId, "failed", err.message, 0, 0);
  });

  return { runId, error: null };
}

export function resumeRun(runId, userId) {
  const run = db.getRun(runId, userId);
  if (!run) return null;

  // Resume against the current graph so a fixed prompt actually takes effect,
  // falling back to the run's snapshot if the workflow has been deleted.
  const current = db.getWorkflow(run.workflowId, userId);
  const graph = current?.graph ?? run.graph;

  const rows = db.listRunNodes(runId);
  const cache = new Map();
  for (const row of rows) {
    if (row.status === "passed" || row.status === "cached") {
      cache.set(row.nodeId, row.output ?? {});
    }
  }

  return startRun({
    workflow: { id: run.workflowId, userId, name: current?.name ?? run.workflowName, graph },
    input: run.input,
    trigger: "resume",
    cache,
    resumeOf: runId,
  });
}

export function cancelRun(runId) {
  const ctl = activeRuns.get(runId);
  if (!ctl) return false;
  ctl.cancelled = true;
  return true;
}

export function isRunActive(runId) {
  return activeRuns.has(runId);
}
