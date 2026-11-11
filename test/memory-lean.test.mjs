// Drives the server over stdio exactly as an MCP client would.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
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
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(init.result.serverInfo.version, pkg.version);
  // the MCP registry entry describes the same release
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "server.json"), "utf8"));
  assert.deepEqual([registry.name, registry.version, registry.packages[0].version], [pkg.mcpName, pkg.version, pkg.version]);
  assert.ok(registry.description.length <= 100);
  assert.deepEqual(
    list.result.tools.map((t) => t.name).sort(),
    ["add_observations", "archived_observations", "create_entities", "create_relations", "delete_entities", "delete_observations", "delete_relations", "open_nodes", "read_graph", "rename_entity", "replace_observation", "search_nodes"],
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
  assert.match(s.call("delete_observations", { deletions: [{ entityName: "a", observations: ["one", "missing"] }] }).text, /a: -1 \(1 not matched\)/);
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
  assert.doesNotMatch(report, /Worth a look/);
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
  // the plugin starts the server of its own version, not whichever one npx has cached or finds newest
  const mcp = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin", ".mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers.memory.args, ["-y", `memory-lean@${version}`]);
  assert.ok(fs.readFileSync(path.join(ROOT, "plugin", "commands", "memory-ui.md"), "utf8").includes(`npx -y memory-lean@${version} --ui`));
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
  assert.match(opened, /## api \[service\] \(1 archived\)\n- 2026-01-02: b/);
  assert.match(opened, /app -talks_to-> api\napi -replaces-> api/);
  assert.match(s.call("open_nodes", { names: ["old api"] }).text, /Not found: "old api"/);
  assert.deepEqual(fs.readdirSync(path.join(s.dir, "archive")), ["api.md"]);
  assert.match(fs.readFileSync(path.join(s.dir, "archive", "api.md"), "utf8"), /from `api`\n- 2026-01-01: a/);
  // refuses to overwrite or invent
  assert.match(s.call("rename_entity", { name: "api", newName: "app" }).text, /already exists/);
  assert.match(s.call("rename_entity", { name: "nope", newName: "x" }).text, /Entity not found: nope/);
  assert.equal(s.rows().filter((r) => r.type === "entity").length, 2);
});

test("archived observations can be listed, searched and restored", () => {
  const s = session({ MEMORY_OBS_MAX: "2" });
  s.call("create_entities", { entities: [{ name: "api", entityType: "service", observations: [
    "2026-01-01: deployed 1.0", "2026-01-02: moved to Postgres", "2026-01-03: deployed 1.1", "2026-01-04: deployed 1.2",
  ] }] });
  assert.match(s.call("open_nodes", { names: ["api"] }).text, /## api \[service\] \(2 archived\)/);
  assert.equal(s.call("archived_observations", { entityName: "api" }).text, "2 archived for api:\n- 2026-01-01: deployed 1.0\n- 2026-01-02: moved to Postgres");
  assert.equal(s.call("archived_observations", { entityName: "api", query: "postgres moved" }).text, "1 archived for api:\n- 2026-01-02: moved to Postgres");
  assert.match(s.call("archived_observations", { entityName: "api", query: "mysql" }).text, /None of the 2 archived/);
  assert.match(s.call("archived_observations", { entityName: "other" }).text, /Nothing archived for "other"/);

  const res = s.call("archived_observations", { entityName: "api", restore: ["2026-01-02: moved to Postgres", "typo"] });
  assert.match(res.text, /api: restored 1, now 3 \(1 not matched exactly\) \(over cap 2/);
  assert.deepEqual(s.rows()[0].observations, ["2026-01-03: deployed 1.1", "2026-01-04: deployed 1.2", "2026-01-02: moved to Postgres"]);
  assert.equal(s.call("archived_observations", { entityName: "api" }).text, "1 archived for api:\n- 2026-01-01: deployed 1.0");

  // nothing matched: the graph and the archive are left alone
  const miss = s.call("archived_observations", { entityName: "api", restore: ["nope"] });
  assert.equal(miss.isError, true);
  // restoring the last one removes the archive file
  s.call("archived_observations", { entityName: "api", restore: ["2026-01-01: deployed 1.0"] });
  assert.deepEqual(fs.readdirSync(path.join(s.dir, "archive")), []);
});

test("--ui serves the page and edits the graph, only with the token and a loopback host", async () => {
  const s = session();
  s.call("create_entities", { entities: [{ name: "api", entityType: "service", observations: ["one", "two"] }] });
  const child = spawn("node", [SERVER, "--ui", "0", "--no-open"], { env: s.env });
  try {
    const link = await new Promise((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (d) => { out += d; const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/#\S+/); if (m) resolve(m[0]); });
      child.on("exit", () => reject(new Error(`--ui exited: ${out}`)));
    });
    const [base, token] = link.split("/#");
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
    assert.match(await page.text(), /<title>memory-lean<\/title>/);
    assert.equal((await fetch(`${base}/api/graph`)).status, 401);
    const headers = { "x-memory-lean-token": token, "content-type": "application/json" };
    const get = (p) => fetch(base + p, { headers }).then((r) => r.json());
    const call = (tool, args) => fetch(`${base}/api/call`, { method: "POST", headers, body: JSON.stringify({ tool, args }) })
      .then(async (r) => ({ status: r.status, ...(await r.json()) }));

    const graph = await get("/api/graph");
    assert.deepEqual(graph.entities.map((e) => [e.name, e.observations.length, e.archived]), [["api", 2, 0]]);
    assert.deepEqual(graph.limits, { obsMaxChars: 300, obsMax: 15 });
    assert.deepEqual(graph.health, []);
    assert.deepEqual((await get("/api/archive?name=api")).items, []);
    // edits the MCP tools do not have: in-place edit (keeps the order) and changing the type
    assert.match((await call("replace_observation", { entityName: "api", old: "one", text: "uno" })).text, /updated/);
    assert.match((await call("set_type", { name: "api", entityType: "backend" })).text, /service -> backend/);
    assert.deepEqual(s.rows()[0], { type: "entity", name: "api", entityType: "backend", observations: ["uno", "two"] });
    // the regular tools work too, with the same limits
    assert.match((await call("add_observations", { observations: [{ entityName: "api", contents: ["three"] }] })).text, /api: \+1/);
    const long = await call("replace_observation", { entityName: "api", old: "two", text: "x".repeat(301) });
    assert.equal(long.status, 400);
    assert.match(long.text, /over 300 chars/);
    assert.equal((await call("search_nodes", { query: "api" })).status, 400);
    assert.notEqual((await get("/api/stamp")).stamp, graph.stamp);
    // a page served under another host name (DNS rebinding) is refused
    const status = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: new URL(base).port, path: "/", agent: false, headers: { host: "evil.example" } }, (r) => { r.resume(); r.on("end", () => resolve(r.statusCode)); })
        .on("error", reject);
    });
    assert.equal(status, 403);
  } finally {
    // Wait for the server to exit, so no connection to it outlives the test (Windows resets them loudly).
    await new Promise((resolve) => { child.on("exit", resolve); child.kill(); });
  }
});

test("initialize answers with a protocol version it speaks and a short usage note", () => {
  const s = session();
  const init = (params, from = s) => from.rpc([{ method: "initialize", params }])[0].result;
  assert.equal(init({ protocolVersion: "2025-03-26" }).protocolVersion, "2025-03-26");
  // a version it does not know is answered with its newest, not echoed back
  assert.equal(init({ protocolVersion: "1999-01-01" }).protocolVersion, "2025-11-25");
  assert.equal(init({}).protocolVersion, "2025-11-25");
  const { instructions } = init({});
  assert.match(instructions, /open_nodes/);
  assert.match(instructions, /replace_observation/);
  assert.ok(instructions.length < 800, "every session pays for the instructions");
  assert.equal("instructions" in init({}, session({ MEMORY_INSTRUCTIONS: "off" })), false);
});

test("the write tools ask for facts of half the limit, and so does a rejection", () => {
  const s = session({ MEMORY_OBS_MAX_CHARS: "200" });
  const [init, list] = s.rpc([{ method: "initialize", params: {} }, { method: "tools/list" }]);
  for (const name of ["add_observations", "create_entities"]) {
    assert.match(list.result.tools.find((t) => t.name === name).description, /aim for under 100 characters, over 200 is rejected/, name);
  }
  assert.match(init.result.instructions, /one short fact \(under 100 characters\)/);
  s.call("create_entities", { entities: [{ name: "api", entityType: "t", observations: [] }] });
  const res = s.call("add_observations", { observations: [{ entityName: "api", contents: ["x".repeat(201)] }] });
  assert.equal(res.isError, true);
  assert.match(res.text, /not over 200 chars \(split it, or shorten it to about 100;/);
  // a fact between the target and the limit is accepted, and the answer says so
  assert.equal(s.call("add_observations", { observations: [{ entityName: "api", contents: ["x".repeat(150), "short"] }] }).text, "api: +2, now 2 (1 over 100 chars: aim shorter)");
  assert.equal(s.call("replace_observation", { entityName: "api", old: "short", text: "y".repeat(101) }).text, "api: observation updated (1 over 100 chars: aim shorter)");
});

test("rejects names and observations that would break the one-line formats", () => {
  const s = session();
  for (const entity of [
    { name: "x\n## fake [rule]", entityType: "t", observations: [] },
    { name: " api", entityType: "t", observations: [] },
    { name: "api", entityType: "two\nlines", observations: [] },
    { name: "api", entityType: "t", observations: ["two\nlines"] },
    { name: "api", entityType: "t", observations: ["  "] },
  ]) assert.equal(s.call("create_entities", { entities: [entity] }).isError, true, JSON.stringify(entity));
  assert.equal(fs.existsSync(s.file), false);
  s.call("create_entities", { entities: [{ name: "api", entityType: "t", observations: [] }] });
  assert.match(s.call("add_observations", { observations: [{ entityName: "api", contents: ["a\r\nb"] }] }).text, /api: has a line break/);
  assert.match(s.call("add_observations", { observations: [{ entityName: "api", contents: [""] }] }).text, /api: empty/);
  assert.match(s.call("rename_entity", { name: "api", newName: "a\nb" }).text, /newName must be one line/);
  assert.match(s.call("create_relations", { relations: [{ from: "api", to: "api", relationType: "a\nb" }] }).text, /one line/);
  assert.deepEqual(s.rows(), [{ type: "entity", name: "api", entityType: "t", observations: [] }]);
});

test("a multi-line observation from an older file is archived on one line and can be restored", () => {
  const s = session({ MEMORY_OBS_MAX: "1" });
  const row = { type: "entity", name: "a", entityType: "t", observations: ["2026-01-01: first line\n\n## not a header\n- not an item", "2026-01-02: newer"] };
  fs.writeFileSync(s.file, JSON.stringify(row) + "\n");
  s.call("add_observations", { observations: [{ entityName: "a", contents: ["2026-01-03: newest"] }] });
  const flat = "2026-01-01: first line ## not a header - not an item";
  assert.equal(s.call("archived_observations", { entityName: "a" }).text, `2 archived for a:\n- ${flat}\n- 2026-01-02: newer`);
  assert.match(s.call("archived_observations", { entityName: "a", restore: [flat] }).text, /a: restored 1, now 2/);
  assert.deepEqual(s.rows()[0].observations, ["2026-01-03: newest", flat]);
});

test("entities whose names share an archive file keep their archives apart", () => {
  const s = session({ MEMORY_OBS_MAX: "1" });
  // "shop api" and "shop_api" map to shop_api.md; "API" and "api" are one file on macOS and Windows
  const names = ["shop api", "shop_api", "API", "api"];
  s.call("create_entities", { entities: names.map((name) => ({ name, entityType: "t", observations: [`2026-01-01: old fact of ${name}`, `2026-01-02: new fact of ${name}`] })) });
  for (const name of names) {
    assert.match(s.call("open_nodes", { names: [name] }).text, /\(1 archived\)/, name);
    assert.equal(s.call("archived_observations", { entityName: name }).text, `1 archived for ${name}:\n- 2026-01-01: old fact of ${name}`);
  }
  // one entity cannot restore the other's fact, and restoring its own leaves the other's in the file
  assert.equal(s.call("archived_observations", { entityName: "api", restore: ["2026-01-01: old fact of API"] }).isError, true);
  assert.match(s.call("archived_observations", { entityName: "shop api", restore: ["2026-01-01: old fact of shop api"] }).text, /restored 1/);
  assert.match(s.call("archived_observations", { entityName: "shop api" }).text, /Nothing archived/);
  assert.equal(s.call("archived_observations", { entityName: "shop_api" }).text, "1 archived for shop_api:\n- 2026-01-01: old fact of shop_api");
});

test("a deleted entity's archive is kept on disk but not inherited by a new entity of that name", () => {
  const s = session({ MEMORY_OBS_MAX: "1" });
  s.call("create_entities", { entities: [{ name: "a", entityType: "t", observations: ["2026-01-01: old", "2026-01-02: new"] }] });
  s.call("delete_entities", { entityNames: ["a", "never existed"] });
  s.call("create_entities", { entities: [{ name: "a", entityType: "other", observations: ["2026-02-01: one", "2026-02-02: two"] }] });
  assert.match(s.call("open_nodes", { names: ["a"] }).text, /^## a \[other\] \(1 archived\)\n/);
  assert.equal(s.call("archived_observations", { entityName: "a" }).text, "1 archived for a:\n- 2026-02-01: one");
  assert.match(s.call("search_nodes", { query: "old" }).text, /No entities match/);
  assert.match(fs.readFileSync(path.join(s.dir, "archive", "a.md"), "utf8"), /from `a` \(deleted [\d: -]+\)\n- 2026-01-01: old\n/);
});

test("renaming keeps the archive when only the case changes, and reads archives renamed by older versions", () => {
  const s = session({ MEMORY_OBS_MAX: "1" });
  s.call("create_entities", { entities: [{ name: "API", entityType: "t", observations: ["2026-01-01: a", "2026-01-02: b"] }] });
  s.call("rename_entity", { name: "API", newName: "api" });
  assert.equal(s.call("archived_observations", { entityName: "api" }).text, "1 archived for api:\n- 2026-01-01: a");
  // before 1.6 a renamed entity's sections kept the old name in their header
  fs.writeFileSync(path.join(s.dir, "archive", "api.md"), "\n## auto-archived (over cap) 2026-01-01 00:00:00 from `old name`\n- 2025-12-31: legacy\n\n## archived 2025-09-27-160341 from entity `older name`\n- 2025-09-01: older\n");
  assert.equal(s.call("archived_observations", { entityName: "api" }).text, "2 archived for api:\n- 2025-12-31: legacy\n- 2025-09-01: older");
  // the next rename puts its own name on them
  s.call("rename_entity", { name: "api", newName: "gateway" });
  assert.match(fs.readFileSync(path.join(s.dir, "archive", "gateway.md"), "utf8"), /from `gateway`\n- 2025-12-31: legacy\n\n## archived 2025-09-27-160341 from entity `gateway`\n- 2025-09-01: older\n/);
});

test("search finds entities that match only in archived observations", () => {
  const s = session({ MEMORY_OBS_MAX: "1" });
  s.call("create_entities", { entities: [
    { name: "api", entityType: "service", observations: ["2026-01-01: moved to Postgres", "2026-01-02: deployed 1.1"] },
    { name: "app", entityType: "mobile_app", observations: ["2026-01-01: deployed 0.9", "2026-01-02: deployed 1.0"] },
    { name: "web", entityType: "site", observations: ["2026-01-01: deployed 0.1", "2026-01-02: redesigned"] },
  ] });
  assert.equal(s.call("search_nodes", { query: "postgres" }).text,
    'No current facts match "postgres".\nOnly in archived observations (archived_observations lists and restores them):\n- api [service] 1 archived\n    › 2026-01-01: moved to Postgres');
  // one term in the name, the other only in the archive
  assert.match(s.call("search_nodes", { query: "api postgres" }).text, /Only in archived observations[^]*- api \[service\] 1 archived/);
  // current matches come first, and say when the archive holds more of the same
  const deployed = s.call("search_nodes", { query: "deployed" }).text;
  assert.match(deployed, /^2 match "deployed"\./);
  assert.match(deployed, /- app \[mobile_app\] 1 obs, 0 rel, \+1 archived\n/);
  assert.match(deployed, /\nOnly in archived observations: web \(1\)\. archived_observations lists them\.$/);
  // when the list already overflows, the archive costs one line
  const capped = s.call("search_nodes", { query: "deployed", limit: 1 }).text;
  assert.match(capped, /\n1 more match only in archived observations\.$/);
  assert.doesNotMatch(capped, /web/);
});

test("search ranks a term in the name and a fact holding every term above scattered matches", () => {
  const s = session();
  s.call("create_entities", { entities: [
    { name: "notes", entityType: "t", observations: ["release checklist", "release train", "release notes", "voxa mention"] },
    { name: "changelog", entityType: "t", observations: ["the voxa release went out"] },
    { name: "voxa_beauty", entityType: "t", observations: ["2026-01-01: release 1.2.0 published"] },
    { name: "mix", entityType: "t", observations: ["alpha first", "beta second", "alpha and beta third"] },
  ] });
  const ranked = s.call("search_nodes", { query: "voxa release" }).text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.split(" ")[1]);
  assert.deepEqual(ranked, ["voxa_beauty", "changelog", "notes"]);
  // the snippet shown first is the fact with the most terms
  assert.match(s.call("search_nodes", { query: "alpha beta" }).text, /- mix \[t\] 3 obs, 0 rel\n    › alpha and beta third\n/);
});

test("search shows the facts about the topic, not the ones that only repeat the entity's name", () => {
  const s = session();
  const twoFacts = (name) => ({ name, entityType: "service", observations: ["release notes are in docs/", "2026-01-01: release 0.1"] });
  s.call("create_entities", { entities: [
    { name: "shop-api", entityType: "service", observations: [
      "2026-01-01: shop-api moved to its own repo", "runs behind the shop-api gateway",
      "2026-02-01: released 1.4.0", "2026-03-01: released 1.5.0", "release with scripts/release.sh, never by hand",
    ] },
    twoFacts("billing"), twoFacts("catalog"), twoFacts("search"),
  ] });
  // the name answers "shop-api"; the facts shown are about "release": the standing one, then the newest
  assert.deepEqual(s.call("search_nodes", { query: "shop-api release" }).text.split("\n").slice(1), [
    "- shop-api [service] 5 obs, 0 rel",
    "    › release with scripts/release.sh, never by hand",
    "    › 2026-03-01: released 1.5.0",
  ]);
  // a second fact that adds no term is kept for the top three matches only
  const broad = s.call("search_nodes", { query: "release" }).text.split("\n");
  assert.equal(broad.filter((l) => l.startsWith("- ")).length, 4);
  assert.equal(broad.filter((l) => l.startsWith("    › ")).length, 3 * 2 + 1);
  // when the name holds every term, one standing fact says what the entity is
  assert.match(s.call("search_nodes", { query: "shop-api" }).text, /- shop-api \[service\] 5 obs, 0 rel\n    › runs behind the shop-api gateway$/);
});

test("a whole word ranks above the start of a longer word, and that above the middle of one", () => {
  const s = session();
  s.call("create_entities", { entities: [
    { name: "exports", entityType: "t", observations: ["the format is CSV", "the format changed twice", "formats are listed in docs/"] },
    { name: "team", entityType: "t", observations: ["the platform team owns it", "platform budget is fixed"] },
    { name: "signup", entityType: "t", observations: ["the signup form posts to /api/signup"] },
    { name: "mixed", entityType: "t", observations: ["the format is JSON", "fill in the form by hand"] },
  ] });
  const ranked = (query) => s.call("search_nodes", { query }).text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.split(" ")[1]);
  // every one of them contains "form"; one fact with the word itself beats three with a longer word
  assert.deepEqual(ranked("form"), ["mixed", "signup", "exports", "team"]);
  // and the fact shown first is the one with the word itself
  assert.match(s.call("search_nodes", { query: "form" }).text, /- mixed \[t\] 2 obs, 0 rel\n    › fill in the form by hand\n/);
  // part of a word still finds it
  assert.deepEqual(ranked("platf"), ["team"]);
  assert.deepEqual(ranked("ormat"), ["exports", "mixed"]);
});

test("an entity matched by its name alone is shown with the fact saying what it is", () => {
  const s = session();
  s.call("create_entities", { entities: [
    { name: "billing", entityType: "service", observations: ["2026-01-01: moved to Stripe", "Invoices and refunds, owns the invoices table"] },
    { name: "billing-jobs", entityType: "worker", observations: ["2026-02-01: nightly run moved to 02:00"] },
    { name: "billing-empty", entityType: "worker", observations: [] },
  ] });
  assert.equal(s.call("search_nodes", { query: "billing" }).text, [
    '3 match "billing". open_nodes for full entities.',
    "- billing [service] 2 obs, 0 rel",
    "    › Invoices and refunds, owns the invoices table", // the standing fact, not the first one
    "- billing-empty [worker] 0 obs, 0 rel",
    "- billing-jobs [worker] 1 obs, 0 rel",
    "    › 2026-02-01: nightly run moved to 02:00", // no standing fact: its first
  ].join("\n"));
});

test("an entity with only dated facts is asked for one saying what it is", () => {
  const s = session();
  const made = s.call("create_entities", { entities: [
    { name: "api", entityType: "service", observations: ["2026-01-01: deployed 1.0"] },
    { name: "app", entityType: "mobile_app", observations: ["Flutter app for iOS and Android", "2026-01-01: 3.0 in the stores"] },
    { name: "RULE no Friday deploys", entityType: "rule", observations: ["2026-01-05: a Friday deploy broke checkout"] },
    { name: "later", entityType: "service", observations: [] },
  ] });
  assert.equal(made.text, "Created: api, app, RULE no Friday deploys, later\nNo undated fact says what api is: add one, it is never archived.");
  const add = (entityName, fact) => s.call("add_observations", { observations: [{ entityName, contents: [fact] }] }).text;
  assert.equal(add("api", "2026-01-02: deployed 1.1"), "api: +1, now 2 (no undated fact says what it is: add one)");
  assert.equal(add("later", "2026-01-02: created"), "later: +1, now 1 (no undated fact says what it is: add one)");
  // once it has one, and for rules and pending work, nothing is asked
  assert.equal(add("api", "NestJS API behind api.example.com"), "api: +1, now 3");
  assert.equal(add("RULE no Friday deploys", "2026-02-01: it happened again"), "RULE no Friday deploys: +1, now 2");
  assert.match(s.cli("--lint"), /\n   1  entities with no undated fact saying what they are: later\n/);
});

test("replace_observation and delete_observations accept a distinctive part of a fact", () => {
  const s = session();
  s.call("create_entities", { entities: [{ name: "api", entityType: "service", observations: [
    "2026-01-01: deployed 1.4.0 to production", "2026-01-02: deployed 1.4.1 to production", "runs on port 8080",
  ] }] });
  const replace = (old, text) => s.call("replace_observation", { entityName: "api", old, text });
  assert.equal(replace("deployed 1.4.0", "2026-02-01: deployed 1.5.0 to production").text, 'api: observation updated (was: "2026-01-01: deployed 1.4.0 to production")');
  // in place: the fact keeps its position
  assert.deepEqual(s.rows()[0].observations, ["2026-02-01: deployed 1.5.0 to production", "2026-01-02: deployed 1.4.1 to production", "runs on port 8080"]);
  assert.equal(replace("runs on port 8080", "runs on port 9090").text, "api: observation updated");
  for (const [old, text, why] of [
    ["to production", "a new fact", /More than one observation of api contains that text/],
    ["no such text", "a new fact", /No observation of api has that text/],
    ["port", "a new fact", /No observation of api has that text/], // too short to count as a part
    ["runs on port 9090", "2026-01-02: deployed 1.4.1 to production", /already has that observation/],
    ["runs on port 9090", "x".repeat(301), /over 300 chars/],
    ["runs on port 9090", "two\nlines", /has a line break/],
  ]) {
    const res = replace(old, text);
    assert.equal(res.isError, true);
    assert.match(res.text, why);
  }
  const del = s.call("delete_observations", { deletions: [{ entityName: "api", observations: ["deployed 1.4.1", "to production", "runs on port 9090", "missing"] }] });
  assert.equal(del.text, 'api: -2 (found by part: "2026-01-02: deployed 1.4.1 to production") (1 not matched) (1 in more than one observation, give more of the text)');
  assert.deepEqual(s.rows()[0].observations, ["2026-02-01: deployed 1.5.0 to production"]);
});

test("read_graph gives the largest types as a count once the index is over budget", () => {
  const s = session();
  const rows = [
    ...Array.from({ length: 300 }, (_, i) => ({ type: "entity", name: `RULE a fairly long rule name number ${i}`, entityType: "rule", observations: [] })),
    { type: "entity", name: "api", entityType: "service", observations: ["one"] },
  ];
  fs.writeFileSync(s.file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const index = s.call("read_graph").text;
  assert.match(index, /^301 entities, 0 relations\.\nrule: 300 entities\nservice: api \(1\)\nNames of the largest type\(s\) are left out/);
  assert.ok(index.length < 300);
  // asking for the type lists it
  const rules = s.call("read_graph", { entityType: "rule" }).text;
  assert.match(rules, /RULE a fairly long rule name number 299 \(0\)/);
  assert.doesNotMatch(rules, /left out/);
  assert.match(s.call("read_graph", { entityType: "nope" }).text, /No entities of type "nope"/);
});

test("--lint reports what needs tidying, and creating a near-duplicate name says so", () => {
  const s = session();
  const today = new Date().toISOString().slice(0, 10);
  const made = s.call("create_entities", { entities: [
    { name: "api", entityType: "service", observations: [] },
    { name: "Shop App", entityType: "mobile_app", observations: [] },
    { name: "shop-app", entityType: "mobile_app", observations: [] },
    { name: "PENDING api 2.0", entityType: "pending", observations: ["2020-01-01: api 2.0 published"] },
    { name: "PENDING api 3.0", entityType: "pending", observations: [`${today}: api 3.0 published`] },
  ] });
  assert.match(made.text, /A similar name already exists.*: shop-app ~ Shop App$/);
  s.call("create_relations", { relations: [{ from: "PENDING api 3.0", to: "api", relationType: "blocks" }] });
  // a relation to nothing and an archive of nothing, as hand edits or older versions leave them
  fs.appendFileSync(s.file, JSON.stringify({ type: "relation", from: "api", to: "gone", relationType: "depends_on" }) + "\n");
  fs.mkdirSync(path.join(s.dir, "archive"));
  fs.writeFileSync(path.join(s.dir, "archive", "gone.md"), "\n## auto-archived (over cap) 2026-01-01 00:00:00 from `gone`\n- 2025-01-01: x\n");
  const before = fs.readFileSync(s.file, "utf8");
  const report = s.cli("--lint");
  for (const line of [
    "1  pending work that blocks nothing (finished? delete it): PENDING api 2.0",
    "1  pending work with no dated fact in the last 30 days: PENDING api 2.0",
    "3  entities with no relations (nothing leads to them): Shop App; shop-app; PENDING api 2.0",
    "1  names that differ only in case or separators (one thing twice?): Shop App ~ shop-app",
    "1  relations to an entity that does not exist: api -depends_on-> gone",
    "1  archive files of no current entity: gone.md",
  ]) assert.ok(report.includes(`   ${line}\n`), `${line}\n--- in ---\n${report}`);
  assert.equal(fs.readFileSync(s.file, "utf8"), before);
});

test("open_nodes with related introduces each related entity by its first fact", () => {
  const s = session();
  s.call("create_entities", { entities: [
    { name: "shop-backend", entityType: "service", observations: ["NestJS API"] },
    { name: "RULE no Friday deploys", entityType: "rule", observations: ["Deploys after Thursday 18:00 need the on-call's approval"] },
    { name: "PENDING shop-backend 2.4.0", entityType: "pending", observations: ["2026-03-02: 2.4.0 published", "2026-03-03: web updated"] },
    { name: "empty", entityType: "t", observations: [] },
  ] });
  s.call("create_entities", { entities: [{ name: "shop-app", entityType: "mobile_app", observations: ["Flutter app for iOS and Android", "2026-01-01: 3.0 in the stores"] }] });
  s.call("create_relations", { relations: [
    { from: "shop-app", to: "shop-backend", relationType: "talks_to" },
    { from: "RULE no Friday deploys", to: "shop-backend", relationType: "applies_to" },
    { from: "shop-backend", to: "empty", relationType: "depends_on" },
    { from: "PENDING shop-backend 2.4.0", to: "shop-backend", relationType: "blocks" },
    { from: "shop-backend", to: "RULE no Friday deploys", relationType: "follows" },
  ] });
  assert.equal(s.call("open_nodes", { names: ["shop-backend"], related: true }).text, [
    "## shop-backend [service]",
    "- NestJS API",
    "",
    "## relations",
    // what binds the task comes first, whatever the order in the file
    "RULE no Friday deploys -applies_to-> shop-backend",
    "    › Deploys after Thursday 18:00 need the on-call's approval", // its only fact: nothing more to open
    "PENDING shop-backend 2.4.0 -blocks-> shop-backend",
    "    › 2026-03-02: 2.4.0 published (+1 more)",
    "shop-backend -follows-> RULE no Friday deploys", // introduced once
    // other neighbours stay a name: a hub has dozens of them
    "shop-app -talks_to-> shop-backend",
    "shop-backend -depends_on-> empty",
  ].join("\n"));
  // without the option the answer is as before, in the order of the file
  const plain = s.call("open_nodes", { names: ["shop-backend"] }).text;
  assert.doesNotMatch(plain, /›/);
  assert.match(plain, /## relations\nshop-app -talks_to-> shop-backend\nRULE no Friday deploys/);
  // an entity opened in the same call is not introduced as well
  assert.doesNotMatch(s.call("open_nodes", { names: ["shop-backend", "RULE no Friday deploys"], related: true }).text, /› Deploys/);
});

test("a name that is right but for its case or separators opens; a wrong one gets suggestions, on writes too", () => {
  const s = session();
  s.call("create_entities", { entities: [
    { name: "shop-backend", entityType: "service", observations: ["NestJS API"] },
    { name: "shop-app", entityType: "mobile_app", observations: [] },
  ] });
  assert.equal(s.call("open_nodes", { names: ["Shop_Backend"] }).text, "## shop-backend [service]\n- NestJS API");
  assert.match(s.call("open_nodes", { names: ["shop"] }).text, /^Not found: "shop"; did you mean: shop-backend, shop-app$/);
  // a write never guesses: it says what the name could have been
  const res = s.call("add_observations", { observations: [{ entityName: "shop backend", contents: ["one"] }] });
  assert.equal(res.isError, true);
  assert.equal(res.text, "Entity not found: shop backend (did you mean: shop-backend)");
  assert.match(s.call("replace_observation", { entityName: "Shop-App", old: "anything here", text: "new fact" }).text, /Entity not found: Shop-App \(did you mean: shop-app\)/);
  assert.equal(s.call("rename_entity", { name: "nowhere", newName: "x" }).text, "Entity not found: nowhere");
  assert.deepEqual(s.rows()[0].observations, ["NestJS API"]);
});

test("a search that matches nothing names the term that is nowhere and the closest entities", () => {
  const s = session();
  s.call("create_entities", { entities: [
    { name: "voxa_beauty", entityType: "package", observations: ["2026-01-01: release 1.2.0 published"] },
    { name: "voxa-console", entityType: "admin_panel", observations: ["Next.js admin"] },
    { name: "api", entityType: "service", observations: ["release notes live in docs/"] },
  ] });
  assert.equal(s.call("search_nodes", { query: "voxa release pipeline" }).text,
    'No entities match "voxa release pipeline". In no entity: pipeline. Closest (2 of 3 terms): voxa_beauty.');
  // every term exists, but never together: the term in a name ranks first
  assert.equal(s.call("search_nodes", { query: "console release" }).text,
    'No entities match "console release". Closest (1 of 2 terms): voxa-console, api, voxa_beauty.');
  assert.equal(s.call("search_nodes", { query: "nothing" }).text, 'No entities match "nothing".');
  assert.equal(s.call("search_nodes", { query: "nothing anywhere" }).text, 'No entities match "nothing anywhere".');
});

test("the startup note names the entity of the directory the server was started in", () => {
  const s = session();
  s.call("create_entities", { entities: [
    { name: "shop-backend", entityType: "service", observations: [] },
    { name: "acme", entityType: "org", observations: [] },
  ] });
  // acme/Shop_Backend/src: the project folder is one level up, and spelled its own way
  const dir = path.join(s.dir, "acme", "Shop_Backend", "src");
  fs.mkdirSync(dir, { recursive: true });
  const { CLAUDE_PROJECT_DIR: _unused, ...env } = s.env;
  const note = (opts) => {
    const out = spawnSync("node", [SERVER], { input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n", ...opts });
    return JSON.parse(out.stdout.toString()).result.instructions;
  };
  assert.match(note({ env, cwd: dir }), / The working directory matches the entities "shop-backend" and "acme": open them first\.$/);
  // Claude Code names the project folder itself, wherever the server is started
  assert.match(note({ env: { ...env, CLAUDE_PROJECT_DIR: path.join(s.dir, "acme") }, cwd: dir }), / The working directory matches the entity "acme": open it first\.$/);
  assert.doesNotMatch(note({ env, cwd: s.dir }), /working directory/);
  assert.equal(note({ env: { ...env, MEMORY_INSTRUCTIONS: "off" }, cwd: dir }), undefined);
});
