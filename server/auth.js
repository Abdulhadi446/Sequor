// Accounts, sessions and cookies. Passwords are scrypt-hashed with a per-user
// salt; session tokens are random 256-bit values stored only as SHA-256 hashes.

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import * as db from "./db.js";

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;
const SESSION_COOKIE = "sequor_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD = 8;

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const normalizeEmail = (value) => String(value ?? "").trim().toLowerCase();

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored ?? "").split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const derived = await scryptAsync(password, Buffer.from(saltHex, "hex"), KEY_LENGTH);
  const expected = Buffer.from(hashHex, "hex");
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

function validateSignup({ name, email, password }) {
  const cleanEmail = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new AuthError(400, "Enter a valid email address.");
  if (cleanEmail.length > 190) throw new AuthError(400, "That email is too long.");
  if (String(password ?? "").length < MIN_PASSWORD) {
    throw new AuthError(400, `Password must be at least ${MIN_PASSWORD} characters.`);
  }
  if (String(password).length > 200) throw new AuthError(400, "That password is too long.");
  const cleanName = String(name ?? "").trim().slice(0, 80) || cleanEmail.split("@")[0];
  return { name: cleanName, email: cleanEmail, password: String(password) };
}

export async function createAccount({ name, email, password }) {
  const clean = validateSignup({ name, email, password });
  if (db.getUserByEmail(clean.email)) {
    throw new AuthError(409, "An account with that email already exists.");
  }
  return db.createUser({
    name: clean.name,
    email: clean.email,
    passwordHash: await hashPassword(clean.password),
  });
}

const attempts = new Map();

function throttleKey(ip, email) {
  return `${ip}|${normalizeEmail(email)}`;
}

export function loginBlocked(ip, email) {
  const entry = attempts.get(throttleKey(ip, email));
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    attempts.delete(throttleKey(ip, email));
    return false;
  }
  return entry.count >= 8;
}

function noteFailure(ip, email) {
  const key = throttleKey(ip, email);
  const entry = attempts.get(key);
  if (!entry || Date.now() > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: Date.now() + 10 * 60 * 1000 });
    return;
  }
  entry.count += 1;
}

export async function login({ email, password, ip }) {
  const cleanEmail = normalizeEmail(email);
  if (loginBlocked(ip, cleanEmail)) {
    throw new AuthError(429, "Too many attempts. Try again in a few minutes.");
  }
  const user = db.getUserByEmail(cleanEmail);
  const hash = user ? db.getPasswordHash(user.id) : null;
  const ok = hash ? await verifyPassword(String(password ?? ""), hash) : false;
  if (!ok) {
    noteFailure(ip, cleanEmail);
    throw new AuthError(401, "Email or password is incorrect.");
  }
  attempts.delete(throttleKey(ip, cleanEmail));
  return user;
}

const hashToken = (token) => createHash("sha256").update(token).digest("hex");

export function startSession(userId, userAgent) {
  const token = randomBytes(32).toString("base64url");
  db.createSession({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    userAgent,
  });
  return token;
}

export function readCookie(req, name = SESSION_COOKIE) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== name) continue;
    return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function currentUser(req) {
  const token = readCookie(req);
  if (!token) return null;
  const session = db.getSessionByHash(hashToken(token));
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    db.deleteSession(session.id);
    return null;
  }
  return db.getUserById(session.userId);
}

export function endSession(req) {
  const token = readCookie(req);
  if (token) db.deleteSessionByHash(hashToken(token));
}

function isSecure(req) {
  if (req.socket?.encrypted) return true;
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  return proto === "https";
}

export function setSessionCookie(req, res, token) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isSecure(req)) parts.push("Secure");
  res.setHeader("set-cookie", parts.join("; "));
}

export function clearSessionCookie(req, res) {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isSecure(req)) parts.push("Secure");
  res.setHeader("set-cookie", parts.join("; "));
}

export function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw new AuthError(401, "Please sign in to continue.");
  return user;
}

export function purgeExpiredSessions() {
  db.deleteExpiredSessions();
}

export const PASSWORD_MIN_LENGTH = MIN_PASSWORD;
