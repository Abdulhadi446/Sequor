// Real model runtime. Every agent and check node calls an OpenAI-compatible
// chat-completions endpoint with a credential you can manage in the UI.
// There is no built-in fake generator: if no provider is connected, the node
// fails with an actionable error instead of inventing an answer.
//
// Agent nodes are a small tool loop we own: one chat request, optionally with
// knowledge_search / remember tools, then the final JSON contract answer.

import { contractInstruction } from "./contract.js";
import { credentialAllowsPrivate, resolveCredential, resolveForNode } from "./credentials.js";
import { agentSystemPrompt, createToolbox, getAgent } from "./agents.js";
import { assertSafeUrl, safeFetch } from "./security.js";
import {
  agentTools,
  buildAgentContext,
  contextPrompt,
  runAgentTool,
} from "./knowledge.js";

const priceIn = () => Number(process.env.SEQUOR_PRICE_IN || 0);
const priceOut = () => Number(process.env.SEQUOR_PRICE_OUT || 0);

function safeParseJson(text) {
  const raw = String(text ?? "").trim();
  const stripped = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    /* fall through to a wider search */
  }
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(stripped.slice(start, end + 1));
    } catch {
      /* ignore */
    }
  }
  throw new Error(
    `Model did not return JSON (got: ${stripped.slice(0, 140)}${stripped.length > 140 ? "…" : ""})`,
  );
}

function trimInput(input) {
  const json = JSON.stringify(input ?? {}, null, 2);
  if (json.length <= 24000) return json;
  return `${json.slice(0, 24000)}\n… (truncated)`;
}

function authHeaders(credential) {
  const headers = { "content-type": "application/json" };
  if (credential.apiKey) headers.authorization = `Bearer ${credential.apiKey}`;
  if (credential.provider === "openrouter") {
    headers["http-referer"] = "https://sequor.local";
    headers["x-title"] = "Sequor";
  }
  return headers;
}

async function chat({ credential, model, messages, temperature, signal, tools = null, jsonMode = true }) {
  const url = `${credential.baseUrl}/chat/completions`;
  const allowPrivate = credentialAllowsPrivate(credential);
  await assertSafeUrl(url, { allowPrivate, what: "Model endpoint" });
  const payload = { model, temperature, messages };
  if (tools?.length) {
    payload.tools = tools;
    payload.tool_choice = "auto";
  } else if (jsonMode) {
    payload.response_format = { type: "json_object" };
  }

  const send = () =>
    safeFetch(url, {
      method: "POST",
      headers: authHeaders(credential),
      body: JSON.stringify(payload),
      signal,
    }, { allowPrivate, what: "Model endpoint" });

  let response = await send();
  let text = await response.text();

  // Providers differ on optional payload fields. Drop the one they complain
  // about once instead of failing a run over a vendor difference.
  if (!response.ok && response.status < 500) {
    let changed = false;
    if (/response_format|json_object|json mode/i.test(text) && payload.response_format) {
      delete payload.response_format;
      changed = true;
    }
    if (/tool|function/i.test(text) && payload.tools) {
      delete payload.tools;
      delete payload.tool_choice;
      changed = true;
    }
    if (changed) {
      response = await send();
      text = await response.text();
    }
  }

  if (!response.ok) {
    let detail = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text);
      detail = parsed.error?.metadata?.raw || parsed.error?.message || parsed.message || detail;
    } catch {
      /* keep raw excerpt */
    }
    throw new Error(`${credential.name} request failed (${response.status}): ${detail}`);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Provider returned a non-JSON response: ${text.slice(0, 160)}`);
  }

  const message = body.choices?.[0]?.message ?? null;
  const content = message?.content;
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  if (!content && !toolCalls.length) throw new Error("Model returned an empty message");

  const usage = body.usage ?? {};
  const tokensIn = usage.prompt_tokens ?? 0;
  const tokensOut = usage.completion_tokens ?? 0;
  const cost = (tokensIn * priceIn() + tokensOut * priceOut()) / 1_000_000;

  return { message, content, toolCalls, tokensIn, tokensOut, cost, model: body.model || model };
}

function resolveModel(node, credential) {
  return String(node.model || credential.model || "gpt-4o-mini").trim();
}

export async function runAgent({ node, input, attempt, feedback = "", signal, userId, workflowId }) {
  const agent = node.agent_id ? getAgent(node.agent_id, userId) : null;
  const credential = agent?.credentialId
    ? resolveCredential(agent.credentialId, userId)
    : resolveForNode(node, userId);
  const model = String(node.model || agent?.model || credential.model || "gpt-4o-mini").trim();
  const system = agentSystemPrompt(agent, node.prompt);
  const kbIds = Array.isArray(node.kb_ids) ? node.kb_ids.filter(Boolean) : [];
  const memoryOn = node.use_memory !== false && (!agent || agent.tools.memory);

  const context = await buildAgentContext({ node, input, userId, workflowId, useMemory: memoryOn });

  const toolbox = agent
    ? await createToolbox({
        agent,
        userId,
        workflowId,
        runId: node._runId ?? null,
        nodeId: node.id,
        kbIds,
      })
    : null;

  try {
    const tools = toolbox
      ? toolbox.definitions()
      : kbIds.length || memoryOn
        ? agentTools(context)
        : [];
    const useTools = tools.length > 0;

    const parts = [
      `Step: ${node.title}`,
      "Input handed off from the previous step (JSON):",
      trimInput(input),
      "",
      contractInstruction(node.contract),
    ];
    const memorySection = contextPrompt(context);
    if (memorySection) parts.push(memorySection);
    if (feedback) {
      parts.push(
        "",
        `Your previous attempt was rejected: ${feedback}`,
        "Fix exactly that problem and respond with valid JSON.",
      );
    }

    const messages = [
      { role: "system", content: system },
      { role: "user", content: parts.join("\n") },
    ];

    const logs = [];
    if (agent) {
      const enabled = Object.entries(agent.tools)
        .filter(([, value]) => value)
        .map(([key]) => key.replace("_", " "));
      logs.push(`agent: ${agent.name}${agent.source === "opencode.json" ? " (imported)" : ""}`);
      logs.push(`tools: ${enabled.join(", ") || "none"}`);
      logs.push(...toolbox.logs);
    }
    let cost = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    const toolRounds = useTools ? 4 : 1;

    for (let round = 0; round < toolRounds; round++) {
      const allowTools = useTools && round < toolRounds - 1;
      const result = await chat({
        credential,
        model,
        temperature: Number.isFinite(node.temperature) ? node.temperature : 0.4,
        messages,
        signal,
        tools: allowTools ? tools : null,
      });
      cost += result.cost;
      tokensIn += result.tokensIn;
      tokensOut += result.tokensOut;

      if (result.toolCalls.length) {
        messages.push(result.message);
        for (const call of result.toolCalls) {
          const name = call.function?.name ?? "tool";
          let args = {};
          try {
            args = JSON.parse(call.function?.arguments || "{}");
          } catch {
            args = {};
          }
          let toolResult;
          try {
            toolResult = toolbox
              ? await toolbox.call(name, args)
              : await runAgentTool(call, {
                  userId,
                  workflowId,
                  runId: node._runId ?? null,
                  nodeId: node.id,
                  kbIds,
                });
          } catch (err) {
            toolResult = { error: err.message };
          }
          logs.push(`tool ${name}(${String(call.function?.arguments ?? "").slice(0, 120)})`);
          messages.push({
            role: "tool",
            tool_call_id: call.id ?? `call_${round}_${logs.length}`,
            content: JSON.stringify(toolResult).slice(0, 9000),
          });
        }
        if (context.knowledge.matches.length && round === 0) {
          logs.push(`${context.knowledge.matches.length} knowledge chunk${context.knowledge.matches.length === 1 ? "" : "s"} preloaded`);
        }
        if (context.memory.recent.length) logs.push(`${context.memory.recent.length} recent memor${context.memory.recent.length === 1 ? "y" : "ies"} preloaded`);
        continue;
      }

      return {
        json: safeParseJson(result.content),
        cost,
        tokensIn,
        tokensOut,
        logs: [
          `${credential.name} · ${result.model} · attempt ${attempt}`,
          `tokens in/out: ${tokensIn}/${tokensOut}`,
          agent ? `agent: ${agent.name}` : null,
          kbIds.length ? `knowledge: ${kbIds.length} base${kbIds.length === 1 ? "" : "s"}` : null,
          memoryOn ? "workspace memory: on" : null,
          ...logs,
        ].filter(Boolean),
      };
    }

    throw new Error("The agent kept calling tools without producing a final answer");
  } finally {
    await toolbox?.close();
  }
}

export async function runCheck({ node, input, attempt, feedback = "", signal, userId }) {
  const agent = node.agent_id ? getAgent(node.agent_id, userId) : null;
  const credential = agent?.credentialId
    ? resolveCredential(agent.credentialId, userId)
    : resolveForNode(node, userId);
  const model = String(node.model || agent?.model || credential.model || "gpt-4o-mini").trim();
  const system =
    node.prompt?.trim() ||
    agent?.systemPrompt?.trim() ||
    "You are a strict reviewer. Decide whether the handoff passes, and say why in one sentence.";

  const parts = [
    "Review this handoff from the previous step:",
    trimInput(input),
    "",
    'Respond with exactly: {"pass": true|false, "reason": "one sentence"}',
  ];
  if (feedback) parts.push("", `A previous verdict failed for: ${feedback}`);

  const result = await chat({
    credential,
    model,
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: parts.join("\n") },
    ],
    signal,
  });

  const json = safeParseJson(result.content);
  if (typeof json.pass !== "boolean" && typeof json.pass !== "string") {
    throw new Error('Reviewer must return {"pass": true|false, "reason": "…"}');
  }

  return {
    json: { pass: json.pass === true || json.pass === "true", reason: String(json.reason ?? "") },
    cost: result.cost,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    logs: [
      `${credential.name} · ${result.model} · review attempt ${attempt}`,
      `tokens in/out: ${result.tokensIn}/${result.tokensOut}`,
    ],
  };
}

// "Test agent" makes one tiny request so an imported key and model can be
// checked before a workflow depends on them. No tools, no JSON mode.
export async function testAgent({ agent, userId }) {
  const credential = agent.credentialId
    ? resolveCredential(agent.credentialId, userId)
    : resolveForNode({}, userId);
  const model = String(agent.model || credential.model || "").trim() || "gpt-4o-mini";
  const started = Date.now();
  const result = await chat({
    credential,
    model,
    temperature: 0,
    messages: [
      { role: "system", content: agentSystemPrompt(agent, "") },
      { role: "user", content: "Reply with exactly: READY" },
    ],
    jsonMode: false,
  });
  return {
    ok: true,
    reply: String(result.content ?? "").trim().slice(0, 400),
    model: result.model,
    credential: credential.name,
    latencyMs: Date.now() - started,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    tools: Object.entries(agent.tools ?? {})
      .filter(([, enabled]) => enabled)
      .map(([key]) => key),
    skills: agent.skills?.length ?? 0,
    mcpServers: (agent.mcpServers ?? []).filter((server) => server.enabled).map((server) => server.name),
  };
}
