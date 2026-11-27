// Provider credentials, encrypted at rest. The browser can create, list and
// delete credentials but never reads a key back: list responses carry a hint
// (last four characters) only.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "./db.js";
import { assertSafeUrl, assertSafeUrlStatic, privateNetworkAllowed, safeFetch } from "./security.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY_FILE = process.env.SEQUOR_KEY_FILE || join(root, "data", ".secret");

export const PROVIDERS = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    keysUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    keysUrl: "https://openrouter.ai/keys",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    keysUrl: "https://console.groq.com/keys",
  },
  {
    id: "together",
    label: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    keysUrl: "https://api.together.ai/settings/api-keys",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "llama3.2",
    keysUrl: "https://ollama.com/download",
    keyless: true,
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible",
    baseUrl: "",
    model: "",
    keysUrl: "",
  },
];

export const providerById = (id) => PROVIDERS.find((provider) => provider.id === id) ?? null;

// A local model server (Ollama) is expected to live on loopback. Every other
// provider has to be reachable on the public internet unless the operator
// deliberately allows private networks.
export const providerAllowsPrivate = (providerId) => providerId === "ollama" || privateNetworkAllowed;

export const credentialAllowsPrivate = (credential) =>
  credential?.provider === "ollama" || credential?.source === "env" || privateNetworkAllowed;

function encryptionKey() {
  if (existsSync(KEY_FILE)) {
    const stored = readFileSync(KEY_FILE);
    if (stored.length === 32) return stored;
  }
  mkdirSync(dirname(KEY_FILE), { recursive: true });
  const generated = randomBytes(32);
  writeFileSync(KEY_FILE, generated, { mode: 0o600 });
  return generated;
}

function encrypt(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString("base64");
}

function decrypt(blob) {
  const raw = Buffer.from(String(blob), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

function publicShape(row) {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    baseUrl: row.baseUrl,
    model: row.model,
    hint: row.hint,
    createdAt: row.createdAt,
  };
}

export function listCredentials(userId) {
  return db.listCredentials(userId).map(publicShape);
}

export function createCredential(body, userId) {
  const provider = providerById(String(body.provider || "openai"));
  if (!provider) throw new Error(`Unknown provider: ${body.provider}`);

  const apiKey = String(body.apiKey ?? "").trim();
  const baseUrl = String(body.baseUrl ?? "").trim() || provider.baseUrl;
  if (!baseUrl) throw new Error("This provider needs a base URL (for example https://api.example.com/v1)");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("Base URL must start with http:// or https://");
  assertSafeUrlStatic(baseUrl, { allowPrivate: providerAllowsPrivate(provider.id), what: "Base URL" });
  if (!apiKey && !provider.keyless) throw new Error(`${provider.label} needs an API key`);

  const model = String(body.model ?? "").trim() || provider.model;
  const name = String(body.name ?? "").trim() || `${provider.label}${model ? ` · ${model}` : ""}`;

  const row = db.createCredential({
    userId,
    name,
    provider: provider.id,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model,
    secret: encrypt(apiKey),
    hint: apiKey ? `••••${apiKey.slice(-4)}` : "no key",
  });
  return publicShape(row);
}

export function deleteCredential(id, userId) {
  db.deleteCredential(id, userId);
}

export function resolveCredential(id, userId) {
  const row = db.getCredential(id, userId);
  if (!row) throw new Error("That credential was deleted. Pick another one on this node.");
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    baseUrl: row.baseUrl,
    model: row.model,
    apiKey: decrypt(row.secret),
    source: "stored",
  };
}

export function envStatus() {
  const apiKey = process.env.SEQUOR_API_KEY || process.env.OPENAI_API_KEY || "";
  if (!apiKey) return { configured: false, base: "", model: "" };
  return {
    configured: true,
    base: (process.env.SEQUOR_API_BASE || "https://api.openai.com/v1").replace(/\/+$/, ""),
    model: process.env.SEQUOR_MODEL || "gpt-4o-mini",
  };
}

// Resolution order: the node's credential, then the server environment.
export function resolveForNode(node, userId) {
  if (node?.credential_id) return resolveCredential(node.credential_id, userId);
  const env = envStatus();
  if (env.configured) {
    return {
      id: "env",
      name: "Environment",
      provider: "custom",
      baseUrl: env.base,
      model: env.model,
      apiKey: process.env.SEQUOR_API_KEY || process.env.OPENAI_API_KEY || "",
      source: "env",
    };
  }
  throw new Error(
    "No model connected. Open Credentials and add a provider key, or set SEQUOR_API_KEY on the server.",
  );
}

export async function testCredential(id, userId) {
  const cred = resolveCredential(id, userId);
  const started = Date.now();
  const headers = cred.apiKey ? { authorization: `Bearer ${cred.apiKey}` } : {};
  try {
    const url = `${cred.baseUrl}/models`;
    await assertSafeUrl(url, { allowPrivate: credentialAllowsPrivate(cred), what: "Base URL" });
    const response = await safeFetch(url, {
      headers,
      signal: AbortSignal.timeout(12000),
    }, { allowPrivate: credentialAllowsPrivate(cred), what: "Base URL" });
    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 200);
      try {
        detail = JSON.parse(text).error?.message || detail;
      } catch {
        /* keep raw */
      }
      return { ok: false, message: `HTTP ${response.status}: ${detail}`, ms: Date.now() - started };
    }
    let count = 0;
    try {
      const payload = JSON.parse(text);
      count = Array.isArray(payload.data) ? payload.data.length : 0;
    } catch {
      /* some providers return an empty body */
    }
    return {
      ok: true,
      message: count ? `Reachable · ${count} models listed` : "Reachable",
      ms: Date.now() - started,
    };
  } catch (err) {
    return { ok: false, message: err.message, ms: Date.now() - started };
  }
}
