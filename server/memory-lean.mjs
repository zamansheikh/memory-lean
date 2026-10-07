#!/usr/bin/env node
// Drop-in replacement for @modelcontextprotocol/server-memory, same memory.jsonl format
// and tool names, tuned to keep tool results small:
//   search_nodes  ranked, capped list of names + matching snippets (not full entities)
//   open_nodes    full entities as compact text, with their relations
//   read_graph    name index grouped by type (not the whole graph)
// Writes enforce the graph budget: observations over OBS_MAX_CHARS are rejected, and
// entities over OBS_MAX_PER_ENTITY move their oldest observations to archive/<name>.md.
// A daily backup is kept in backups/ (last BACKUPS_KEPT days). No dependencies.
//
// Environment (all optional):
//   MEMORY_FILE_PATH        graph file (default ~/.claude/memory-graph/memory.jsonl)
//   MEMORY_OBS_MAX_CHARS    longest observation accepted (default 300)
//   MEMORY_OBS_MAX          observations kept per entity before archiving (default 15)
//   MEMORY_SEARCH_LIMIT     default number of search results (default 10)
//   MEMORY_BACKUPS_KEPT     daily backups kept (default 7)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
};
const FILE = process.env.MEMORY_FILE_PATH || path.join(os.homedir(), ".claude", "memory-graph", "memory.jsonl");
const DIR = path.dirname(FILE);
const ARCHIVE = path.join(DIR, "archive");
const BACKUPS = path.join(DIR, "backups");
const OBS_MAX_CHARS = num("MEMORY_OBS_MAX_CHARS", 300);
const OBS_MAX_PER_ENTITY = num("MEMORY_OBS_MAX", 15);
const SEARCH_LIMIT = num("MEMORY_SEARCH_LIMIT", 10);
const SEARCH_MAX_CHARS = 6000;
const OPEN_MAX_CHARS = 40000;
const BACKUPS_KEPT = num("MEMORY_BACKUPS_KEPT", 7);
const DATE = /20\d\d-\d\d-\d\d/;

// ---------- storage ----------
function load() {
  const g = { entities: [], relations: [] };
  let text;
  try { text = fs.readFileSync(FILE, "utf8"); } catch (e) { if (e.code === "ENOENT") return g; throw e; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "entity") g.entities.push({ name: o.name, entityType: o.entityType, observations: o.observations || [] });
    else if (o.type === "relation") g.relations.push({ from: o.from, to: o.to, relationType: o.relationType });
  }
  return g;
}

function backupOncePerDay() {
  const day = new Date().toISOString().slice(0, 10);
  const target = path.join(BACKUPS, `memory-${day}.jsonl`);
  if (fs.existsSync(target) || !fs.existsSync(FILE)) return;
  fs.mkdirSync(BACKUPS, { recursive: true });
  fs.copyFileSync(FILE, target);
  const old = fs.readdirSync(BACKUPS).filter(f => /^memory-\d{4}-\d\d-\d\d\.jsonl$/.test(f)).sort().slice(0, -BACKUPS_KEPT);
  for (const f of old) fs.unlinkSync(path.join(BACKUPS, f));
}

function save(g) {
  backupOncePerDay();
  const lines = [
    ...g.entities.map(e => JSON.stringify({ type: "entity", name: e.name, entityType: e.entityType, observations: e.observations })),
    ...g.relations.map(r => JSON.stringify({ type: "relation", from: r.from, to: r.to, relationType: r.relationType })),
  ];
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, lines.join("\n") + "\n");
  fs.renameSync(tmp, FILE);
}

// Load, change and save synchronously so the window for a concurrent writer is tiny.
function mutate(fn) { const g = load(); const out = fn(g); save(g); return out; }

function archive(name, observations, why) {
  fs.mkdirSync(ARCHIVE, { recursive: true });
  const file = path.join(ARCHIVE, name.replace(/[^\w.-]+/g, "_") + ".md");
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  fs.appendFileSync(file, `\n## ${why} ${stamp} from \`${name}\`\n` + observations.map(o => `- ${o}\n`).join(""));
}

// Keep undated observations and the newest dated ones; archive the rest.
function enforceCap(e) {
  const over = e.observations.length - OBS_MAX_PER_ENTITY;
  if (over <= 0) return 0;
  const ranked = e.observations
    .map((o, i) => ({ o, i, d: (o.match(DATE) || [""])[0] }))
    .sort((a, b) => (a.d ? 0 : 1) - (b.d ? 0 : 1) || a.d.localeCompare(b.d) || a.i - b.i);
  const drop = new Set(ranked.slice(0, over).map(x => x.i));
  const moved = e.observations.filter((_, i) => drop.has(i));
  e.observations = e.observations.filter((_, i) => !drop.has(i));
  archive(e.name, moved, "auto-archived (over cap)");
  return moved.length;
}

function tooLong(list) { return list.filter(o => typeof o !== "string" || o.length > OBS_MAX_CHARS); }

// ---------- formatting ----------
const relLines = (g, names) => g.relations
  .filter(r => names.has(r.from) || names.has(r.to))
  .map(r => `${r.from} -${r.relationType}-> ${r.to}`);

function formatEntity(e) {
  return `## ${e.name} [${e.entityType}]\n` + e.observations.map(o => `- ${o}`).join("\n");
}

function snippet(text, terms) {
  const low = text.toLowerCase();
  const at = Math.max(0, Math.min(...terms.map(t => low.indexOf(t)).filter(i => i >= 0)) - 50);
  const s = text.slice(at, at + 160);
  return (at > 0 ? "…" : "") + s + (at + 160 < text.length ? "…" : "");
}

// ---------- tools ----------
const tools = {
  search_nodes: {
    description: `Find entities. Every whitespace-separated term must appear in the name, type or an observation (case-insensitive). Returns a ranked list of names with counts and matching snippets, at most 'limit' (default ${SEARCH_LIMIT}); use open_nodes for full entities.`,
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "Search terms" },
      limit: { type: "number", description: `Max results (default ${SEARCH_LIMIT}, max 50)` },
    }, required: ["query"] },
    run({ query, limit }) {
      const g = load();
      const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.length) return "Empty query.";
      const q = terms.join(" ");
      const hits = [];
      for (const e of g.entities) {
        const name = e.name.toLowerCase(), type = e.entityType.toLowerCase();
        const obs = e.observations.filter(o => terms.some(t => o.toLowerCase().includes(t)));
        const all = [name, type, ...obs.map(o => o.toLowerCase())].join("\n");
        if (!terms.every(t => all.includes(t))) continue;
        let score = obs.length;
        if (name === q) score += 1000;
        else if (terms.every(t => name.includes(t))) score += 100;
        if (terms.every(t => type.includes(t))) score += 20;
        hits.push({ e, obs, score });
      }
      if (!hits.length) return `No entities match "${query}".`;
      hits.sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));
      const n = Math.min(Math.max(1, Number(limit) || SEARCH_LIMIT), 50);
      const degree = name => g.relations.filter(r => r.from === name || r.to === name).length;
      let out = `${hits.length} match "${query}"` + (hits.length > n ? `, top ${n} shown (narrow the query or raise limit)` : "") + ". open_nodes for full entities.\n";
      let shown = 0;
      for (const { e, obs } of hits.slice(0, n)) {
        let block = `- ${e.name} [${e.entityType}] ${e.observations.length} obs, ${degree(e.name)} rel\n`;
        for (const o of obs.slice(0, 2)) block += `    › ${snippet(o, terms)}\n`;
        if (out.length + block.length > SEARCH_MAX_CHARS) { out += `… output capped; ${hits.length - shown} more not shown.\n`; break; }
        out += block; shown++;
      }
      return out.trimEnd();
    },
  },

  open_nodes: {
    description: "Return full entities by exact name, with every relation touching them.",
    inputSchema: { type: "object", properties: { names: { type: "array", items: { type: "string" } } }, required: ["names"] },
    run({ names }) {
      const g = load();
      const want = new Set(names);
      const found = g.entities.filter(e => want.has(e.name));
      const got = new Set(found.map(e => e.name));
      const missing = names.filter(n => !got.has(n));
      let out = found.map(formatEntity).join("\n\n");
      const rels = relLines(g, got);
      if (rels.length) out += `\n\n## relations\n` + rels.join("\n");
      for (const m of missing) {
        const lm = m.toLowerCase();
        const near = g.entities.filter(e => e.name.toLowerCase().includes(lm) || lm.includes(e.name.toLowerCase())).slice(0, 5).map(e => e.name);
        out += `\n\nNot found: "${m}"` + (near.length ? `; did you mean: ${near.join(", ")}` : "");
      }
      if (out.length > OPEN_MAX_CHARS) out = out.slice(0, OPEN_MAX_CHARS) + `\n… truncated at ${OPEN_MAX_CHARS} chars; open fewer names.`;
      return out.trim() || "Nothing found.";
    },
  },

  read_graph: {
    description: "Index of the graph: entity names grouped by type, with observation counts. Does not return observations; use open_nodes for those.",
    inputSchema: { type: "object", properties: { entityType: { type: "string", description: "Only this type" } } },
    run({ entityType } = {}) {
      const g = load();
      const byType = {};
      for (const e of g.entities) if (!entityType || e.entityType === entityType) (byType[e.entityType] ||= []).push(`${e.name} (${e.observations.length})`);
      const body = Object.keys(byType).sort().map(t => `${t}: ${byType[t].sort().join("; ")}`).join("\n");
      return `${g.entities.length} entities, ${g.relations.length} relations.\n${body}`;
    },
  },

  create_entities: {
    description: `Create entities; existing names are skipped. Each observation must be one fact of at most ${OBS_MAX_CHARS} characters.`,
    inputSchema: { type: "object", properties: { entities: { type: "array", items: { type: "object", properties: {
      name: { type: "string" }, entityType: { type: "string" }, observations: { type: "array", items: { type: "string" } },
    }, required: ["name", "entityType", "observations"] } } }, required: ["entities"] },
    run({ entities }) {
      const bad = entities.flatMap(e => tooLong(e.observations || []).map(o => `${e.name}: ${String(o).length} chars`));
      if (bad.length) throw new Error(`Rejected, observations over ${OBS_MAX_CHARS} chars (split or shorten; details belong in repo docs):\n${bad.join("\n")}`);
      return mutate(g => {
        const have = new Set(g.entities.map(e => e.name));
        const made = [], skipped = [];
        for (const e of entities) {
          if (have.has(e.name)) { skipped.push(e.name); continue; }
          const ent = { name: e.name, entityType: e.entityType, observations: [...new Set(e.observations || [])] };
          const moved = enforceCap(ent);
          g.entities.push(ent); have.add(e.name); made.push(e.name + (moved ? ` (${moved} archived, over cap)` : ""));
        }
        return `Created: ${made.join(", ") || "none"}` + (skipped.length ? `\nAlready existed (use add_observations): ${skipped.join(", ")}` : "");
      });
    },
  },

  create_relations: {
    description: "Create relations (active voice, e.g. depends_on, blocks, applies_to); duplicates are skipped.",
    inputSchema: { type: "object", properties: { relations: { type: "array", items: { type: "object", properties: {
      from: { type: "string" }, to: { type: "string" }, relationType: { type: "string" },
    }, required: ["from", "to", "relationType"] } } }, required: ["relations"] },
    run({ relations }) {
      return mutate(g => {
        const names = new Set(g.entities.map(e => e.name));
        const made = [], skipped = [], unknown = [];
        for (const r of relations) {
          const line = `${r.from} -${r.relationType}-> ${r.to}`;
          if (!names.has(r.from) || !names.has(r.to)) { unknown.push(line); continue; }
          if (g.relations.some(x => x.from === r.from && x.to === r.to && x.relationType === r.relationType)) { skipped.push(line); continue; }
          g.relations.push({ from: r.from, to: r.to, relationType: r.relationType }); made.push(line);
        }
        let out = `Created ${made.length} relation(s).`;
        if (skipped.length) out += `\nAlready existed: ${skipped.join("; ")}`;
        if (unknown.length) out += `\nSkipped, entity not found: ${unknown.join("; ")}`;
        return out;
      });
    },
  },

  add_observations: {
    description: `Add observations to existing entities. One fact each, at most ${OBS_MAX_CHARS} characters. Replace stale facts with delete_observations rather than appending corrections. Entities over ${OBS_MAX_PER_ENTITY} observations have their oldest moved to archive/.`,
    inputSchema: { type: "object", properties: { observations: { type: "array", items: { type: "object", properties: {
      entityName: { type: "string" }, contents: { type: "array", items: { type: "string" } },
    }, required: ["entityName", "contents"] } } }, required: ["observations"] },
    run({ observations }) {
      const bad = observations.flatMap(x => tooLong(x.contents).map(o => `${x.entityName}: ${String(o).length} chars`));
      if (bad.length) throw new Error(`Rejected, observations over ${OBS_MAX_CHARS} chars (split or shorten; details belong in repo docs):\n${bad.join("\n")}`);
      return mutate(g => {
        const missing = observations.map(x => x.entityName).filter(n => !g.entities.some(e => e.name === n));
        if (missing.length) throw new Error(`Entity not found: ${missing.join(", ")}`);
        const out = [];
        for (const x of observations) {
          const e = g.entities.find(e => e.name === x.entityName);
          const fresh = x.contents.filter(o => !e.observations.includes(o));
          e.observations.push(...fresh);
          const moved = enforceCap(e);
          out.push(`${e.name}: +${fresh.length}` + (moved ? `, ${moved} oldest archived (cap ${OBS_MAX_PER_ENTITY})` : "") + `, now ${e.observations.length}`);
        }
        return out.join("\n");
      });
    },
  },

  delete_entities: {
    description: "Delete entities and every relation touching them.",
    inputSchema: { type: "object", properties: { entityNames: { type: "array", items: { type: "string" } } }, required: ["entityNames"] },
    run({ entityNames }) {
      return mutate(g => {
        const del = new Set(entityNames);
        const before = [g.entities.length, g.relations.length];
        g.entities = g.entities.filter(e => !del.has(e.name));
        g.relations = g.relations.filter(r => !del.has(r.from) && !del.has(r.to));
        return `Deleted ${before[0] - g.entities.length} entities, ${before[1] - g.relations.length} relations.`;
      });
    },
  },

  delete_observations: {
    description: "Delete specific observations (exact text) from entities.",
    inputSchema: { type: "object", properties: { deletions: { type: "array", items: { type: "object", properties: {
      entityName: { type: "string" }, observations: { type: "array", items: { type: "string" } },
    }, required: ["entityName", "observations"] } } }, required: ["deletions"] },
    run({ deletions }) {
      return mutate(g => deletions.map(d => {
        const e = g.entities.find(e => e.name === d.entityName);
        if (!e) return `${d.entityName}: not found`;
        const n = e.observations.length;
        e.observations = e.observations.filter(o => !d.observations.includes(o));
        const unmatched = d.observations.length - (n - e.observations.length);
        return `${e.name}: -${n - e.observations.length}` + (unmatched > 0 ? ` (${unmatched} not matched exactly)` : "");
      }).join("\n"));
    },
  },

  delete_relations: {
    description: "Delete specific relations.",
    inputSchema: { type: "object", properties: { relations: { type: "array", items: { type: "object", properties: {
      from: { type: "string" }, to: { type: "string" }, relationType: { type: "string" },
    }, required: ["from", "to", "relationType"] } } }, required: ["relations"] },
    run({ relations }) {
      return mutate(g => {
        const n = g.relations.length;
        g.relations = g.relations.filter(r => !relations.some(d => d.from === r.from && d.to === r.to && d.relationType === r.relationType));
        return `Deleted ${n - g.relations.length} of ${relations.length} relation(s).`;
      });
    },
  },
};

// ---------- MCP stdio (JSON-RPC, one message per line) ----------
const send = msg => process.stdout.write(JSON.stringify(msg) + "\n");

function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  switch (method) {
    case "initialize":
      return send({ jsonrpc: "2.0", id, result: {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "memory-lean", version: "1.0.0" },
      } });
    case "ping":
      return send({ jsonrpc: "2.0", id, result: {} });
    case "tools/list":
      return send({ jsonrpc: "2.0", id, result: { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) } });
    case "tools/call": {
      const tool = tools[params?.name];
      if (!tool) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
      try {
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: tool.run(params.arguments || {}) }] } });
      } catch (e) {
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(e.message || e) }], isError: true } });
      }
    }
    default:
      return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

readline.createInterface({ input: process.stdin }).on("line", line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  for (const m of Array.isArray(msg) ? msg : [msg]) handle(m);
});
