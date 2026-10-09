#!/usr/bin/env node
// Measures how much smaller memory-lean's answers are than the reference server's,
// on your own graph. Read-only; prints sizes, never graph content.
//
//   node tools/bench.mjs                  read_graph + your five most common words
//   node tools/bench.mjs deploy "api v2"  read_graph + these queries
//
// The reference server's answers are recomputed from the file the way
// @modelcontextprotocol/server-memory builds them (pretty-printed JSON of the whole
// graph, or of every entity containing the query plus the relations between them).
// Tokens are estimated as characters / 4.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = process.env.MEMORY_FILE_PATH || path.join(os.homedir(), ".claude", "memory-graph", "memory.jsonl");
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "memory-lean.mjs");

const rows = fs.readFileSync(FILE, "utf8").split("\n").filter(l => l.trim()).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
const entities = rows.filter(r => r.type === "entity").map(({ name, entityType, observations = [] }) => ({ name, entityType, observations }));
const relations = rows.filter(r => r.type === "relation").map(({ from, to, relationType }) => ({ from, to, relationType }));

const reference = query => {
  if (query === undefined) return JSON.stringify({ entities, relations }, null, 2);
  const q = query.toLowerCase();
  const found = entities.filter(e => e.name.toLowerCase().includes(q) || String(e.entityType).toLowerCase().includes(q) || e.observations.some(o => o.toLowerCase().includes(q)));
  const names = new Set(found.map(e => e.name));
  return JSON.stringify({ entities: found, relations: relations.filter(r => names.has(r.from) && names.has(r.to)) }, null, 2);
};

function lean(calls) {
  const input = calls.map((c, i) => JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/call", params: c })).join("\n") + "\n";
  const out = spawnSync("node", [SERVER], { input, env: { ...process.env, MEMORY_FILE_PATH: FILE } });
  return out.stdout.toString().trim().split("\n").map(l => JSON.parse(l).result.content[0].text);
}

function commonWords(n) {
  const count = new Map();
  for (const e of entities) for (const w of new Set(e.observations.join(" ").toLowerCase().match(/[a-z]{5,}/g) || [])) count.set(w, (count.get(w) || 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

const queries = process.argv.slice(2).length ? process.argv.slice(2) : commonWords(5);
const answers = lean([{ name: "read_graph", arguments: {} }, ...queries.map(query => ({ name: "search_nodes", arguments: { query } }))]);
const tokens = text => Math.round(text.length / 4);
const line = (label, ref, mine) => console.log(`${label.padEnd(28)} ${String(tokens(ref)).padStart(9)} ${String(tokens(mine)).padStart(12)} ${(ref.length / mine.length).toFixed(1).padStart(7)}x`);

console.log(`${entities.length} entities, ${relations.length} relations, ${entities.reduce((n, e) => n + e.observations.length, 0)} observations\n`);
console.log(`${"call".padEnd(28)} ${"reference".padStart(9)} ${"memory-lean".padStart(12)} ${"smaller".padStart(8)}   (tokens)`);
line("read_graph", reference(), answers[0]);
queries.forEach((q, i) => line(`search_nodes "${q}"`, reference(q), answers[i + 1]));
