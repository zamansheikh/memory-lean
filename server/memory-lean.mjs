#!/usr/bin/env node
// Drop-in replacement for @modelcontextprotocol/server-memory, same memory.jsonl format
// and tool names (plus rename_entity, replace_observation and archived_observations), tuned
// to keep tool results small:
//   search_nodes  ranked, capped list of names + matching snippets (not full entities)
//   open_nodes    full entities as compact text, with their relations
//   read_graph    name index grouped by type (not the whole graph)
// Writes enforce the graph budget: observations over OBS_MAX_CHARS are rejected, and
// entities over OBS_MAX_PER_ENTITY move their oldest dated observations to
// archive/<name>.md. Writers take a lock file, so several sessions can share one graph.
// A daily backup is kept in backups/ (last BACKUPS_KEPT days). No dependencies.
//
// Run with no arguments to serve MCP over stdio, or:
//   --lint      report what is over budget or needs tidying (read-only)
//   --compact   back up, then move overflow observations to archive/
//   --protocol  print the agent instructions (append them to AGENTS.md, CLAUDE.md, ...)
//   --skill DIR write the same instructions as an Agent Skill into DIR/memory-graph
//   --ui [PORT] open a local web page to explore and edit the graph (--no-open: just print the link;
//               --demo: a throwaway copy of a made-up example graph instead of yours)
//   --version
//
// Environment (all optional):
//   MEMORY_FILE_PATH        graph file (default ~/.claude/memory-graph/memory.jsonl)
//   MEMORY_OBS_MAX_CHARS    longest observation accepted (default 300; the tools ask for half)
//   MEMORY_OBS_MAX          observations kept per entity before archiving (default 15)
//   MEMORY_SEARCH_LIMIT     default number of search results (default 10)
//   MEMORY_BACKUPS_KEPT     daily backups kept (default 7)
//   MEMORY_INSTRUCTIONS     "off" to not send the short usage note to the client at startup
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const VERSION = "1.5.0"; // kept equal to package.json by a test

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
// The length the tools ask for. Told only the limit, agents write up to it.
const OBS_TARGET_CHARS = Math.round(OBS_MAX_CHARS / 2);
const OBS_MAX_PER_ENTITY = num("MEMORY_OBS_MAX", 15);
const SEARCH_LIMIT = num("MEMORY_SEARCH_LIMIT", 10);
const SEARCH_MAX_CHARS = 6000;
const OPEN_MAX_CHARS = 40000;
const READ_MAX_CHARS = 8000;
const ARCHIVE_HITS_SHOWN = 3;
const ARCHIVE_NAMES_SHOWN = 5;
const TOP_HITS = 3;
const PART_MIN_CHARS = 8;
const HERE_LEVELS = 5;
const PENDING_STALE_DAYS = 30;
const BACKUPS_KEPT = num("MEMORY_BACKUPS_KEPT", 7);
const LOCK_STALE_MS = 5000;
const LOCK_WAIT_MS = 10000;
const DATE = /20\d\d-\d\d-\d\d/;

// Sent to the client at startup, which shows it to the agent: enough to use the graph where the
// full protocol (docs/AGENT-PROTOCOL.md) was never installed. Short, because every session pays for it.
const INSTRUCTIONS = /^(off|0|false|no)$/i.test(process.env.MEMORY_INSTRUCTIONS || "") ? "" : [
  "Long-term memory shared by all sessions and projects: a knowledge graph of the user's projects, their dependencies, versions, pending work and rules learned from failures.",
  "Before reading code for a task, open_nodes the exact names of the projects, packages and services it touches with related: true (search_nodes if unsure of a name), then the rules and pending work it lists that bear on the task; treat what you read as claims to re-verify.",
  `When work changes state (version bump, publish, deploy, config change, new service, lesson from a failure), record it at once as a dated observation of one short fact (under ${OBS_TARGET_CHARS} characters), replacing a stale fact with replace_observation instead of appending a correction.`,
  "Never store secrets, only where they live.",
].join(" ");

const str = v => typeof v === "string" && v.trim() !== "";
// A name or type is matched exactly later and printed inside one line of text.
const label = v => str(v) && v === v.trim() && !/[\r\n]/.test(v);
const list = (v, what) => { if (!Array.isArray(v)) throw new Error(`"${what}" must be an array.`); return v; };
const oneLine = s => s.replace(/\s*[\r\n]+\s*/g, " ").trim();
const clip = (s, n = 60) => s.length > n ? s.slice(0, n) + "…" : s;
// Equal for names that differ only in case or separators: "Shop API", "shop_api", "shop-api".
const fold = name => name.toLowerCase().replace(/[\s_-]+/g, "");

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

// Readers never see a half-written file.
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function save(g) {
  backupOncePerDay();
  const lines = [
    ...g.entities.map(e => JSON.stringify({ type: "entity", name: e.name, entityType: e.entityType, observations: e.observations })),
    ...g.relations.map(r => JSON.stringify({ type: "relation", from: r.from, to: r.to, relationType: r.relationType })),
  ];
  if (g.unreadable.length) fs.appendFileSync(UNREADABLE, g.unreadable.join("\n") + "\n");
  writeAtomic(FILE, lines.join("\n") + "\n");
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

// ---------- archive ----------
// archive/<name>.md holds the observations moved off an entity, in sections headed
//   ## <why> <when> from `<entity>`
// The file name is a readable hint, not an identity: names that differ only in case or
// punctuation share a file, so a section belongs to the entity its header names.
const archiveFile = name => path.join(ARCHIVE, name.replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "_") + ".md");
// Equal for two names that a case-insensitive disk keeps in one file.
const fileKey = file => path.basename(file).normalize("NFC").toLowerCase();
const HEADER = /^(## .*? from (?:entity )?`)(.*)`( \(deleted [^()]*\))?$/;
const stamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const liveNames = g => new Set(g.entities.map(e => e.name));

function archive(name, observations, why) {
  fs.mkdirSync(ARCHIVE, { recursive: true });
  fs.appendFileSync(archiveFile(name), `\n## ${why} ${stamp()} from \`${oneLine(name)}\`\n` + observations.map(o => `- ${oneLine(o)}\n`).join(""));
}

// An archive file as sections of { header, owner, deleted, items }, one item per archived
// observation. 'owner' is the entity the header names, or null in a file written by hand.
function parseArchive(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const sections = [];
  for (const line of text.split(/\r?\n/)) {
    const last = sections[sections.length - 1];
    if (line.startsWith("## ")) {
      const m = line.match(HEADER);
      sections.push({ header: line, owner: m ? m[2] : null, deleted: !!m?.[3], items: [] });
    }
    else if (line.startsWith("- ")) (last || sections[sections.push({ header: "## archived", owner: null, deleted: false, items: [] }) - 1]).items.push(line.slice(2));
    else if (line.trim() && last?.items.length) last.items[last.items.length - 1] += " " + line.trim();
  }
  return sections;
}

function writeArchive(file, sections) {
  const kept = sections.filter(s => s.items.length);
  if (!kept.length) return fs.rmSync(file, { force: true });
  writeAtomic(file, kept.map(s => `\n${s.header}\n` + s.items.map(o => `- ${o}\n`).join("")).join(""));
}

// Whether a section in the file of 'name' is its own. Versions before 1.6 moved a renamed
// entity's sections without renaming them, so a section left under a name that is not a
// live entity sharing this file belongs to whoever holds the file now.
const owns = (s, name, live) => !s.deleted && (s.owner === name || s.owner === null
  || !(live.has(s.owner) && fileKey(archiveFile(s.owner)) === fileKey(archiveFile(name))));

const reHead = (header, name) => {
  const m = header.match(HEADER);
  return m ? `${m[1]}${oneLine(name)}\`` : `${header} from \`${oneLine(name)}\``;
};

const archivedOf = (name, live) => [...new Set(parseArchive(archiveFile(name)).filter(s => owns(s, name, live)).flatMap(s => s.items))];

// Entity name -> its archived observations, for every entity that has some. Each file is read once.
function archiveIndex(g) {
  const index = new Map(), parsed = new Map(), live = liveNames(g);
  let files;
  try { files = new Set(fs.readdirSync(ARCHIVE).map(fileKey)); } catch { return index; }
  for (const e of g.entities) {
    const file = archiveFile(e.name);
    if (!files.has(fileKey(file))) continue;
    if (!parsed.has(file)) parsed.set(file, parseArchive(file));
    const items = [...new Set(parsed.get(file).filter(s => owns(s, e.name, live)).flatMap(s => s.items))];
    if (items.length) index.set(e.name, items);
  }
  return index;
}

// The archived observations of a renamed entity follow it, under its new name.
function moveArchive(name, newName, live) {
  const from = archiveFile(name), all = parseArchive(from);
  const mine = all.filter(s => owns(s, name, live));
  if (!mine.length) return;
  writeArchive(from, all.filter(s => !mine.includes(s)));
  for (const s of mine) s.header = reHead(s.header, newName);
  // Read after the write above: on a case-insensitive disk the two names can be one file.
  fs.mkdirSync(ARCHIVE, { recursive: true });
  writeArchive(archiveFile(newName), [...parseArchive(archiveFile(newName)), ...mine]);
}

// The archived observations of a deleted entity stay on disk, marked so that a later
// entity of the same name does not inherit them.
function retireArchive(names, live) {
  for (const name of names) {
    const file = archiveFile(name), all = parseArchive(file);
    const mine = all.filter(s => owns(s, name, live));
    for (const s of mine) s.header = `${reHead(s.header, name)} (deleted ${stamp()})`;
    if (mine.length) writeArchive(file, all);
  }
}

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
    : !o.trim() ? [`${owner}: empty`]
    : /[\r\n]/.test(o) ? [`${owner}: has a line break`]
    : o.length > OBS_MAX_CHARS ? [`${owner}: ${o.length} chars`] : []);
}
const rejectObservations = bad => {
  if (bad.length) throw new Error(`Rejected, an observation must be a non-empty string on one line and not over ${OBS_MAX_CHARS} chars (split it, or shorten it to about ${OBS_TARGET_CHARS}; details belong in repo docs):\n${bad.join("\n")}`);
};

// The observation a caller means: the one with exactly this text, or failing that the only
// one containing it, so a long fact can be named by a distinctive part instead of being
// repeated in full. Returns its index, -1 for no match, -2 when several contain the text.
function findObservation(e, text) {
  const exact = e.observations.indexOf(text);
  if (exact >= 0 || typeof text !== "string" || text.trim().length < PART_MIN_CHARS) return exact;
  const at = e.observations.flatMap((o, i) => o.includes(text) ? [i] : []);
  return at.length === 1 ? at[0] : at.length ? -2 : -1;
}

// Names a caller may have meant: 'same' are equal but for case and separators, 'all' adds
// those that contain the name or are contained in it.
function nearNames(g, name, max = 5) {
  const f = fold(String(name)), same = [], part = [];
  if (f) for (const e of g.entities) {
    const x = fold(e.name);
    if (x === f) same.push(e.name);
    else if (x && (x.includes(f) || f.includes(x))) part.push(e.name);
  }
  return { same, all: [...same, ...part].slice(0, max) };
}
const notFound = (g, names) => new Error("Entity not found: " + names.map(n => {
  const near = nearNames(g, n).all;
  return near.length ? `${n} (did you mean: ${near.join(", ")})` : n;
}).join(", "));

// The entities named after the folder the client started the server in, or a folder above
// it, nearest first: the project this session is about, whose name the agent would
// otherwise have to guess.
function hereNames() {
  try {
    const g = load(), exact = liveNames(g), byFold = new Map();
    for (const e of g.entities) if (!byFold.has(fold(e.name))) byFold.set(fold(e.name), e.name);
    const home = os.homedir(), found = [];
    let dir = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    for (let i = 0; i < HERE_LEVELS && dir !== home && dir !== path.dirname(dir); i++, dir = path.dirname(dir)) {
      const base = path.basename(dir), name = exact.has(base) ? base : fold(base) && byFold.get(fold(base));
      if (name && label(name) && name.length <= 80 && !found.includes(name)) found.push(name);
    }
    return found.slice(0, 2);
  } catch { return []; }
}

// Told the target in the description, an agent still learns most from what a write answers.
const longNote = facts => {
  const n = facts.filter(o => o.length > OBS_TARGET_CHARS).length;
  return n ? ` (${n} over ${OBS_TARGET_CHARS} chars: aim shorter)` : "";
};

// ---------- formatting ----------
const relLine = r => `${r.from} -${r.relationType}-> ${r.to}`;

function formatEntity(e, live) {
  const archived = archivedOf(e.name, live).length;
  return `## ${e.name} [${e.entityType}]${archived ? ` (${archived} archived)` : ""}\n` + e.observations.map(o => `- ${o}`).join("\n");
}

function snippet(text, terms) {
  const low = text.toLowerCase();
  const at = Math.max(0, Math.min(...terms.map(t => low.indexOf(t)).filter(i => i >= 0)) - 50);
  const s = text.slice(at, at + 160);
  return (at > 0 ? "…" : "") + s + (at + 160 < text.length ? "…" : "");
}

// Rules and pending work, told by their type or by the name the protocol gives them.
const isPending = e => /pending/i.test(e.entityType) || /^PENDING\b/.test(e.name);
const isBinding = e => isPending(e) || /rule/i.test(e.entityType) || /^RULE\b/.test(e.name);

// ---------- health ----------
// Signs that the graph needs tidying, beyond the budget: what --lint and the web UI report.
function health(g) {
  const names = liveNames(g), found = [];
  const add = (what, items) => { if (items.length) found.push({ what, items }); };

  const pending = g.entities.filter(isPending);
  const blocking = new Set(g.relations.filter(r => r.relationType === "blocks").map(r => r.from));
  add("pending work that blocks nothing (finished? delete it)", pending.filter(e => !blocking.has(e.name)).map(e => e.name));
  const cutoff = new Date(Date.now() - PENDING_STALE_DAYS * 864e5).toISOString().slice(0, 10);
  const newest = e => e.observations.flatMap(o => o.match(/20\d\d-\d\d-\d\d/g) || []).sort().pop();
  add(`pending work with no dated fact in the last ${PENDING_STALE_DAYS} days`, pending.filter(e => newest(e) < cutoff).map(e => e.name));

  const linked = new Set(g.relations.flatMap(r => [r.from, r.to]));
  if (g.relations.length) add("entities with no relations (nothing leads to them)", g.entities.filter(e => !linked.has(e.name)).map(e => e.name));
  const alike = new Map();
  for (const n of names) alike.set(fold(n), [...(alike.get(fold(n)) || []), n]);
  add("names that differ only in case or separators (one thing twice?)", [...alike.values()].filter(v => v.length > 1).map(v => v.join(" ~ ")));
  add("entities stored more than once in the file", [...new Set(g.entities.map(e => e.name).filter((n, i, all) => all.indexOf(n) !== i))]);
  add("relations to an entity that does not exist", g.relations.filter(r => !names.has(r.from) || !names.has(r.to)).map(relLine));
  add("entities with an observation that is empty or spans several lines", g.entities.filter(e => e.observations.some(o => !o.trim() || /[\r\n]/.test(o))).map(e => e.name));

  const held = new Set(g.entities.map(e => fileKey(archiveFile(e.name))));
  let files = [];
  try { files = fs.readdirSync(ARCHIVE).filter(f => f.endsWith(".md")); } catch {}
  add("archive files of no current entity", files.filter(f => !held.has(fileKey(f)) && parseArchive(path.join(ARCHIVE, f)).some(s => !s.deleted && s.items.length)));
  return found;
}

// ---------- tools ----------
const READ_ONLY = { readOnlyHint: true };

const tools = {
  search_nodes: {
    description: `Find entities. Every term must appear in the name, type, an observation, or the type of a relation touching the entity (case-insensitive). Returns ranked names with matching snippets, at most 'limit' (default ${SEARCH_LIMIT}), then entities matching only in archived observations. open_nodes returns full entities.`,
    annotations: READ_ONLY,
    inputSchema: { type: "object", properties: {
      query: { type: "string" },
      limit: { type: "number", description: `Max results (default ${SEARCH_LIMIT}, max 50)` },
    }, required: ["query"] },
    run({ query, limit }) {
      const g = load();
      const terms = [...new Set(String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean))];
      if (!terms.length) return "Empty query.";
      const q = terms.join(" ");
      const relsOf = new Map();
      for (const r of g.relations) for (const n of new Set([r.from, r.to])) {
        if (!relsOf.has(n)) relsOf.set(n, []);
        relsOf.get(n).push(r);
      }
      const archived = archiveIndex(g);
      // The observations containing a term, those with the most terms first.
      const matching = observations => observations
        .map(o => ({ o, low: o.toLowerCase() })).map(x => ({ ...x, n: terms.filter(t => x.low.includes(t)).length }))
        .filter(x => x.n).sort((a, b) => b.n - a.n);
      // The facts to show for a match. A term the name or type already holds needs no fact to
      // prove it, so facts are ranked by the other terms: most of them first, then standing
      // (undated) facts, then the newest. A second fact is shown when it holds a term the
      // first lacks, and otherwise only for the top matches.
      const pick = (found, fixed, top) => {
        const open = terms.filter(t => !fixed.includes(t));
        const held = x => open.filter(t => x.low.includes(t)).length;
        const when = x => (x.o.match(DATE) || ["9999"])[0];
        const best = found.filter(x => !open.length || held(x))
          .sort((a, b) => held(b) - held(a) || b.n - a.n || when(b).localeCompare(when(a)));
        if (!best.length) return [];
        const more = best.find(x => open.some(t => x.low.includes(t) && !best[0].low.includes(t))) || (top && open.length ? best[1] : undefined);
        return more ? [best[0], more] : [best[0]];
      };
      const hits = [], old = [], partial = [], somewhere = new Set();
      const byScore = (a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name);
      for (const e of g.entities) {
        const name = e.name.toLowerCase(), type = e.entityType.toLowerCase();
        const rels = (relsOf.get(e.name) || []).filter(r => terms.some(t => r.relationType.toLowerCase().includes(t)));
        const fixed = [name, type, ...rels.map(r => r.relationType.toLowerCase())].join("\n");
        const covers = found => terms.every(t => fixed.includes(t) || found.some(x => x.low.includes(t)));
        // A term in the name counts even when the others are elsewhere, and one fact holding
        // every term counts for more than several facts holding one each.
        const score = found => Math.min(found.length, 5) + Math.min(rels.length, 3)
          + 10 * Math.min(found.filter(x => x.n === terms.length).length, 3)
          + 100 * terms.filter(t => name.includes(t)).length / terms.length
          + (name === q ? 1000 : 0) + (terms.every(t => type.includes(t)) ? 20 : 0);
        const obs = matching(e.observations), gone = matching(archived.get(e.name) || []);
        if (covers(obs)) hits.push({ e, obs, rels, gone, fixed, score: score(obs) });
        else if (gone.length && covers([...obs, ...gone])) old.push({ e, gone, fixed, score: score(gone) });
        else {
          const held = terms.filter(t => fixed.includes(t) || obs.some(x => x.low.includes(t)) || gone.some(x => x.low.includes(t)));
          for (const t of held) somewhere.add(t);
          if (held.length) partial.push({ e, held: held.length, score: score(obs) });
        }
      }
      if (!hits.length && !old.length) {
        // Nothing holds every term. Name the terms that are nowhere and the entities that
        // come closest, so the next query drops the right word instead of guessing.
        const best = partial.reduce((m, x) => Math.max(m, x.held), 0);
        const nowhere = terms.filter(t => !somewhere.has(t));
        const closest = partial.filter(x => x.held === best).sort(byScore);
        return `No entities match "${query}".`
          + (best && nowhere.length ? ` In no entity: ${nowhere.join(", ")}.` : "")
          + (best ? ` Closest (${best} of ${terms.length} terms): ${closest.slice(0, 5).map(x => x.e.name).join(", ")}${closest.length > 5 ? `, … ${closest.length - 5} more` : ""}.` : "");
      }
      hits.sort(byScore); old.sort(byScore);
      const n = Math.min(Math.max(1, Number(limit) || SEARCH_LIMIT), 50);
      let out = hits.length
        ? `${hits.length} match "${query}"` + (hits.length > n ? `, top ${n} shown (narrow the query or raise limit)` : "") + ". open_nodes for full entities.\n"
        : `No current facts match "${query}".\n`;
      let shown = 0;
      for (const [rank, { e, obs, rels, gone, fixed }] of hits.slice(0, n).entries()) {
        let block = `- ${e.name} [${e.entityType}] ${e.observations.length} obs, ${(relsOf.get(e.name) || []).length} rel${gone.length ? `, +${gone.length} archived` : ""}\n`;
        const lines = [...pick(obs, fixed, rank < TOP_HITS).map(x => snippet(x.o, terms)), ...rels.map(relLine)];
        for (const l of lines.slice(0, 2)) block += `    › ${l}\n`;
        if (out.length + block.length > SEARCH_MAX_CHARS) { out += `… output capped; ${hits.length - shown} more not shown.\n`; break; }
        out += block; shown++;
      }
      // Facts moved to the archive still answer a search, at a price that depends on how much
      // is already shown: a count, the names, or (when nothing current matches) a snippet each.
      if (old.length && hits.length > n) out += `${old.length} more match only in archived observations.\n`;
      else if (old.length && hits.length) {
        out += `Only in archived observations: ${old.slice(0, ARCHIVE_NAMES_SHOWN).map(x => `${x.e.name} (${x.gone.length})`).join(", ")}`
          + (old.length > ARCHIVE_NAMES_SHOWN ? `, … ${old.length - ARCHIVE_NAMES_SHOWN} more` : "") + ". archived_observations lists them.\n";
      } else if (old.length) {
        out += "Only in archived observations (archived_observations lists and restores them):\n";
        let listed = 0;
        for (const { e, gone, fixed } of old.slice(0, ARCHIVE_HITS_SHOWN)) {
          const block = `- ${e.name} [${e.entityType}] ${gone.length} archived\n    › ${snippet((pick(gone, fixed)[0] || gone[0]).o, terms)}\n`;
          if (out.length + block.length > SEARCH_MAX_CHARS) break;
          out += block; listed++;
        }
        if (old.length > listed) out += `… ${old.length - listed} more not shown.\n`;
      }
      return out.trimEnd();
    },
  },

  open_nodes: {
    description: "Return full entities by exact name, with every relation touching them. With related: true, related rules and pending work come first, each with its first fact.",
    annotations: READ_ONLY,
    inputSchema: { type: "object", properties: { names: { type: "array", items: { type: "string" } }, related: { type: "boolean" } }, required: ["names"] },
    run({ names, related }) {
      const g = load(), live = liveNames(g);
      // A name that is right but for its case or separators opens the one entity it can mean.
      const want = new Set(list(names, "names").map(n => {
        const twins = live.has(n) ? [] : nearNames(g, n).same;
        return twins.length === 1 ? twins[0] : n;
      }));
      const found = g.entities.filter(e => want.has(e.name));
      const got = new Set(found.map(e => e.name));
      const rels = g.relations.filter(r => got.has(r.from) || got.has(r.to));
      // With 'related', the relations to rules and pending work come first, and each of those
      // is introduced by its first fact: often all of it, which saves opening it. The other
      // neighbours stay a name; their first fact rarely bears on the task and a hub has dozens.
      const byName = new Map(related ? g.entities.map(e => [e.name, e]) : []), shown = new Set(got);
      const binds = r => [byName.get(r.from), byName.get(r.to)].some(e => e && !got.has(e.name) && isBinding(e));
      if (related) rels.sort((a, b) => binds(b) - binds(a));
      let tail = rels.length ? "\n\n## relations" : "";
      for (const r of rels) {
        tail += "\n" + relLine(r);
        for (const e of [byName.get(r.from), byName.get(r.to)]) {
          if (!e || shown.has(e.name) || !isBinding(e)) continue;
          shown.add(e.name);
          if (e.observations.length) tail += `\n    › ${clip(oneLine(e.observations[0]), OBS_MAX_CHARS)}` + (e.observations.length > 1 ? ` (+${e.observations.length - 1} more)` : "");
        }
      }
      for (const m of [...want].filter(n => !got.has(n))) {
        const near = nearNames(g, m).all;
        tail += `\n\nNot found: "${m}"` + (near.length ? `; did you mean: ${near.join(", ")}` : "");
      }
      // Over budget, whole entities are left out (and named) rather than cutting the relations off the end.
      const blocks = [], left = [];
      let used = tail.length;
      for (const e of found) {
        const block = formatEntity(e, live);
        if (blocks.length && used + block.length > OPEN_MAX_CHARS) { left.push(e.name); continue; }
        blocks.push(block); used += block.length + 2;
      }
      let out = blocks.join("\n\n") + tail;
      if (left.length) out += `\n\n… over ${OPEN_MAX_CHARS} chars; not shown, open separately: ${left.join(", ")}`;
      return out.trim() || "Nothing found.";
    },
  },

  read_graph: {
    description: "Index of the graph: entity names grouped by type, with observation counts. Does not return observations; use open_nodes for those. Large types come as a count unless entityType names one.",
    annotations: READ_ONLY,
    inputSchema: { type: "object", properties: { entityType: { type: "string", description: "Only this type" } } },
    run({ entityType } = {}) {
      const g = load();
      const byType = {};
      for (const e of g.entities) if (!entityType || e.entityType === entityType) (byType[e.entityType] ||= []).push(`${e.name} (${e.observations.length})`);
      const types = Object.keys(byType).sort().map(t => ({ t, names: byType[t].sort(), text: `${t}: ${byType[t].join("; ")}` }));
      // The index has a budget too: past it, the types with the longest lists become a count.
      const counted = new Set();
      let used = 0;
      if (!entityType) for (const x of [...types].sort((a, b) => a.text.length - b.text.length)) {
        if (used + x.text.length > READ_MAX_CHARS) counted.add(x.t); else used += x.text.length;
      }
      const body = types.map(x => {
        if (counted.has(x.t)) return `${x.t}: ${x.names.length} entities`;
        if (x.text.length <= OPEN_MAX_CHARS) return x.text;
        let line = `${x.t}: `, shown = 0;
        for (const n of x.names) {
          if (line.length + n.length + 2 > OPEN_MAX_CHARS) break;
          line += (shown++ ? "; " : "") + n;
        }
        return `${line}; … ${x.names.length - shown} more not shown, search_nodes finds them`;
      }).join("\n");
      return `${g.entities.length} entities, ${g.relations.length} relations.\n${body}`
        + (entityType && !types.length ? `No entities of type "${entityType}".` : "")
        + (counted.size ? `\nNames of the largest type(s) are left out to keep this short: pass entityType to list one.` : "")
        + (g.unreadable.length ? `\n${g.unreadable.length} unreadable line(s) in the graph file are ignored; the next write moves them to ${path.basename(UNREADABLE)}.` : "");
    },
  },

  create_entities: {
    description: `Create entities; existing names are skipped. Each observation is one fact on one line: aim for under ${OBS_TARGET_CHARS} characters, over ${OBS_MAX_CHARS} is rejected.`,
    inputSchema: { type: "object", properties: { entities: { type: "array", items: { type: "object", properties: {
      name: { type: "string" }, entityType: { type: "string" }, observations: { type: "array", items: { type: "string" } },
    }, required: ["name", "entityType", "observations"] } } }, required: ["entities"] },
    run({ entities }) {
      const invalid = list(entities, "entities").flatMap((e, i) => str(e?.name) && str(e?.entityType) ? [] : [`#${i + 1}${str(e?.name) ? ` (${e.name})` : ""}`]);
      if (invalid.length) throw new Error(`Rejected, every entity needs a non-empty name and entityType: ${invalid.join(", ")}`);
      const odd = entities.flatMap(e => [e.name, e.entityType]).filter(v => !label(v));
      if (odd.length) throw new Error(`Rejected, a name or type must be one line with no space at either end: ${odd.map(v => JSON.stringify(v)).join(", ")}`);
      rejectObservations(entities.flatMap(e => badObservations(e.name, list(e.observations ?? [], "observations"))));
      return mutate(g => {
        const have = new Set(g.entities.map(e => e.name));
        const alike = new Map(g.entities.map(e => [fold(e.name), e.name]));
        const made = [], skipped = [], similar = [];
        for (const e of entities) {
          if (have.has(e.name)) { skipped.push(e.name); continue; }
          if (alike.has(fold(e.name))) similar.push(`${e.name} ~ ${alike.get(fold(e.name))}`);
          else alike.set(fold(e.name), e.name);
          const ent = { name: e.name, entityType: e.entityType, observations: [...new Set(e.observations || [])] };
          const moved = enforceCap(ent);
          g.entities.push(ent); have.add(e.name); made.push(e.name + (moved ? ` (${moved} archived, over cap)` : ""));
        }
        return `Created: ${made.join(", ") || "none"}`
          + (skipped.length ? `\nAlready existed (use add_observations): ${skipped.join(", ")}` : "")
          + (similar.length ? `\nA similar name already exists (if it is the same thing, delete the new entity and use the old): ${similar.join("; ")}` : "");
      });
    },
  },

  create_relations: {
    description: "Create relations (active voice, e.g. depends_on, blocks, applies_to); duplicates are skipped.",
    inputSchema: { type: "object", properties: { relations: { type: "array", items: { type: "object", properties: {
      from: { type: "string" }, to: { type: "string" }, relationType: { type: "string" },
    }, required: ["from", "to", "relationType"] } } }, required: ["relations"] },
    run({ relations }) {
      if (!list(relations, "relations").every(r => str(r?.from) && str(r?.to) && label(r?.relationType))) throw new Error("Rejected, every relation needs a non-empty from, to and relationType (one line, no space at either end).");
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
    description: `Add observations to existing entities. One fact each, on one line: aim for under ${OBS_TARGET_CHARS} characters, over ${OBS_MAX_CHARS} is rejected. Replace a stale fact with replace_observation rather than appending a correction. Entities over ${OBS_MAX_PER_ENTITY} observations have their oldest dated ones moved to archive/.`,
    inputSchema: { type: "object", properties: { observations: { type: "array", items: { type: "object", properties: {
      entityName: { type: "string" }, contents: { type: "array", items: { type: "string" } },
    }, required: ["entityName", "contents"] } } }, required: ["observations"] },
    run({ observations }) {
      rejectObservations(list(observations, "observations").flatMap(x => badObservations(x?.entityName, list(x?.contents, "contents"))));
      return mutate(g => {
        const missing = observations.map(x => x.entityName).filter(n => !g.entities.some(e => e.name === n));
        if (missing.length) throw notFound(g, [...new Set(missing)]);
        const out = [];
        for (const x of observations) {
          const e = g.entities.find(e => e.name === x.entityName);
          const fresh = [...new Set(x.contents)].filter(o => !e.observations.includes(o));
          e.observations.push(...fresh);
          const moved = enforceCap(e);
          out.push(`${e.name}: +${fresh.length}` + (moved ? `, ${moved} oldest archived (cap ${OBS_MAX_PER_ENTITY})` : "") + `, now ${e.observations.length}`
            + (e.observations.length > OBS_MAX_PER_ENTITY ? ` (over cap ${OBS_MAX_PER_ENTITY}: undated facts are never archived, delete stale ones)` : "")
            + longNote(fresh));
        }
        return out.join("\n");
      });
    },
  },

  replace_observation: {
    description: `Replace one observation of an entity in place. 'old' is its exact text, or a part of it (${PART_MIN_CHARS}+ characters) found in no other observation of the entity.`,
    inputSchema: { type: "object", properties: {
      entityName: { type: "string" }, old: { type: "string" }, text: { type: "string", description: "The new observation" },
    }, required: ["entityName", "old", "text"] },
    run({ entityName, old, text }) {
      if (!str(entityName) || !str(old)) throw new Error("Rejected, entityName, old and text are required.");
      rejectObservations(badObservations(entityName, [text]));
      return mutate(g => {
        const e = g.entities.find(e => e.name === entityName);
        if (!e) throw notFound(g, [entityName]);
        const i = findObservation(e, old);
        if (i === -2) throw new Error(`More than one observation of ${entityName} contains that text; give more of it.`);
        if (i < 0) throw new Error(`No observation of ${entityName} has that text; it may have changed in the meantime.`);
        const was = e.observations[i];
        if (text !== was && e.observations.includes(text)) throw new Error("The entity already has that observation.");
        e.observations[i] = text;
        return `${entityName}: observation updated` + (was === old ? "" : ` (was: "${clip(was)}")`) + longNote([text]);
      });
    },
  },

  archived_observations: {
    description: "List the observations of an entity that were moved to archive/, oldest first. Pass 'restore' with exact texts to move them back onto the entity.",
    inputSchema: { type: "object", properties: {
      entityName: { type: "string" },
      query: { type: "string", description: "Only archived observations containing every term" },
      restore: { type: "array", items: { type: "string" } },
    }, required: ["entityName"] },
    run({ entityName, query, restore }) {
      if (!str(entityName)) throw new Error("Rejected, entityName must be a non-empty string.");
      if (restore === undefined) {
        const terms = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const all = archivedOf(entityName, liveNames(load()));
        const items = all.filter(o => terms.every(t => o.toLowerCase().includes(t)));
        if (!items.length) return all.length ? `None of the ${all.length} archived observation(s) of "${entityName}" match "${query}".` : `Nothing archived for "${entityName}".`;
        // Over budget, the oldest are left out: the newest are the likeliest to be wanted back.
        let shown = items.length, size = 0;
        while (shown > 0 && size + items[shown - 1].length + 3 <= SEARCH_MAX_CHARS) size += items[--shown].length + 3;
        return `${items.length} archived for ${entityName}` + (shown ? `, ${shown} oldest not shown (add a query)` : "") + ":\n" + items.slice(shown).map(o => `- ${o}`).join("\n");
      }
      const want = new Set(list(restore, "restore")), file = archiveFile(entityName);
      let sections;
      return mutate(g => {
        const e = g.entities.find(e => e.name === entityName);
        if (!e) throw notFound(g, [entityName]);
        const live = liveNames(g);
        sections = parseArchive(file);
        const found = new Set();
        for (const s of sections) if (owns(s, entityName, live)) s.items = s.items.filter(o => !want.has(o) || !found.add(o));
        if (!found.size) throw new Error(`None of those are in the archive of "${entityName}" (the text must match exactly).`);
        e.observations.push(...[...found].filter(o => !e.observations.includes(o)));
        return `${e.name}: restored ${found.size}, now ${e.observations.length}`
          + (want.size > found.size ? ` (${want.size - found.size} not matched exactly)` : "")
          + (e.observations.length > OBS_MAX_PER_ENTITY ? ` (over cap ${OBS_MAX_PER_ENTITY}: the next add_observations archives the oldest dated ones again, so delete stale facts first)` : "");
      }, () => writeArchive(file, sections));
    },
  },

  rename_entity: {
    description: "Rename an entity, keeping its observations and every relation touching it. Fails if the new name is taken.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "Current name" }, newName: { type: "string" },
    }, required: ["name", "newName"] },
    run({ name, newName }) {
      if (!str(name) || !str(newName)) throw new Error("Rejected, name and newName must be non-empty strings.");
      if (!label(newName)) throw new Error("Rejected, newName must be one line with no space at either end.");
      if (name === newName) return "Nothing to rename.";
      let live;
      return mutate(g => {
        const e = g.entities.find(e => e.name === name);
        if (!e) throw notFound(g, [name]);
        if (g.entities.some(e => e.name === newName)) throw new Error(`An entity named "${newName}" already exists.`);
        live = liveNames(g);
        e.name = newName;
        let rels = 0;
        for (const r of g.relations) {
          if (r.from === name) { r.from = newName; rels++; }
          if (r.to === name) { r.to = newName; rels++; }
        }
        return `Renamed ${name} -> ${newName}; ${rels} relation end(s) updated.`;
      }, () => moveArchive(name, newName, live));
    },
  },

  delete_entities: {
    description: "Delete entities and every relation touching them.",
    inputSchema: { type: "object", properties: { entityNames: { type: "array", items: { type: "string" } } }, required: ["entityNames"] },
    run({ entityNames }) {
      const del = new Set(list(entityNames, "entityNames"));
      let live;
      return mutate(g => {
        live = liveNames(g);
        const before = [g.entities.length, g.relations.length];
        g.entities = g.entities.filter(e => !del.has(e.name));
        g.relations = g.relations.filter(r => !del.has(r.from) && !del.has(r.to));
        return `Deleted ${before[0] - g.entities.length} entities, ${before[1] - g.relations.length} relations.`;
      }, () => retireArchive([...del].filter(n => live.has(n)), live));
    },
  },

  delete_observations: {
    description: `Delete observations from entities, each named by its exact text or by a part of it (${PART_MIN_CHARS}+ characters) found in no other observation of the entity.`,
    inputSchema: { type: "object", properties: { deletions: { type: "array", items: { type: "object", properties: {
      entityName: { type: "string" }, observations: { type: "array", items: { type: "string" } },
    }, required: ["entityName", "observations"] } } }, required: ["deletions"] },
    run({ deletions }) {
      for (const d of list(deletions, "deletions")) list(d?.observations, "observations");
      return mutate(g => deletions.map(d => {
        const e = g.entities.find(e => e.name === d.entityName);
        if (!e) return `${d.entityName}: not found`;
        const drop = new Set(), byPart = [];
        let missed = 0, vague = 0;
        for (const text of d.observations) {
          const i = findObservation(e, text);
          if (i === -2) vague++;
          else if (i < 0) missed++;
          else {
            if (e.observations[i] !== text && !drop.has(e.observations[i])) byPart.push(`"${clip(e.observations[i])}"`);
            drop.add(e.observations[i]);
          }
        }
        const n = e.observations.length;
        e.observations = e.observations.filter(o => !drop.has(o));
        return `${e.name}: -${n - e.observations.length}`
          + (byPart.length ? ` (found by part: ${byPart.join(", ")})` : "")
          + (missed ? ` (${missed} not matched)` : "")
          + (vague ? ` (${vague} in more than one observation, give more of the text)` : "");
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
// The protocol revisions this server speaks, newest first. A client asking for another one
// is answered with the newest, as the specification requires, and decides whether to go on.
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const send = msg => process.stdout.write(JSON.stringify(msg) + "\n");

function hereNote() {
  const here = hereNames().map(n => `"${n}"`);
  return here.length ? ` The working directory matches the ${here.length > 1 ? "entities" : "entity"} ${here.join(" and ")}: open ${here.length > 1 ? "them" : "it"} first.` : "";
}

function handle(msg) {
  if (!msg || typeof msg !== "object") return send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  switch (method) {
    case "initialize":
      return send({ jsonrpc: "2.0", id, result: {
        protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "memory-lean", version: VERSION },
        ...(INSTRUCTIONS && { instructions: INSTRUCTIONS + hereNote() }),
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
// --lint reports what is over budget or needs tidying; --compact applies the cap to every entity.
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
    const tidy = health(g);
    if (tidy.length) console.log("\nWorth a look (nothing here is changed for you):");
    for (const { what, items } of tidy) console.log(`${String(items.length).padStart(4)}  ${what}: ${items.slice(0, 8).join("; ")}${items.length > 8 ? `; … ${items.length - 8} more` : ""}`);
    if (tidy.length) console.log("");
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

// ---------- web UI ----------
// --ui serves server/ui.html on 127.0.0.1. Changes go through the same tools MCP clients use, plus
// one edit the tools lack, so the lock, limits and cap all apply. Only this machine can connect,
// the Host header must be the loopback address (no DNS rebinding), and every API call needs the
// token from the printed link in a custom header, which other websites cannot send.
const UI_DEFAULT_PORT = 6366;
const UI_TOOLS = new Set(["create_entities", "create_relations", "add_observations", "replace_observation", "archived_observations",
  "rename_entity", "delete_entities", "delete_observations", "delete_relations"]);

const uiEdits = {
  set_type({ name, entityType }) {
    if (!str(name) || !label(entityType)) throw new Error("Rejected, name and entityType must be non-empty, and the type one line with no space at either end.");
    return mutate(g => {
      const e = g.entities.find(e => e.name === name);
      if (!e) throw notFound(g, [name]);
      const was = e.entityType;
      e.entityType = entityType;
      return `${name}: type ${was} -> ${entityType}`;
    });
  },
};

const uiStamp = () => { try { const s = fs.statSync(FILE); return `${s.mtimeMs}:${s.size}`; } catch { return "none"; } };

function uiSnapshot() {
  const g = load(), archived = archiveIndex(g);
  return {
    file: FILE, version: VERSION, stamp: uiStamp(), unreadable: g.unreadable.length,
    limits: { obsMaxChars: OBS_MAX_CHARS, obsMax: OBS_MAX_PER_ENTITY },
    entities: g.entities.map(e => ({ ...e, archived: archived.get(e.name)?.length || 0 })),
    relations: g.relations,
    health: health(g),
  };
}

function startUi(fixedPort, openBrowser) {
  const page = fs.readFileSync(new URL("ui.html", import.meta.url), "utf8");
  const token = crypto.randomBytes(24).toString("base64url");
  const server = http.createServer((req, res) => {
    const reply = (status, body, type = "application/json; charset=utf-8") => {
      res.writeHead(status, {
        "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
        ...(type.startsWith("text/html") && { "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" }),
      });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const port = server.address().port;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return reply(403, { ok: false, text: "Forbidden host." });
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/") return reply(200, page, "text/html; charset=utf-8");
    if (!url.pathname.startsWith("/api/")) return reply(404, { ok: false, text: "Not found." });
    if (req.headers["x-memory-lean-token"] !== token) return reply(401, { ok: false, text: "Missing or wrong token: open the link printed by memory-lean --ui." });
    try {
      if (req.method === "GET" && url.pathname === "/api/graph") return reply(200, uiSnapshot());
      if (req.method === "GET" && url.pathname === "/api/stamp") return reply(200, { stamp: uiStamp() });
      if (req.method === "GET" && url.pathname === "/api/archive") return reply(200, { items: archivedOf(url.searchParams.get("name") || "", liveNames(load())) });
      if (req.method !== "POST" || url.pathname !== "/api/call") return reply(404, { ok: false, text: "Not found." });
    } catch (e) { return reply(500, { ok: false, text: String(e.message || e) }); }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      let call;
      try { call = JSON.parse(body); } catch { return reply(400, { ok: false, text: "Bad JSON." }); }
      const run = UI_TOOLS.has(call?.tool) ? tools[call.tool].run : Object.hasOwn(uiEdits, call?.tool) ? uiEdits[call.tool] : null;
      if (!run) return reply(400, { ok: false, text: `Unknown tool: ${call?.tool}` });
      try { reply(200, { ok: true, text: run(call.args || {}) }); } catch (e) { reply(400, { ok: false, text: String(e.message || e) }); }
    });
  });
  server.on("listening", () => {
    const link = `http://127.0.0.1:${server.address().port}/#${token}`;
    console.log(`memory-lean ${VERSION}: ${FILE}\n${link}\nCtrl+C to stop.`);
    if (!openBrowser) return;
    const [cmd, args] = process.platform === "darwin" ? ["open", [link]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", link]] : ["xdg-open", [link]];
    try { spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch {}
  });
  server.on("error", e => {
    if (e.code === "EADDRINUSE" && fixedPort === undefined) return server.listen(0, "127.0.0.1");
    console.error(`memory-lean --ui: ${e.message}`);
    process.exitCode = 1;
  });
  server.listen(fixedPort ?? UI_DEFAULT_PORT, "127.0.0.1");
}

const arg = process.argv[2];
if (!arg) serve();
else if (arg === "--lint") lint(false);
else if (arg === "--compact") lint(true);
else if (arg === "--protocol") process.stdout.write(protocolText() || "");
else if (arg === "--skill") writeSkill(process.argv[3]);
else if (arg === "--ui" && process.argv.includes("--demo")) {
  // A throwaway copy of the made-up example graph, so trying the UI never touches real memory.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-lean-demo-"));
  fs.copyFileSync(new URL("../examples/demo-memory.jsonl", import.meta.url), path.join(dir, "memory.jsonl"));
  const args = process.argv.slice(2).filter(a => a !== "--demo");
  spawn(process.execPath, [process.argv[1], ...args], { stdio: "inherit", env: { ...process.env, MEMORY_FILE_PATH: path.join(dir, "memory.jsonl") } })
    .on("exit", code => { process.exitCode = code ?? 0; });
}
else if (arg === "--ui") {
  const rest = process.argv.slice(3), port = rest.find(a => /^\d+$/.test(a));
  startUi(port === undefined ? undefined : Number(port), !rest.includes("--no-open"));
}
else if (arg === "--version" || arg === "-v") console.log(VERSION);
else {
  console.log("memory-lean [--ui [port] [--demo] | --lint | --compact | --protocol | --skill <dir> | --version]\nWith no arguments, serves MCP over stdio. See README.md.");
  process.exitCode = arg === "--help" || arg === "-h" ? 0 : 2;
}
