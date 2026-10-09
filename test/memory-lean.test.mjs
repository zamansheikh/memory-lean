// Drives the server over stdio exactly as an MCP client would.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "server", "memory-lean.mjs");
const callMessage = (name, args, id = 1) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n";

function session(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-lean-"));
  const file = path.join(dir, "memory.jsonl");
  const fullEnv = { ...process.env, MEMORY_FILE_PATH: file, ...env };
  const rpc = (messages) => {
    const input = messages.map((m, i) => JSON.stringify({ jsonrpc: "2.0", id: i + 1, ...m })).join("\n") + "\n";
    const out = spawnSync("node", [SERVER], { input, env: fullEnv });
    return out.stdout.toString().trim().split("\n").map((l) => JSON.parse(l));
  };
  const call = (name, args = {}) => {
    const [res] = rpc([{ method: "tools/call", params: { name, arguments: args } }]);
    return { text: res.result.content[0].text, isError: !!res.result.isError };
  };
  const cli = (...args) => spawnSync("node", [SERVER, ...args], { env: fullEnv }).stdout.toString();
  const rows = () => fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { dir, file, env: fullEnv, rpc, call, cli, rows };
}

test("speaks MCP: initialize and tools/list", () => {
  const s = session();
  const [init, list] = s.rpc([{ method: "initialize", params: {} }, { method: "tools/list" }]);
  assert.equal(init.result.serverInfo.name, "memory-lean");
  assert.equal(init.result.serverInfo.version, JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version);
  assert.deepEqual(
    list.result.tools.map((t) => t.name).sort(),
    ["add_observations", "create_entities", "create_relations", "delete_entities", "delete_observations", "delete_relations", "open_nodes", "read_graph", "rename_entity", "search_nodes"],
  );
  // only the three read tools are marked read-only
  assert.deepEqual(
    list.result.tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort(),
    ["open_nodes", "read_graph", "search_nodes"],
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

test("search matches relation types and caps the result list", () => {
  const s = session();
  s.call("create_entities", { entities: [
    { name: "PENDING api 2.0", entityType: "pending", observations: [] },
    ...[1, 2, 3, 4].map((i) => ({ name: `svc${i}`, entityType: "service", observations: ["2026-01-01: deployed"] })),
  ] });
  s.call("create_relations", { relations: [{ from: "PENDING api 2.0", to: "svc1", relationType: "blocks" }] });
  const blocked = s.call("search_nodes", { query: "blocks" }).text;
  assert.match(blocked, /^2 match/);
  assert.match(blocked, /› PENDING api 2\.0 -blocks-> svc1/);
  const capped = s.call("search_nodes", { query: "deployed", limit: 2 }).text;
  assert.match(capped, /4 match "deployed", top 2 shown/);
  assert.equal(capped.split("\n").filter((l) => l.startsWith("- ")).length, 2);
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

test("rejects malformed writes with a readable error and stores nothing", () => {
  const s = session();
  const noType = s.call("create_entities", { entities: [{ name: "x", observations: ["hello"] }] });
  assert.equal(noType.isError, true);
  assert.match(noType.text, /non-empty name and entityType: #1 \(x\)/);
  assert.equal(fs.existsSync(s.file), false);
  assert.match(s.call("create_entities", {}).text, /"entities" must be an array/);
  assert.match(s.call("open_nodes", { names: "api" }).text, /"names" must be an array/);
  assert.match(s.call("add_observations", { observations: [{ entityName: "x", contents: [42] }] }).text, /not a string/);
  assert.match(s.call("create_relations", { relations: [{ from: "x", to: "y" }] }).text, /non-empty from, to and relationType/);
});

test("an entity without a type in the file does not break search", () => {
  const s = session();
  fs.writeFileSync(s.file, JSON.stringify({ type: "entity", name: "x", observations: ["hello"] }) + "\n");
  assert.match(s.call("search_nodes", { query: "hello" }).text, /- x \[unknown\] 1 obs/);
});

test("unreadable lines are set aside on the next write, not deleted", () => {
  const s = session();
  const broken = '{"type":"entity","name":"b","entityType":"t","observations":["tw';
  fs.writeFileSync(s.file, JSON.stringify({ type: "entity", name: "a", entityType: "t", observations: ["one"] }) + "\n" + broken + "\n");
  assert.match(s.call("read_graph").text, /1 unreadable line/);
  const res = s.call("add_observations", { observations: [{ entityName: "a", contents: ["two"] }] });
  assert.match(res.text, /Warning: 1 unreadable line\(s\).*memory\.jsonl\.unreadable/);
  assert.equal(fs.readFileSync(s.file + ".unreadable", "utf8"), broken + "\n");
  assert.deepEqual(s.rows(), [{ type: "entity", name: "a", entityType: "t", observations: ["one", "two"] }]);
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

test("undated observations are never archived, even over the cap", () => {
  const s = session({ MEMORY_OBS_MAX: "2" });
  s.call("create_entities", { entities: [{ name: "a", entityType: "t", observations: ["id one", "id two", "id three"] }] });
  assert.deepEqual(s.rows()[0].observations, ["id one", "id two", "id three"]);
  assert.equal(fs.existsSync(path.join(s.dir, "archive")), false);
  const res = s.call("add_observations", { observations: [{ entityName: "a", contents: ["2026-01-01: dated"] }] });
  assert.match(res.text, /1 oldest archived \(cap 2\), now 3 \(over cap 2: undated facts are never archived/);
  assert.deepEqual(s.rows()[0].observations, ["id one", "id two", "id three"]);
});

test("entities with non-ASCII names get their own archive files", () => {
  const s = session({ MEMORY_OBS_MAX: "1" });
  const observations = ["2026-01-01: a", "2026-01-02: b"];
  s.call("create_entities", { entities: [
    { name: "প্রকল্প", entityType: "t", observations },
    { name: "日本 語", entityType: "t", observations },
  ] });
  assert.deepEqual(fs.readdirSync(path.join(s.dir, "archive")).map((f) => f.normalize("NFC")).sort(), ["প্রকল্প.md", "日本_語.md"].map((f) => f.normalize("NFC")).sort());
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
  assert.deepEqual(s.rows(), [{ type: "entity", name: "a", entityType: "t", observations: ["one", "two"] }]);
  assert.equal(fs.readdirSync(path.join(s.dir, "backups")).length, 1);
});

test("keeps only the newest daily backups", () => {
  const s = session({ MEMORY_BACKUPS_KEPT: "3" });
  s.call("create_entities", { entities: [{ name: "a", entityType: "t", observations: [] }] });
  const backups = path.join(s.dir, "backups");
  fs.mkdirSync(backups);
  for (const day of ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04"]) fs.writeFileSync(path.join(backups, `memory-${day}.jsonl`), "");
  fs.writeFileSync(path.join(backups, "keep-me.txt"), "");
  s.call("add_observations", { observations: [{ entityName: "a", contents: ["one"] }] });
  const left = fs.readdirSync(backups).sort();
  assert.equal(left.length, 4);
  assert.deepEqual(left.slice(0, 3), ["keep-me.txt", "memory-2020-01-03.jsonl", "memory-2020-01-04.jsonl"]);
});

test("concurrent writers do not lose each other's updates", async () => {
  const s = session({ MEMORY_OBS_MAX: "100" });
  s.call("create_entities", { entities: [{ name: "a", entityType: "t", observations: [] }] });
  const writers = Array.from({ length: 12 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn("node", [SERVER], { env: s.env, stdio: ["pipe", "ignore", "inherit"] });
    child.on("error", reject).on("close", resolve);
    child.stdin.end(callMessage("add_observations", { observations: [{ entityName: "a", contents: [`fact ${i}`] }] }));
  }));
  await Promise.all(writers);
  assert.equal(s.rows()[0].observations.length, 12);
  assert.equal(fs.existsSync(s.file + ".lock"), false);
});

test("--lint reports without writing, --compact archives the overflow", () => {
  const s = session({ MEMORY_OBS_MAX: "2" });
  const row = { type: "entity", name: "api", entityType: "service", observations: ["identity", "2026-01-01: a", "2026-01-02: b", "2026-01-03: c"] };
  fs.writeFileSync(s.file, JSON.stringify(row) + "\n");
  const report = s.cli("--lint");
  assert.match(report, /4 obs\s+0 long\s+\[service\] api/);
  assert.match(report, /2 observation\(s\) over the cap of 2 per entity would move/);
  assert.deepEqual(s.rows(), [row]);
  assert.match(s.cli("--compact"), /written, .* backup at .*before-compact\.jsonl/);
  assert.deepEqual(s.rows()[0].observations, ["identity", "2026-01-03: c"]);
  assert.match(fs.readFileSync(path.join(s.dir, "archive", "api.md"), "utf8"), /compacted .*\n- 2026-01-01: a\n- 2026-01-02: b/);
});

test("--protocol prints the agent instructions and --skill writes the same text as the plugin's skill", () => {
  const s = session();
  const protocol = s.cli("--protocol");
  assert.match(protocol, /^# Memory graph protocol\n\nA knowledge graph/);
  assert.doesNotMatch(protocol, /Paste this into/);
  assert.match(s.cli("--skill", path.join(s.dir, "skills")), /Wrote .*memory-graph/);
  const skill = fs.readFileSync(path.join(s.dir, "skills", "memory-graph", "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: memory-graph\ndescription: .+\n---\n\n# Memory graph protocol/);
  assert.equal(skill.endsWith(protocol), true);
  // the copy shipped in the Claude Code plugin must not drift from the protocol
  assert.equal(fs.readFileSync(path.join(ROOT, "plugin", "skills", "memory-graph", "SKILL.md"), "utf8"), skill);
});

test("the plugin and the package agree on the version", () => {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, "plugin", ".claude-plugin", "plugin.json"), "utf8")).version, version);
});

test("rename_entity keeps observations, relations and the archive", () => {
  const s = session({ MEMORY_OBS_MAX: "1" });
  s.call("create_entities", { entities: [
    { name: "old api", entityType: "service", observations: ["2026-01-01: a", "2026-01-02: b"] },
    { name: "app", entityType: "mobile_app", observations: [] },
  ] });
  s.call("create_relations", { relations: [{ from: "app", to: "old api", relationType: "talks_to" }, { from: "old api", to: "old api", relationType: "replaces" }] });
  assert.match(s.call("rename_entity", { name: "old api", newName: "api" }).text, /Renamed old api -> api; 3 relation end\(s\) updated/);
  const opened = s.call("open_nodes", { names: ["api"] }).text;
  assert.match(opened, /## api \[service\]\n- 2026-01-02: b/);
  assert.match(opened, /app -talks_to-> api\napi -replaces-> api/);
  assert.match(s.call("open_nodes", { names: ["old api"] }).text, /Not found: "old api"/);
  assert.deepEqual(fs.readdirSync(path.join(s.dir, "archive")), ["api.md"]);
  assert.match(fs.readFileSync(path.join(s.dir, "archive", "api.md"), "utf8"), /2026-01-01: a/);
  // refuses to overwrite or invent
  assert.match(s.call("rename_entity", { name: "api", newName: "app" }).text, /already exists/);
  assert.match(s.call("rename_entity", { name: "nope", newName: "x" }).text, /Entity not found: nope/);
  assert.equal(s.rows().filter((r) => r.type === "entity").length, 2);
});
