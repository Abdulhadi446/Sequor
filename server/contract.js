// Output contracts are plain objects of field name -> type token.
// Tokens: string | number | boolean | array | object | datetime | any
// Suffix "?" marks a field optional. A pipe, e.g. "success|failed", is an enum.

const BASE_TYPES = new Set(["string", "number", "boolean", "array", "object", "datetime", "any"]);

export function normalizeContract(raw) {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return {};
  const clean = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && key.trim()) clean[key.trim()] = value.trim();
  }
  return clean;
}

export function parseContractText(text) {
  if (!text || !text.trim()) return { contract: {}, error: null };
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { contract: {}, error: `Invalid JSON: ${err.message}` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { contract: {}, error: "Contract must be a JSON object of field name -> type" };
  }
  const contract = {};
  for (const [key, spec] of Object.entries(value)) {
    if (!key.trim()) return { contract: {}, error: "Field names cannot be empty" };
    if (typeof spec !== "string" || !spec.trim()) {
      return { contract: {}, error: `Field "${key}" needs a type string, e.g. "string" or "number"` };
    }
    contract[key] = spec.trim();
  }
  return { contract, error: null };
}

function describeType(spec) {
  const clean = spec.replace(/\?$/, "").trim();
  if (clean.includes("|")) return `one of: ${clean.split("|").map((part) => part.trim()).join(", ")}`;
  return clean;
}

export function contractInstruction(contract) {
  const entries = Object.entries(normalizeContract(contract));
  if (!entries.length) {
    return "Respond with one JSON object holding your result. No markdown fences, no commentary.";
  }
  const lines = entries.map(([field, spec]) => {
    const optional = spec.endsWith("?") ? " (optional)" : "";
    return `- "${field}": ${describeType(spec)}${optional}`;
  });
  return [
    "Respond with ONE JSON object and nothing else. No markdown fences, no commentary.",
    "The object must satisfy this output contract:",
    ...lines,
  ].join("\n");
}

export function validateContract(output, contract) {
  const fields = Object.entries(normalizeContract(contract));
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return { ok: false, errors: ["output is not a JSON object"] };
  }
  const errors = [];
  for (const [field, rawSpec] of fields) {
    const optional = rawSpec.endsWith("?");
    const spec = rawSpec.replace(/\?$/, "").trim();
    const value = output[field];

    if (value === undefined || value === null) {
      if (!optional) errors.push(`missing field "${field}"`);
      continue;
    }

    if (spec.includes("|")) {
      const allowed = spec.split("|").map((part) => part.trim());
      if (!allowed.includes(String(value))) {
        errors.push(`field "${field}" must be one of ${allowed.join(", ")} (got ${JSON.stringify(value)})`);
      }
      continue;
    }

    const type = spec.toLowerCase();
    if (!BASE_TYPES.has(type)) continue;

    switch (type) {
      case "string":
      case "datetime":
        if (typeof value !== "string") errors.push(`field "${field}" must be a string (got ${typeof value})`);
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          errors.push(`field "${field}" must be a finite number (got ${JSON.stringify(value)})`);
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") errors.push(`field "${field}" must be a boolean`);
        break;
      case "array":
        if (!Array.isArray(value)) errors.push(`field "${field}" must be an array`);
        break;
      case "object":
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          errors.push(`field "${field}" must be an object`);
        }
        break;
      default:
        break;
    }
  }
  return { ok: errors.length === 0, errors };
}

export function summarizeContract(contract) {
  return Object.entries(normalizeContract(contract))
    .map(([field, spec]) => `${field}: ${spec}`)
    .join(", ");
}
