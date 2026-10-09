# Contributing

Thanks for looking. The project is small on purpose, so a change is easy to make
and easy to review.

## Setup

```bash
git clone https://github.com/zamansheikh/memory-lean.git
cd memory-lean
npm test
```

There is nothing to install. You need Node 18 or newer.

## Where things are

| Path | What it is |
|---|---|
| `server/memory-lean.mjs` | The whole server: storage, the tools, MCP over stdio, and the command-line flags |
| `test/memory-lean.test.mjs` | Tests that start the server and talk to it over stdio, as a client would |
| `tools/bench.mjs` | Compares answer sizes with the reference server on a graph |
| `docs/AGENT-PROTOCOL.md` | The agent instructions; `--protocol` and `--skill` print this file |
| `docs/SETUP.md` | Copy-paste setup for each agent |
| `server.json` | The entry for the official MCP registry; its version must match `package.json` |
| `plugin/` | The Claude Code plugin; `.claude-plugin/marketplace.json` at the root lists it |

To try a change against a throwaway graph:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_graph","arguments":{}}}' \
  | MEMORY_FILE_PATH=/tmp/try/memory.jsonl node server/memory-lean.mjs
```

## What a change needs

- **A test.** A bug fix comes with a test that fails without the fix. A new
  behaviour comes with a test that shows it.
- **No dependencies.** The server runs with Node alone, and that is a feature.
- **The same file format and tool names** as `@modelcontextprotocol/server-memory`.
  Users must be able to switch in and switch back.
- **Small answers.** Before adding output to a tool, ask what it costs in tokens on
  a graph of a few hundred entities. `node tools/bench.mjs` shows the numbers.
- **One copy of the protocol.** Edit `docs/AGENT-PROTOCOL.md`, then run
  `node server/memory-lean.mjs --skill plugin/skills` to refresh the plugin's
  skill. A test fails if they differ.
- **Docs that match.** If behaviour or a setting changes, update `README.md`,
  `docs/AGENT-PROTOCOL.md` and `CHANGELOG.md` in the same pull request.

Never include a real `memory.jsonl`, archive or backup in an issue or pull request.
Graphs hold private project details. Build a small made-up graph that shows the
problem instead.

## Good first contributions

- Run the tests on Windows and report or fix what fails.
- A section in `docs/SETUP.md` for an agent you use, tested on a real install.
- Anything on the roadmap in the README.

## Reporting a bug

Open an issue with the server version (`node server/memory-lean.mjs --version`),
your Node version, the tool call you made, and what came back.
