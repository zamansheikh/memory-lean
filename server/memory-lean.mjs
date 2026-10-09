#!/usr/bin/env node
// Drop-in replacement for @modelcontextprotocol/server-memory, same memory.jsonl format
// and tool names (plus rename_entity and archived_observations), tuned to keep tool results small:
//   search_nodes  ranked, capped list of names + matching snippets (not full entities)
//   open_nodes    full entities as compact text, with their relations
//   read_graph    name index grouped by type (not the whole graph)
// Writes enforce the graph budget: observations over OBS_MAX_CHARS are rejected, and
// entities over OBS_MAX_PER_ENTITY move their oldest dated observations to
// archive/<name>.md. Writers take a lock file, so several sessions can share one graph.
// A daily backup is kept in backups/ (last BACKUPS_KEPT days). No dependencies.
//
// Run with no arguments to serve MCP over stdio, or:
//   --lint      report what is over budget (read-only)
//   --compact   back up, then move overflow observations to archive/
//   --protocol  print the agent instructions (append them to AGENTS.md, CLAUDE.md, ...)
//   --skill DIR write the same instructions as an Agent Skill into DIR/memory-graph
//   --version
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

const VERSION = "1.4.1"; // kept equal to package.json by a test

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
};
const FILE = process.env.MEMORY_FILE_PATH || path.join(os.homedir(), ".claude", "memory-graph", "memory.jsonl");
const DIR = path.dirname(FILE);
const ARCHIVE = path.join(DIR, "archive");
const BACKUPS = path.join(DIR, "backups");
const LOCK = FILE + ".lock";
const UNREADABLE = FILE + ".unreadable";
const OBS_MAX_CHARS = num("MEMORY_OBS_MAX_CHARS", 300);
const OBS_MAX_PER_ENTITY = num("MEMORY_OBS_MAX", 15);
const SEARCH_LIMIT = num("MEMORY_SEARCH_LIMIT", 10);
const SEARCH_MAX_CHARS = 6000;
const OPEN_MAX_CHARS = 40000;
const BACKUPS_KEPT = num("MEMORY_BACKUPS_KEPT", 7);
const LOCK_STALE_MS = 5000;
const LOCK_WAIT_MS = 10000;
const DATE = /20\d\d-\d\d-\d\d/;

const str = v => typeof v === "string" && v.trim() !== "";
const list = (v, what) => { if (!Array.isArray(v)) throw new Error(`"${what}" must be an array.`); return v; };

// ---------- storage ----------
// Lines that are not a valid entity or relation are kept aside in g.unreadable, never dropped.
function load() {
  const g = { entities: [], relations: [], unreadable: [] };
  let text;
  try { text = fs.readFileSync(FILE, "utf8"); } catch (e) { if (e.code === "ENOENT") return g; throw e; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { o = null; }
    if (o?.type === "entity" && str(o.name)) {
      g.entities.push({
        name: o.name,
        entityType: str(o.entityType) ? o.entityType : "unknown",
        observations: Array.isArray(o.observations) ? o.observations.map(String) : [],
      });
    } else if (o?.type === "relation" && str(o.from) && str(o.to) && str(o.relationType)) {
      g.relations.push({ from: o.from, to: o.to, relationType: o.relationType });
    } else g.unreadable.push(line);
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
  if (g.unreadable.length) fs.appendFileSync(UNREADABLE, g.unreadable.join("\n") + "\n");
  const tmp = `${FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, lines.join("\n") + "\n");
  fs.renameSync(tmp, FILE);
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// One writer at a time across processes. A lock older than LOCK_STALE_MS belongs to a
// writer that died and is taken over.
function lock() {
  fs.mkdirSync(DIR, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(LOCK, "wx"));
      return () => { try { fs.unlinkSync(LOCK); } catch {} };
    } catch (e) {
      // Windows reports a lock file that is being deleted as EPERM or EACCES, not EEXIST.
      if (!["EEXIST", "EPERM", "EACCES"].includes(e.code)) throw e;
      if (Date.now() > deadline) throw new Error(`The graph is locked by another writer (${e.code}); try again.`);
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(LOCK);
        else sleep(10 + Math.floor(Math.random() * 20));
      } catch { sleep(5); }
    }
  }
}

// Load, change and save under the lock. Readers need no lock: the file is replaced atomically.
// 'after' runs once the graph is safely written, for changes to other files.
function mutate(fn, after) {
  const unlock = lock();
  try {
    const g = load();
    const out = fn(g);
    save(g);
    after?.();
    return g.unreadable.length
      ? `${out}\nWarning: ${g.unreadable.length} unreadable line(s) in the graph file were moved to ${path.basename(UNREADABLE)}.`
      : out;
  } finally { unlock(); }
}

const archiveFile = name => path.join(ARCHIVE, name.replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "_") + ".md");

function archive(name, observations, why) {
  fs.mkdirSync(ARCHIVE, { recursive: true });
  const file = archiveFile(name);
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  fs.appendFileSync(file, `\n## ${why} ${stamp} from \`${name}\`\n` + observations.map(o => `- ${o}\n`).join(""));
}

// An archive file as sections of { header, items }, one item per archived observation.
function readArchive(name) {
  let text;
  try { text = fs.readFileSync(archiveFile(name), "utf8"); } catch { return []; }
  const sections = [];
  for (const line of text.split("\n")) {
    const last = sections[sections.length - 1];
    if (line.startsWith("## ")) sections.push({ header: line, items: [] });
    else if (line.startsWith("- ")) (last || sections[sections.push({ header: "## archived", items: [] }) - 1]).items.push(line.slice(2));
    else if (line.trim() && last?.items.length) last.items[last.items.length - 1] += "\n" + line;
  }
  return sections;
}

function writeArchive(name, sections) {
  const kept = sections.filter(s => s.items.length);
  if (!kept.length) return fs.rmSync(archiveFile(name), { force: true });
  fs.writeFileSync(archiveFile(name), kept.map(s => `\n${s.header}\n` + s.items.map(o => `- ${o}\n`).join("")).join(""));
}

const archivedOf = name => [...new Set(readArchive(name).flatMap(s => s.items))];

// Indexes of the observations to archive: the oldest dated ones. Undated observations
// (the identity facts) always stay, even if they alone exceed the cap.
function overflow(e) {
  const over = e.observations.length - OBS_MAX_PER_ENTITY;
  if (over <= 0) return new Set();
  const dated = e.observations
    .map((o, i) => ({ i, d: (o.match(DATE) || [""])[0] }))
    .filter(x => x.d)
    .sort((a, b) => a.d.localeCompare(b.d) || a.i - b.i);
  return new Set(dated.slice(0, over).map(x => x.i));
}

function enforceCap(e, why = "auto-archived (over cap)") {
  const drop = overflow(e);
  if (!drop.size) return 0;
  const moved = e.observations.filter((_, i) => drop.has(i));
  e.observations = e.observations.filter((_, i) => !drop.has(i));
  archive(e.name, moved, why);
  return moved.length;
}

function badObservations(owner, observations) {
  return observations.flatMap(o => typeof o !== "string" ? [`${owner}: not a string`]
    : o.length > OBS_MAX_CHARS ? [`${owner}: ${o.length} chars`] : []);
}
const rejectObservations = bad => {
  if (bad.length) throw new Error(`Rejected, observations over ${OBS_MAX_CHARS} chars or not strings (split or shorten; details belong in repo docs):\n${bad.join("\n")}`);
};

// ---------- formatting ----------
const relLine = r => `${r.from} -${r.relationType}-> ${r.to}`;

function formatEntity(e) {
  const archived = archivedOf(e.name).length;
  return `## ${e.name} [${e.entityType}]${archived ? ` (${archived} archived)` : ""}\n` + e.observations.map(o => `- ${o}`).join("\n");
}

function snippet(text, terms) {
  const low = text.toLowerCase();
  const at = Math.max(0, Math.min(...terms.map(t => low.indexOf(t)).filter(i => i >= 0)) - 50);
  const s = text.slice(at, at + 160);
  return (at > 0 ? "…" : "") + s + (at + 160 < text.length ? "…" : "");
}

// ---------- tools ----------
const READ_ONLY = { readOnlyHint: true };

const tools = {
  search_nodes: {
    description: `Find entities. Every whitespace-separated term must appear in the name, type, an observation, or the type of a relation touching the entity (case-insensitive). Returns a ranked list of names with counts and matching snippets, at most 'limit' (default ${SEARCH_LIMIT}); use open_nodes for full entities.`,
    annotations: READ_ONLY,
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "Search terms" },
      limit: { type: "number", description: `Max results (default ${SEARCH_LIMIT}, max 50)` },
    }, required: ["query"] },
    run({ query, limit }) {
      const g = load();
      const terms = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.length) return "Empty query.";
      const q = terms.join(" ");
      const relsOf = new Map();
      for (const r of g.relations) for (const n of new Set([r.from, r.to])) {
        if (!relsOf.has(n)) relsOf.set(n, []);
        relsOf.get(n).push(r);
      }
      const hits = [];
      for (const e of g.entities) {
        const name = e.name.toLowerCase(), type = e.entityType.toLowerCase();
        const obs = e.observations.filter(o => terms.some(t => o.toLowerCase().includes(t)));
        const rels = (relsOf.get(e.name) || []).filter(r => terms.some(t => r.relationType.toLowerCase().includes(t)));
        const all = [name, type, ...obs.map(o => o.toLowerCase()), ...rels.map(r => r.relationType.toLowerCase())].join("\n");
        if (!terms.every(t => all.includes(t))) continue;
        let score = obs.length + Math.min(rels.length, 3);
        if (name === q) score += 1000;
        else if (terms.every(t => name.includes(t))) score += 100;
        if (terms.every(t => type.includes(t))) score += 20;
        hits.push({ e, obs, rels, score });
      }
      if (!hits.length) return `No entities match "${query}".`;
      hits.sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));
      const n = Math.min(Math.max(1, Number(limit) || SEARCH_LIMIT), 50);
      let out = `${hits.length} match "${query}"` + (hits.length > n ? `, top ${n} shown (narrow the query or raise limit)` : "") + ". open_nodes for full entities.\n";
      let shown = 0;
      for (const { e, obs, rels } of hits.slice(0, n)) {
        let block = `- ${e.name} [${e.entityType}] ${e.observations.length} obs, ${(relsOf.get(e.name) || []).length} rel\n`;
        const lines = [...obs.map(o => snippet(o, terms)), ...rels.map(relLine)];
        for (const l of lines.slice(0, 2)) block += `    › ${l}\n`;
        if (out.length + block.length > SEARCH_MAX_CHARS) { out += `… output capped; ${hits.length - shown} more not shown.\n`; break; }
        out += block; shown++;
      }
      return out.trimEnd();
    },
  },

  open_nodes: {
    description: "Return full entities by exact name, with every relation touching them.",
    annotations: READ_ONLY,
    inputSchema: { type: "object", properties: { names: { type: "array", items: { type: "string" } } }, required: ["names"] },
    run({ names }) {
      const g = load();
      const want = new Set(list(names, "names"));
      const found = g.entities.filter(e => want.has(e.name));
      const got = new Set(found.map(e => e.name));
      const rels = g.relations.filter(r => got.has(r.from) || got.has(r.to)).map(relLine);
      let tail = rels.length ? `\n\n## relations\n` + rels.join("\n") : "";
      for (const m of names.filter(n => !got.has(n))) {
        const lm = String(m).toLowerCase();
        const near = g.entities.filter(e => e.name.toLowerCase().includes(lm) || lm.includes(e.name.toLowerCase())).slice(0, 5).map(e => e.name);
        tail += `\n\nNot found: "${m}"` + (near.length ? `; did you mean: ${near.join(", ")}` : "");
      }
      // Over budget, whole entities are left out (and named) rather than cutting the relations off the end.
      const blocks = [], left = [];
      let used = tail.length;
      for (const e of found) {
        const block = formatEntity(e);
        if (blocks.length && used + block.length > OPEN_MAX_CHARS) { left.push(e.name); continue; }
        blocks.push(block); used += block.length + 2;
      }
      let out = blocks.join("\n\n") + tail;
      if (left.length) out += `\n\n… over ${OPEN_MAX_CHARS} chars; not shown, open separately: ${left.join(", ")}`;
      return out.trim() || "Nothing found.";
    },
  },

  read_graph: {
    description: "Index of the graph: entity names grouped by type, with observation counts. Does not return observations; use open_nodes for those.",
    annotations: READ_ONLY,
    inputSchema: { type: "object", properties: { entityType: { type: "string", description: "Only this type" } } },
    run({ entityType } = {}) {
      const g = load();
      const byType = {};
      for (const e of g.entities) if (!entityType || e.entityType === entityType) (byType[e.entityType] ||= []).push(`${e.name} (${e.observations.length})`);
      const body = Object.keys(byType).sort().map(t => `${t}: ${byType[t].sort().join("; ")}`).join("\n");
      return `${g.entities.length} entities, ${g.relations.length} relations.\n${body}`
        + (g.unreadable.length ? `\n${g.unreadable.length} unreadable line(s) in the graph file are ignored; the next write moves them to ${path.basename(UNREADABLE)}.` : "");
    },
  },

  create_entities: {
    description: `Create entities; existing names are skipped. Each observation must be one fact of at most ${OBS_MAX_CHARS} characters.`,
    inputSchema: { type: "object", properties: { entities: { type: "array", items: { type: "object", properties: {
      name: { type: "string" }, entityType: { type: "string" }, observations: { type: "array", items: { type: "string" } },
    }, required: ["name", "entityType", "observations"] } } }, required: ["entities"] },
    run({ entities }) {
      const invalid = list(entities, "entities").flatMap((e, i) => str(e?.name) && str(e?.entityType) ? [] : [`#${i + 1}${str(e?.name) ? ` (${e.name})` : ""}`]);
      if (invalid.length) throw new Error(`Rejected, every entity needs a non-empty name and entityType: ${invalid.join(", ")}`);
      rejectObservations(entities.flatMap(e => badObservations(e.name, list(e.observations ?? [], "observations"))));
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
      if (!list(relations, "relations").every(r => str(r?.from) && str(r?.to) && str(r?.relationType))) throw new Error("Rejected, every relation needs a non-empty from, to and relationType.");
      return mutate(g => {
        const names = new Set(g.entities.map(e => e.name));
        const made = [], skipped = [], unknown = [];
        for (const r of relations) {
          const line = relLine(r);
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
    description: `Add observations to existing entities. One fact each, at most ${OBS_MAX_CHARS} characters. Replace stale facts with delete_observations rather than appending corrections. Entities over ${OBS_MAX_PER_ENTITY} observations have their oldest dated ones moved to archive/.`,
    inputSchema: { type: "object", properties: { observations: { type: "array", items: { type: "object", properties: {
      entityName: { type: "string" }, contents: { type: "array", items: { type: "string" } },
    }, required: ["entityName", "contents"] } } }, required: ["observations"] },
    run({ observations }) {
      rejectObservations(list(observations, "observations").flatMap(x => badObservations(x?.entityName, list(x?.contents, "contents"))));
      return mutate(g => {
        const missing = observations.map(x => x.entityName).filter(n => !g.entities.some(e => e.name === n));
        if (missing.length) throw new Error(`Entity not found: ${missing.join(", ")}`);
        const out = [];
        for (const x of observations) {
          const e = g.entities.find(e => e.name === x.entityName);
          const fresh = [...new Set(x.contents)].filter(o => !e.observations.includes(o));
          e.observations.push(...fresh);
          const moved = enforceCap(e);
          out.push(`${e.name}: +${fresh.length}` + (moved ? `, ${moved} oldest archived (cap ${OBS_MAX_PER_ENTITY})` : "") + `, now ${e.observations.length}`
            + (e.observations.length > OBS_MAX_PER_ENTITY ? ` (over cap ${OBS_MAX_PER_ENTITY}: undated facts are never archived, delete stale ones)` : ""));
        }
        return out.join("\n");
      });
    },
  },

  archived_observations: {
    description: "List the observations of an entity that were moved to archive/, oldest first. Pass 'restore' with exact texts to move them back onto the entity.",
    inputSchema: { type: "object", properties: {
      entityName: { type: "string" },
      query: { type: "string", description: "Only archived observations containing every term" },
      restore: { type: "array", items: { type: "string" }, description: "Exact texts to move back onto the entity" },
    }, required: ["entityName"] },
    run({ entityName, query, restore }) {
      if (!str(entityName)) throw new Error("Rejected, entityName must be a non-empty string.");
      if (restore === undefined) {
        const terms = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const all = archivedOf(entityName);
        const items = all.filter(o => terms.every(t => o.toLowerCase().includes(t)));
        if (!items.length) return all.length ? `None of the ${all.length} archived observation(s) of "${entityName}" match "${query}".` : `Nothing archived for "${entityName}".`;
        // Over budget, the oldest are left out: the newest are the likeliest to be wanted back.
        let shown = items.length, size = 0;
        while (shown > 0 && size + items[shown - 1].length + 3 <= SEARCH_MAX_CHARS) size += items[--shown].length + 3;
        return `${items.length} archived for ${entityName}` + (shown ? `, ${shown} oldest not shown (add a query)` : "") + ":\n" + items.slice(shown).map(o => `- ${o}`).join("\n");
      }
      const want = new Set(list(restore, "restore"));
      let sections;
      return mutate(g => {
        const e = g.entities.find(e => e.name === entityName);
        if (!e) throw new Error(`Entity not found: ${entityName}`);
        sections = readArchive(entityName);
        const found = new Set();
        for (const s of sections) s.items = s.items.filter(o => !want.has(o) || !found.add(o));
        if (!found.size) throw new Error(`None of those are in the archive of "${entityName}" (the text must match exactly).`);
        e.observations.push(...[...found].filter(o => !e.observations.includes(o)));
        return `${e.name}: restored ${found.size}, now ${e.observations.length}`
          + (want.size > found.size ? ` (${want.size - found.size} not matched exactly)` : "")
          + (e.observations.length > OBS_MAX_PER_ENTITY ? ` (over cap ${OBS_MAX_PER_ENTITY}: the next add_observations archives the oldest dated ones again, so delete stale facts first)` : "");
      }, () => writeArchive(entityName, sections));
    },
  },

  rename_entity: {
    description: "Rename an entity, keeping its observations and every relation touching it. Fails if the new name is taken.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "Current name" }, newName: { type: "string" },
    }, required: ["name", "newName"] },
    run({ name, newName }) {
      if (!str(name) || !str(newName)) throw new Error("Rejected, name and newName must be non-empty strings.");
      if (name === newName) return "Nothing to rename.";
      return mutate(g => {
        const e = g.entities.find(e => e.name === name);
        if (!e) throw new Error(`Entity not found: ${name}`);
        if (g.entities.some(e => e.name === newName)) throw new Error(`An entity named "${newName}" already exists.`);
        e.name = newName;
        let rels = 0;
        for (const r of g.relations) {
          if (r.from === name) { r.from = newName; rels++; }
          if (r.to === name) { r.to = newName; rels++; }
        }
        // Its archived observations follow it.
        const from = archiveFile(name), to = archiveFile(newName);
        if (from !== to && fs.existsSync(from)) {
          fs.appendFileSync(to, fs.readFileSync(from, "utf8"));
          fs.unlinkSync(from);
        }
        return `Renamed ${name} -> ${newName}; ${rels} relation end(s) updated.`;
      });
    },
  },

  delete_entities: {
    description: "Delete entities and every relation touching them.",
    inputSchema: { type: "object", properties: { entityNames: { type: "array", items: { type: "string" } } }, required: ["entityNames"] },
    run({ entityNames }) {
      const del = new Set(list(entityNames, "entityNames"));
      return mutate(g => {
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
      for (const d of list(deletions, "deletions")) list(d?.observations, "observations");
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
      list(relations, "relations");
      return mutate(g => {
        const n = g.relations.length;
        g.relations = g.relations.filter(r => !relations.some(d => d?.from === r.from && d?.to === r.to && d?.relationType === r.relationType));
        return `Deleted ${n - g.relations.length} of ${relations.length} relation(s).`;
      });
    },
  },
};

// ---------- MCP stdio (JSON-RPC, one message per line) ----------
const send = msg => process.stdout.write(JSON.stringify(msg) + "\n");

function handle(msg) {
  if (!msg || typeof msg !== "object") return send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  switch (method) {
    case "initialize":
      return send({ jsonrpc: "2.0", id, result: {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "memory-lean", version: VERSION },
      } });
    case "ping":
      return send({ jsonrpc: "2.0", id, result: {} });
    case "tools/list":
      return send({ jsonrpc: "2.0", id, result: { tools: Object.entries(tools).map(([name, t]) => ({
        name, description: t.description, inputSchema: t.inputSchema, ...(t.annotations && { annotations: t.annotations }),
      })) } });
    case "tools/call": {
      const tool = Object.hasOwn(tools, params?.name) && tools[params.name];
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

function serve() {
  readline.createInterface({ input: process.stdin }).on("line", line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    for (const m of Array.isArray(msg) ? msg : [msg]) handle(m);
  });
}

// ---------- command line ----------
// --lint reports what is over budget; --compact applies the cap to every entity.
function lint(apply) {
  if (!fs.existsSync(FILE)) return console.log(`No graph at ${FILE}`);
  const unlock = apply ? lock() : () => {};
  try {
    const g = load();
    const before = fs.statSync(FILE).size;
    let moving = 0, long = 0, stuck = 0;
    for (const e of g.entities) {
      const n = e.observations.length, tooLong = e.observations.filter(o => o.length > OBS_MAX_CHARS).length;
      const drop = overflow(e).size;
      if (n <= OBS_MAX_PER_ENTITY && !tooLong) continue;
      console.log(`${String(n).padStart(4)} obs ${String(tooLong).padStart(3)} long  [${e.entityType}] ${e.name}`);
      moving += drop; long += tooLong;
      if (n - drop > OBS_MAX_PER_ENTITY) stuck++;
    }
    console.log(`\n${g.entities.length} entities, ${g.relations.length} relations, ${before.toLocaleString("en-US")} bytes (${FILE})`);
    console.log(`${moving} observation(s) over the cap of ${OBS_MAX_PER_ENTITY} per entity ${apply ? "moved" : "would move"} to archive/`);
    if (long) console.log(`${long} observation(s) over ${OBS_MAX_CHARS} chars: shorten or split these by hand`);
    if (stuck) console.log(`${stuck} entity(ies) stay over the cap: undated facts are never archived, delete stale ones by hand`);
    if (g.unreadable.length) console.log(`${g.unreadable.length} unreadable line(s): ${apply ? "moved" : "the next write moves them"} to ${path.basename(UNREADABLE)}`);
    if (!apply) return console.log("dry run; pass --compact to apply");
    if (!moving && !g.unreadable.length) return console.log("nothing to do");
    fs.mkdirSync(BACKUPS, { recursive: true });
    const backup = path.join(BACKUPS, `memory-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}-before-compact.jsonl`);
    fs.copyFileSync(FILE, backup);
    for (const e of g.entities) enforceCap(e, "compacted");
    save(g);
    console.log(`written, ${fs.statSync(FILE).size.toLocaleString("en-US")} bytes; backup at ${backup}`);
  } finally { unlock(); }
}

// The instructions an agent needs to use the graph well: --protocol prints them, ready to
// append to a rules file; --skill <dir> writes them as an Agent Skill in <dir>/memory-graph.
const SKILL_HEADER = `---
name: memory-graph
description: Read and maintain the memory-lean knowledge graph (the \`memory\` MCP server). Use at the start of any task, before reading code, to look up the projects, packages and services the task touches, and whenever work changes state - a version bump, publish, deploy, migration or config change, a new project or service, or a rule learned from a failure.
---

`;

function protocolText() {
  try {
    return fs.readFileSync(new URL("../docs/AGENT-PROTOCOL.md", import.meta.url), "utf8")
      .replace(/\n\*Instructions for an AI coding agent[\s\S]*?\*\n/, "");
  } catch {
    process.exitCode = 1;
    console.error("docs/AGENT-PROTOCOL.md is not next to this server; get it from https://github.com/zamansheikh/memory-lean");
  }
}

function writeSkill(dir) {
  const text = protocolText();
  if (!text) return;
  if (!dir) { process.exitCode = 2; return console.error("Usage: memory-lean --skill <skills directory>, e.g. .claude/skills or .agents/skills"); }
  const file = path.join(dir, "memory-graph", "SKILL.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, SKILL_HEADER + text);
  console.log(`Wrote ${file}`);
}

const arg = process.argv[2];
if (!arg) serve();
else if (arg === "--lint") lint(false);
else if (arg === "--compact") lint(true);
else if (arg === "--protocol") process.stdout.write(protocolText() || "");
else if (arg === "--skill") writeSkill(process.argv[3]);
else if (arg === "--version" || arg === "-v") console.log(VERSION);
else {
  console.log("memory-lean [--lint | --compact | --protocol | --skill <dir> | --version]\nWith no arguments, serves MCP over stdio. See README.md.");
  process.exitCode = arg === "--help" || arg === "-h" ? 0 : 2;
}
