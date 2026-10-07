// Drives the server over stdio exactly as an MCP client would.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "memory-lean.mjs");

function session(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-lean-"));
  const file = path.join(dir, "memory.jsonl");
  const rpc = (messages) => {
    const input = messages.map((m, i) => JSON.stringify({ jsonrpc: "2.0", id: i + 1, ...m })).join("\n") + "\n";
    const out = spawnSync("node", [SERVER], { input, env: { ...process.env, MEMORY_FILE_PATH: file, ...env } });
    return out.stdout.toString().trim().split("\n").map((l) => JSON.parse(l));
  };
  const call = (name, args = {}) => {
    const [res] = rpc([{ method: "tools/call", params: { name, arguments: args } }]);
    return { text: res.result.content[0].text, isError: !!res.result.isError };
  };
  return { dir, file, rpc, call };
}

test("speaks MCP: initialize and tools/list", () => {
  const s = session();
  const [init, list] = s.rpc([{ method: "initialize", params: {} }, { method: "tools/list" }]);
  assert.equal(init.result.serverInfo.name, "memory-lean");
  assert.deepEqual(
    list.result.tools.map((t) => t.name).sort(),
    ["add_observations", "create_entities", "create_relations", "delete_entities", "delete_observations", "delete_relations", "open_nodes", "read_graph", "search_nodes"],
  );
});

test("create, relate, open and search", () => {
  const s = session();
  s.call("create_entities", { entities: [
    { name: "api", entityType: "service", observations: ["NestJS backend", "2026-01-02: deployed v1.4.0"] },
    { name: "app", entityType: "mobile_app", observations: ["Flutter app"] },
  ] });
  assert.match(s.call("create_relations", { relations: [{ from: "app", to: "api", relationType: "talks_to" }] }).text, /Created 1 relation/);
  const opened = s.call("open_nodes", { names: ["api"] }).text;
  assert.match(opened, /## api \[service\]/);
  assert.match(opened, /app -talks_to-> api/);
  // search returns names + snippets, not whole entities
  const found = s.call("search_nodes", { query: "deployed" }).text;
  assert.match(found, /- api \[service\] 2 obs, 1 rel/);
  assert.doesNotMatch(found, /NestJS backend/);
  // every term must match
  assert.match(s.call("search_nodes", { query: "deployed flutter" }).text, /No entities match/);
  // unknown names come back with suggestions
  assert.match(s.call("open_nodes", { names: ["ap"] }).text, /did you mean: api, app/);
});

test("read_graph is an index, not the graph", () => {
  const s = session();
  s.call("create_entities", { entities: [{ name: "api", entityType: "service", observations: ["a secret-looking detail"] }] });
  const index = s.call("read_graph").text;
  assert.match(index, /1 entities, 0 relations/);
  assert.match(index, /service: api \(1\)/);
  assert.doesNotMatch(index, /secret-looking/);
});

test("rejects observations over the length limit", () => {
  const s = session();
  s.call("create_entities", { entities: [{ name: "api", entityType: "service", observations: [] }] });
  const res = s.call("add_observations", { observations: [{ entityName: "api", contents: ["x".repeat(301)] }] });
  assert.equal(res.isError, true);
  assert.match(res.text, /over 300 chars/);
  assert.match(s.call("open_nodes", { names: ["api"] }).text, /^## api \[service\]\n?$/);
});

test("over the cap, the oldest dated observations move to archive/ and undated ones stay", () => {
  const s = session({ MEMORY_OBS_MAX: "3" });
  s.call("create_entities", { entities: [{ name: "api", entityType: "service", observations: ["identity: the public API"] }] });
  const res = s.call("add_observations", { observations: [{ entityName: "api", contents: [
    "2026-01-01: first", "2026-01-02: second", "2026-01-03: third",
  ] }] });
  assert.match(res.text, /1 oldest archived \(cap 3\), now 3/);
  const opened = s.call("open_nodes", { names: ["api"] }).text;
  assert.match(opened, /identity: the public API/);
  assert.doesNotMatch(opened, /2026-01-01: first/);
  assert.match(fs.readFileSync(path.join(s.dir, "archive", "api.md"), "utf8"), /2026-01-01: first/);
});

test("delete observations, relations and entities", () => {
  const s = session();
  s.call("create_entities", { entities: [
    { name: "a", entityType: "t", observations: ["one", "two"] },
    { name: "b", entityType: "t", observations: [] },
  ] });
  s.call("create_relations", { relations: [{ from: "a", to: "b", relationType: "depends_on" }] });
  assert.match(s.call("delete_observations", { deletions: [{ entityName: "a", observations: ["one", "missing"] }] }).text, /a: -1 \(1 not matched exactly\)/);
  assert.match(s.call("delete_entities", { entityNames: ["b"] }).text, /Deleted 1 entities, 1 relations/);
  assert.match(s.call("read_graph").text, /1 entities, 0 relations/);
});

test("keeps the reference server's file format and takes a daily backup", () => {
  const s = session();
  s.call("create_entities", { entities: [{ name: "a", entityType: "t", observations: ["one"] }] });
  s.call("add_observations", { observations: [{ entityName: "a", contents: ["two"] }] });
  const rows = fs.readFileSync(s.file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows, [{ type: "entity", name: "a", entityType: "t", observations: ["one", "two"] }]);
  assert.equal(fs.readdirSync(path.join(s.dir, "backups")).length, 1);
});
