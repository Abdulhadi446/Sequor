// Schedule triggers, for real: active workflows from every account are fired by
// the server on an interval, whether or not the editor is open.

import * as db from "./db.js";
import { startRun } from "./engine.js";

const firings = new Set();
let timer = null;

function triggerOf(workflow) {
  return (workflow.graph?.nodes ?? []).find((node) => node.type === "trigger") ?? null;
}

function sampleInput(trigger) {
  try {
    const parsed = JSON.parse(trigger.sample_input || "{}");
    return parsed && typeof parsed === "object" ? parsed : { value: parsed };
  } catch {
    return {};
  }
}

function isDue(workflow, everyMinutes) {
  const last = db.lastRunAt(workflow.id);
  if (!last) return true;
  const elapsed = Date.now() - new Date(last).getTime();
  return elapsed >= everyMinutes * 60_000 - 5_000;
}

async function tick() {
  let workflows;
  try {
    workflows = db.listActiveWorkflows();
  } catch {
    return;
  }
  for (const workflow of workflows) {
    if (!workflow.active || firings.has(workflow.id)) continue;
    const trigger = triggerOf(workflow);
    if (!trigger || trigger.mode !== "schedule") continue;
    const every = Math.max(1, Math.floor(Number(trigger.every_minutes) || 15));
    if (!isDue(workflow, every)) continue;

    firings.add(workflow.id);
    try {
      const result = startRun({
        workflow,
        input: sampleInput(trigger),
        trigger: "schedule",
      });
      console.log(`[sequor] scheduled run ${result.runId} for "${workflow.name}" (every ${every}m)`);
    } catch (err) {
      console.error(`[sequor] schedule failed for "${workflow.name}":`, err.message);
    } finally {
      setTimeout(() => firings.delete(workflow.id), 10_000);
    }
  }
}

export function startScheduler() {
  if (timer) return;
  timer = setInterval(tick, 20_000);
  timer.unref?.();
  setTimeout(tick, 3_000).unref?.();
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
