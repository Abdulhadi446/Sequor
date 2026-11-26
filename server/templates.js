// Starter workflows. Layout is left-to-right like any node editor; useful work
// comes from real HTTP requests and real model calls, not canned results.

const COLUMN = 236;
const ROW = 132;

function layout(nodes) {
  nodes.forEach((node, index) => {
    node.x = 96 + index * COLUMN;
    node.y = ROW;
  });
  return nodes;
}

function chainEdges(nodes) {
  return nodes.slice(0, -1).map((node, index) => ({ from: node.id, to: nodes[index + 1].id }));
}

function agent(id, title, prompt, contract, extra = {}) {
  return {
    id,
    type: "agent",
    title,
    prompt,
    contract,
    credential_id: "",
    model: "",
    temperature: 0.4,
    kb_ids: [],
    kb_top_k: 5,
    use_memory: true,
    max_retries: 1,
    timeout_ms: 90000,
    ...extra,
  };
}

function check(id, title, prompt, extra = {}) {
  return {
    id,
    type: "check",
    title,
    prompt,
    contract: {},
    credential_id: "",
    model: "",
    max_retries: 1,
    timeout_ms: 60000,
    ...extra,
  };
}

function http(id, title, method, url, extra = {}) {
  return {
    id,
    type: "http",
    title,
    method,
    url,
    headers: "{}",
    body: "",
    credential_id: "",
    max_retries: 2,
    timeout_ms: 30000,
    ...extra,
  };
}

function trigger(id, title, options = {}) {
  return {
    id,
    type: "trigger",
    title,
    mode: "manual",
    every_minutes: 15,
    sample_input: "{}",
    x: 0,
    y: 0,
    ...options,
  };
}

// ---------------------------------------------------------------------------

const blogNodes = layout([
  trigger("trigger-blog", "Daily trigger", {
    mode: "schedule",
    every_minutes: 1440,
    sample_input: JSON.stringify(
      {
        keyword: "agent automation",
        audience: "indie hackers running scheduled content",
      },
      null,
      2,
    ),
  }),
  agent(
    "ideation",
    "Ideation",
    "Generate 3 blog topics for the given keyword. Pick the one angle most likely to resonate with the audience.",
    { topic: "string", angle: "string", audience: "string" },
    { max_retries: 2 },
  ),
  agent(
    "research",
    "Research",
    "Find 5 authoritative sources on the topic. Summarize the key points, then compress them into one paragraph.",
    { sources: "array", key_points: "array", summary: "string" },
    { max_retries: 2 },
  ),
  agent("outlining", "Outlining", "Create a structured outline with hooks, H2s and H3s from the research.", {
    outline: "string",
    h2s: "array",
  }),
  agent(
    "writing",
    "Writing",
    "Write the full draft following the outline. Do not invent sources that were not in the research.",
    { draft: "string", word_count: "number" },
  ),
  agent("editing", "Editing", "Check flow, clarity and brand voice. Tighten anything that does not earn its sentence.", {
    polished: "string",
    edits_made: "number",
  }),
  check(
    "fact-check",
    "Fact check",
    "Reject the draft if it makes a claim that is not supported by the research, or if it invents a source. Otherwise pass it.",
  ),
  agent(
    "formatting",
    "Format",
    "Convert the polished draft to markdown with SEO elements and a meta description.",
    { markdown: "string", meta: "object", seo_score: "number" },
  ),
]);

const outreachNodes = layout([
  trigger("trigger-outreach", "Lead batch", {
    sample_input: JSON.stringify({ segment: "Series A robotics startups", limit: 20 }, null, 2),
  }),
  agent("identify", "Identify leads", "Find companies in the segment that match the ideal customer profile.", {
    company: "string",
    role: "string",
  }),
  agent("enrich", "Enrich", "Enrich the lead with tech stack and recent funding.", {
    tech_stack: "array",
    funding: "string",
  }),
  agent(
    "personalize",
    "Personalize",
    "Write a specific opener and a one-line value proposition for this lead using only the enriched facts.",
    { custom_opener: "string", value_prop: "string" },
  ),
  agent(
    "draft-email",
    "Draft email",
    "Write a short cold email using the opener and value proposition. No filler.",
    { email_copy: "string", subject: "string" },
  ),
  check(
    "review",
    "Review",
    "Reject the email if it is longer than 120 words, generic, or promises a result that was not verified. Otherwise pass it.",
    { max_retries: 2 },
  ),
  http("send", "Send via API", "POST", "https://httpbin.org/post", {
    body: JSON.stringify(
      {
        subject: "{{ subject }}",
        text: "{{ email_copy }}",
        to: "{{ company }}",
      },
      null,
      2,
    ),
    max_retries: 0,
  }),
]);

const repoNodes = layout([
  trigger("trigger-repo", "Every 30 minutes", {
    mode: "schedule",
    every_minutes: 30,
    sample_input: JSON.stringify({ repo: "nodejs/node" }, null, 2),
  }),
  http(
    "fetch-issues",
    "Fetch issues",
    "GET",
    "https://api.github.com/repos/{{ repo }}/issues?per_page=15&state=open",
    {
      headers: JSON.stringify({ accept: "application/vnd.github+json", "user-agent": "sequor" }, null, 2),
      max_retries: 2,
    },
  ),
  agent(
    "triage",
    "Triage issues",
    "Read the issues array. Pick the ones that look like real bugs with reproduction steps, rank them by impact, and name one maintainer action for the top item.",
    { notable_count: "number", summary: "string", top_issue: "string", actions: "array" },
  ),
]);

const briefNodes = layout([
  trigger("trigger-brief", "Daily brief", {
    mode: "schedule",
    every_minutes: 1440,
    sample_input: JSON.stringify({ query: "ai agents" }, null, 2),
  }),
  {
    id: "fetch-news",
    type: "fetch",
    title: "Fetch Hacker News",
    method: "GET",
    url: "https://hn.algolia.com/api/v1/search?query={{ query }}&tags=story&hitsPerPage=10",
    format: "auto",
    headers: "{}",
    credential_id: "",
    max_retries: 2,
    timeout_ms: 30000,
  },
  {
    id: "pick",
    type: "code",
    title: "Pick top stories",
    code: [
      "const hits = input.body?.hits ?? [];",
      "return {",
      "  stories: hits.slice(0, 5).map((hit) => ({",
      "    title: hit.title,",
      "    url: hit.url,",
      "    points: hit.points,",
      "  })),",
      "};",
    ].join("\n"),
    max_retries: 0,
    timeout_ms: 10000,
  },
  agent(
    "brief",
    "Write the brief",
    "From these stories, pick the two that matter most to someone building agent workflows. Explain why in one sentence each, and give a takeaway.",
    { summary: "string", headlines: "array", takeaway: "string" },
  ),
]);

const relayNodes = layout([
  trigger("trigger-hook", "Webhook", {
    mode: "webhook",
    sample_input: JSON.stringify({ event: "ping", message: "hello from Sequor" }, null, 2),
  }),
  http("shape", "Shape payload", "POST", "https://httpbin.org/post", {
    body: JSON.stringify({ source: "sequor", event: "{{ event }}", text: "{{ message }}" }, null, 2),
    max_retries: 1,
  }),
]);

export const TEMPLATES = [
  {
    key: "daily-blog",
    name: "Daily blog",
    description: "Schedule → ideate → research → write → fact check → format. Six model calls per post.",
    needsModel: true,
    graph: { nodes: blogNodes, edges: chainEdges(blogNodes) },
  },
  {
    key: "cold-outreach",
    name: "Cold outreach",
    description: "Lead enrichment with a review node that sends weak drafts back, then a real HTTP send.",
    needsModel: true,
    graph: { nodes: outreachNodes, edges: chainEdges(outreachNodes) },
  },
  {
    key: "repo-watch",
    name: "Repo watch",
    description: "Every 30 minutes: fetch open GitHub issues, then triage the ones worth acting on.",
    needsModel: true,
    graph: { nodes: repoNodes, edges: chainEdges(repoNodes) },
  },
  {
    key: "news-brief",
    name: "Fetch → code → brief",
    description: "No-agent data steps: fetch a real API, shape it with JavaScript, then one agent writes the brief from workspace memory.",
    needsModel: true,
    graph: { nodes: briefNodes, edges: chainEdges(briefNodes) },
  },
  {
    key: "webhook-relay",
    name: "Webhook relay",
    description: "Receives a real webhook and forwards a reshaped payload to any HTTP endpoint.",
    needsModel: false,
    graph: { nodes: relayNodes, edges: chainEdges(relayNodes) },
  },
];

export function getTemplate(key) {
  return TEMPLATES.find((template) => template.key === key) ?? null;
}

export function templateMeta() {
  return TEMPLATES.map(({ key, name, description, needsModel }) => ({
    key,
    name,
    description,
    needsModel,
  }));
}
