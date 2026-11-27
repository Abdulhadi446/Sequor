// Real HTTP request node. Same fetch the server uses for model calls: no mock,
// no canned response. Non-2xx responses are errors, so retries mean something.

import { renderTemplate, renderDeep } from "./template.js";
import { resolveCredential } from "./credentials.js";
import { safeFetch } from "./security.js";

function parseHeaders(raw) {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  const text = String(raw).trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("headers must be a JSON object of name → value");
    }
    return parsed;
  } catch (err) {
    throw new Error(`Headers must be valid JSON: ${err.message}`);
  }
}

function shapeBody(text, contentType) {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const looksJson = /json/i.test(contentType) || /^[[{]/.test(trimmed);
  if (looksJson) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fall through to text */
    }
  }
  return { text };
}

export async function runHttpNode({ node, input, signal, userId }) {
  const startedAt = Date.now();
  const method = String(node.method || "GET").toUpperCase();
  const url = String(renderTemplate(node.url ?? "", input)).trim();

  if (!/^https?:\/\//i.test(url)) {
    throw new Error(
      `HTTP node needs an absolute URL. Got "${url || "(empty)"}". Use {{ field }} to inject values.`,
    );
  }

  const headers = {};
  for (const [key, value] of Object.entries(parseHeaders(node.headers))) {
    const rendered = renderTemplate(value, input);
    headers[key] = typeof rendered === "string" ? rendered : JSON.stringify(rendered);
  }

  if (node.credential_id) {
    const credential = resolveCredential(node.credential_id, userId);
    headers.authorization = `Bearer ${credential.apiKey}`;
  }

  let body;
  if (!["GET", "HEAD"].includes(method) && node.body != null && String(node.body).trim() !== "") {
    let rendered = node.body;
    const text = String(node.body).trim();
    if (/^[[{]/.test(text)) {
      try {
        rendered = renderDeep(JSON.parse(text), input);
      } catch {
        rendered = renderTemplate(node.body, input);
      }
    } else {
      rendered = renderTemplate(node.body, input);
    }
    body = typeof rendered === "string" ? rendered : JSON.stringify(rendered);
    if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
      headers["content-type"] = typeof rendered === "string" ? "text/plain; charset=utf-8" : "application/json";
    }
  }

  // safeFetch validates the URL and every redirect hop, so a workflow cannot
  // be pointed at this machine, a private network or a metadata service.
  const response = await safeFetch(url, { method, headers, body, signal });
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const json = shapeBody(text, contentType);
  const elapsed = Date.now() - startedAt;

  if (!response.ok) {
    const excerpt =
      typeof json.text === "string" ? json.text.slice(0, 240) : JSON.stringify(json).slice(0, 240);
    throw new Error(`${method} ${url} → HTTP ${response.status} ${response.statusText}: ${excerpt}`.trim());
  }

  const logs = [
    `${method} ${url} → ${response.status} (${elapsed}ms)`,
    `${text.length} bytes${contentType ? ` · ${contentType.split(";")[0]}` : ""}`,
    `fields: ${Object.keys(json).slice(0, 12).join(", ") || "none"}`,
  ];

  return { json, cost: 0, tokensIn: 0, tokensOut: 0, logs, status: response.status };
}
