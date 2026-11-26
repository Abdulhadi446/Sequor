// Tiny expression layer for real nodes: {{ field }}, {{ a.b }}, {{ items.0.name }},
// plus {{ $now }} and {{ $timestamp }}. A value that is exactly one expression
// keeps its JSON type, which is what bodies and query payloads need.

const EXPRESSION = /\{\{\s*([^}]+?)\s*\}\}/g;

function lookup(input, expression) {
  const clean = expression.trim();
  if (clean === "$now") return new Date().toISOString();
  if (clean === "$timestamp") return Date.now();
  const path = clean.replace(/^\$json\.?/, "");
  if (!path) return input;
  let current = input;
  for (const part of path.split(".").filter(Boolean)) {
    if (current == null) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)];
    else if (typeof current === "object") current = current[part];
    else return undefined;
  }
  return current;
}

function stringify(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function renderTemplate(value, input) {
  if (typeof value !== "string") return value;
  const only = value.match(/^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/);
  if (only) return lookup(input, only[1]);
  return value.replace(EXPRESSION, (_, expression) => stringify(lookup(input, expression)));
}

export function renderText(value, input) {
  const rendered = renderTemplate(value, input);
  return typeof rendered === "string" ? rendered : JSON.stringify(rendered, null, 2);
}

export function renderDeep(value, input) {
  if (typeof value === "string") return renderTemplate(value, input);
  if (Array.isArray(value)) return value.map((entry) => renderDeep(entry, input));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, entry] of Object.entries(value)) output[key] = renderDeep(entry, input);
    return output;
  }
  return value;
}

export function missingExpressions(text) {
  if (typeof text !== "string" || !text.includes("{{")) return [];
  return [...text.matchAll(EXPRESSION)].map((match) => match[1].trim());
}
