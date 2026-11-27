// One place for the server's security policy.
//
//   exposure   whether this process is reachable from other machines
//   exec       may a workflow run shell commands / JavaScript / stdio MCP
//   private    may outbound requests reach loopback and private networks
//   signup     who may create an account
//   headers    response hardening (CSP, HSTS, framing, sniffing)
//   limits     per-IP rate limits
//   outbound   SSRF checks + redirect re-validation
//
// Everything is environment-driven so the same code runs safely on a laptop
// and on a public host without edits.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const host = String(process.env.HOST || "127.0.0.1").trim();

function flag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return !/^(0|false|no|off|disabled)$/i.test(raw.trim());
}

// A process is "exposed" when it is in production or bound to anything other
// than loopback. Exposed processes get the conservative defaults.
export const exposed = process.env.NODE_ENV === "production" || !LOOPBACK.has(host);

// Shell and JavaScript nodes are code execution as this OS user. On by default
// only for a loopback dev server; a public deployment must opt in.
export const execAllowed = flag("SEQUOR_ALLOW_EXEC", !exposed);

// Outbound requests may reach loopback/private ranges (Ollama, a LAN API) on a
// loopback dev server; a public deployment must opt in.
export const privateNetworkAllowed = flag("SEQUOR_ALLOW_PRIVATE_NETWORK", !exposed);

// open | first-user | closed
export const signupMode = String(process.env.SEQUOR_SIGNUP || "first-user").trim().toLowerCase();
export const trustProxy = flag("SEQUOR_TRUST_PROXY", false);

export function signupOpen(userCount) {
  if (signupMode === "open") return true;
  if (signupMode === "closed" || signupMode === "off" || signupMode === "none") return false;
  return userCount === 0;
}

export function requireExec(feature = "This node") {
  if (execAllowed) return;
  throw new Error(
    `${feature} is disabled on this server. Shell, JavaScript and stdio MCP nodes only run when the operator sets SEQUOR_ALLOW_EXEC=1, because they execute with the server's own privileges.`,
  );
}

// ---- request identity ------------------------------------------------------

export function isSecureRequest(req) {
  if (req.socket?.encrypted) return true;
  if (!trustProxy) return false;
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  return proto === "https";
}

export function clientIp(req) {
  if (trustProxy) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
    const real = String(req.headers["x-real-ip"] || "").trim();
    if (real) return real;
  }
  return String(req.socket?.remoteAddress || "local").replace(/^::ffff:/, "");
}

// ---- response hardening ----------------------------------------------------

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // The editor writes a handful of inline style attributes from JS.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function securityHeaders(req, res) {
  res.setHeader("content-security-policy", CSP);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("x-permitted-cross-domain-policies", "none");
  if (isSecureRequest(req)) {
    res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
}

// ---- rate limits -----------------------------------------------------------

const buckets = new Map();
const MAX_BUCKETS = 10_000;

function sweep(now) {
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Fixed-window counter. Returns { ok, retryAfter } where retryAfter is seconds.
 * Keys are bounded so a flood of unique IPs cannot grow memory without limit.
 */
export function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || entry.resetAt <= now) {
    if (buckets.size >= MAX_BUCKETS) sweep(now);
    if (buckets.size >= MAX_BUCKETS) buckets.clear();
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  entry.count += 1;
  if (entry.count > limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }
  return { ok: true, retryAfter: 0 };
}

// ---- outbound request safety ----------------------------------------------

const METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "169.254.169.254",
  "fd00:ec2::254",
  "100.100.100.200",
]);

const IPV4_BLOCKS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function ipv4ToInt(address) {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIpv4(address) {
  const value = ipv4ToInt(address);
  if (value === null) return true;
  return IPV4_BLOCKS.some(([network, bits]) => {
    const base = ipv4ToInt(network);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (base & mask);
  });
}

function isPrivateIpv6(address) {
  const value = address.toLowerCase().split("%")[0];
  if (value === "::" || value === "::1") return true;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return /^f[cd]/.test(value) || /^fe[89ab]/.test(value) || value.startsWith("ff");
}

export function isPrivateAddress(address) {
  const value = String(address || "").replace(/^\[|\]$/g, "");
  const version = isIP(value);
  if (version === 4) return isPrivateIpv4(value);
  if (version === 6) return isPrivateIpv6(value);
  return true;
}

function blocked(what, detail) {
  return new Error(
    `${what} points at ${detail}, which this server refuses to reach. Use a public address, or set SEQUOR_ALLOW_PRIVATE_NETWORK=1 to allow loopback and private networks.`,
  );
}

/**
 * Validate an outbound URL before any request is made.
 * Rejects non-HTTP schemes, cloud metadata endpoints and (unless allowed)
 * loopback, link-local and private ranges. Hostnames are resolved so a name
 * that points at 127.0.0.1 is treated as loopback.
 *
 * Note: fetch() resolves again when it connects, so this is a strong guard
 * against mistakes and SSRF-by-configuration, not a defence against a
 * DNS-rebinding attacker who controls the hostname.
 */
export async function assertSafeUrl(raw, { allowPrivate = privateNetworkAllowed, what = "URL" } = {}) {
  let url;
  try {
    url = new URL(String(raw ?? ""));
  } catch {
    throw new Error(`${what} is not a valid absolute URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${what} must start with http:// or https://.`);
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (METADATA_HOSTS.has(hostname)) throw blocked(what, "a cloud metadata endpoint");

  const isLocalName =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal");

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname) && !allowPrivate) throw blocked(what, "a private address");
    return url;
  }
  if (isLocalName && !allowPrivate) throw blocked(what, "a local hostname");

  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`${what} host could not be resolved.`);
  }
  if (!addresses.length) throw new Error(`${what} host could not be resolved.`);
  if (!allowPrivate && addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw blocked(what, "a private address");
  }
  return url;
}

/**
 * Synchronous subset of assertSafeUrl for request-less validation (creating a
 * credential). Literal IPs, localhost and metadata names are refused; a DNS
 * name that resolves privately is caught by the request-time checks.
 */
export function assertSafeUrlStatic(raw, { allowPrivate = privateNetworkAllowed, what = "URL" } = {}) {
  let url;
  try {
    url = new URL(String(raw ?? ""));
  } catch {
    throw new Error(`${what} is not a valid absolute URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${what} must start with http:// or https://.`);
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (METADATA_HOSTS.has(hostname)) throw blocked(what, "a cloud metadata endpoint");
  const isLocalName =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal");
  if (isIP(hostname) && isPrivateAddress(hostname) && !allowPrivate) {
    throw blocked(what, "a private address");
  }
  if (isLocalName && !allowPrivate) throw blocked(what, "a local hostname");
  return url;
}

/**
 * fetch() with a validated URL and a validated URL at every redirect hop.
 * Redirects are followed manually so a public URL cannot bounce the server
 * into 127.0.0.1 or a metadata service.
 */
export async function safeFetch(input, init = {}, { allowPrivate = privateNetworkAllowed, what = "URL", maxRedirects = 5 } = {}) {
  let current = String(input);
  let options = { ...init, redirect: "manual" };

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafeUrl(current, { allowPrivate, what });
    const response = await fetch(current, options);
    const location = response.headers.get("location");
    const redirecting = [301, 302, 303, 307, 308].includes(response.status) && location;
    if (!redirecting) return response;

    try {
      await response.body?.cancel?.();
    } catch {
      /* the redirect body is discarded */
    }
    current = new URL(location, current).toString();
    const method = String(options.method || "GET").toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD")) {
      options = { ...options, method: "GET", body: undefined };
    }
  }
  throw new Error(`${what} redirected more than ${maxRedirects} times.`);
}

export function describePolicy() {
  return {
    exposed,
    exec: execAllowed,
    privateNetwork: privateNetworkAllowed,
    signup: signupMode,
    trustProxy,
  };
}
