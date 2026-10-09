<p align="center">
  <img src="https://raw.githubusercontent.com/zamansheikh/memory-lean/main/assets/icon.svg" width="112" height="112" alt="memory-lean icon">
</p>

<h1 align="center">memory-lean</h1>

<p align="center">
  <strong>Long-term memory for AI coding agents that doesn't burn the context window.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/memory-lean"><img src="https://img.shields.io/npm/v/memory-lean.svg?color=4f8bff" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/memory-lean"><img src="https://img.shields.io/npm/dm/memory-lean.svg?color=8a6bff" alt="npm downloads"></a>
  <a href="https://github.com/zamansheikh/memory-lean/actions/workflows/test.yml"><img src="https://github.com/zamansheikh/memory-lean/actions/workflows/test.yml/badge.svg" alt="tests"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen.svg" alt="zero dependencies">
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg" alt="node 18 or newer">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#what-the-agent-sees">What the agent sees</a> ·
  <a href="#why-it-stays-lean">Why it stays lean</a> ·
  <a href="#tools">Tools</a> ·
  <a href="#teach-your-agent-to-use-it">Agent protocol</a> ·
  <a href="#settings">Settings</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

memory-lean is an [MCP](https://modelcontextprotocol.io) server that gives Claude
Code, Claude Desktop, Cursor and any other MCP client a knowledge graph that
persists between sessions. It is a drop-in replacement for the reference memory
server ([`@modelcontextprotocol/server-memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)):
same `memory.jsonl` file, same nine tool names. What changes is how much the tools
send back.

| Call, on a real graph of 237 entities | Reference server | memory-lean | |
|---|---:|---:|---:|
| `read_graph` | ~77,800 tokens | ~2,000 tokens | **40× smaller** |
| `search_nodes` (average of 5 common words) | ~31,000 tokens | ~770 tokens | **40× smaller** |

One file. No dependencies. Nothing to build.

## Quick start

**Claude Code**

```bash
claude mcp add --scope user memory -- npx -y memory-lean
```

**Claude Desktop, Cursor, Windsurf and other MCP clients**: add this to the
client's MCP config (`claude_desktop_config.json`, `.cursor/mcp.json`, …):

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "memory-lean"]
    }
  }
}
```

The graph is created on the first write at `~/.claude/memory-graph/memory.jsonl`.
Set `MEMORY_FILE_PATH` to keep it somewhere else.

Then [teach your agent to use it](#teach-your-agent-to-use-it). That step matters
as much as the install.

<details>
<summary>Install from a clone instead</summary>

```bash
git clone https://github.com/zamansheikh/memory-lean.git
claude mcp add --scope user memory -- node /absolute/path/to/memory-lean/server/memory-lean.mjs
```

No `npm install` is needed.
</details>

## What the agent sees

The reference server answers a search with every matching entity in full, as
pretty-printed JSON. memory-lean answers with a ranked list of names and the lines
that matched:

```text
> search_nodes { "query": "deploy" }

57 match "deploy", top 10 shown (narrow the query or raise limit). open_nodes for full entities.
- shop-backend [service] 12 obs, 6 rel
    › 2026-03-02: deployed 2.4.0 to production
    › deploy with scripts/release.sh, never by hand
- PENDING shop-backend 2.4.0 [pending] 2 obs, 3 rel
    › …mobile apps still call the old endpoint until the deploy of 2.4.0 reaches them
```

The agent then opens only what it needs:

```text
> open_nodes { "names": ["shop-backend"] }

## shop-backend [service]
- NestJS API behind api.example.com
- 2026-03-02: deployed 2.4.0 to production

## relations
shop-app -talks_to-> shop-backend
PENDING shop-backend 2.4.0 -blocks-> shop-app
```

That is the whole pattern: **search, then open.**

## Why it stays lean

A knowledge graph is only useful if the agent can afford to look at it, and a
graph that every session appends to grows without limit. memory-lean limits both
what it returns and what it stores.

| Limit | What it means |
|---|---|
| **Small answers** | `search_nodes` returns at most 10 names with snippets, `read_graph` returns an index of names, and only `open_nodes` returns full entities. |
| **Short facts** | An observation longer than 300 characters is rejected, with a message telling the agent to split it or put the detail in the repo. |
| **A cap per entity** | An entity keeps 15 observations. Past that, the oldest dated ones move to `archive/<entity>.md` next to the graph. Nothing is deleted, and undated observations (the identity facts) always stay. |
| **Multi-word search that works** | Every word must match somewhere in the entity, so adding a word narrows the result. The reference server looks for the query as one exact phrase. |

And it is careful with the file:

| Safeguard | What it means |
|---|---|
| **Safe to share** | Writers take a lock file, so several agent sessions can use one graph without overwriting each other. Every write replaces the file atomically. |
| **Daily backups** | A copy goes to `backups/` once a day; the last 7 are kept. |
| **Damaged lines are kept** | A line that cannot be read is moved to `memory.jsonl.unreadable` on the next write and reported, never silently dropped. |
| **Plain files** | The graph is JSON lines, archives are Markdown, backups are copies. You can read, grep and edit all of it by hand. |

### Measure it on your own graph

From a clone of this repo:

```bash
node tools/bench.mjs                  # read_graph + your five most common words
node tools/bench.mjs deploy "api v2"  # your own queries
```

It is read-only and prints sizes, never content. Tokens are estimated as
characters ÷ 4. A narrow search that matches one or two entities saves much less,
because there was little to trim.

## Tools

| Tool | What it returns |
|---|---|
| `search_nodes` | Ranked list of entity names with counts and up to two matching snippets each. Every word must match the name, type, an observation, or the type of a relation touching the entity. |
| `open_nodes` | The full entities you name, as compact text, with every relation touching them. Unknown names come back with "did you mean" suggestions. |
| `read_graph` | An index: entity names grouped by type, with observation counts. Never the observations. |
| `create_entities` | Creates entities; existing names are skipped. |
| `create_relations` | Creates relations between existing entities; duplicates are skipped. |
| `add_observations` | Adds facts to an entity, enforcing the length limit and the per-entity cap. |
| `delete_observations` | Removes observations by exact text. |
| `delete_relations` | Removes specific relations. |
| `delete_entities` | Removes entities and every relation touching them. |

The three read tools are marked read-only, so clients that support it can run them
without asking.

## Teach your agent to use it

A memory server only helps if the agent reads it before working and writes to it
when something changes. [`docs/AGENT-PROTOCOL.md`](docs/AGENT-PROTOCOL.md) is a
ready-made set of instructions: what to look up at the start of a task, what to
record, how to name things, and what never to store. Paste it into your
`CLAUDE.md`, `AGENTS.md` or system prompt and adjust the entity types to your work.

## Coming from the reference memory server

Point `MEMORY_FILE_PATH` at your existing `memory.jsonl` and swap the command. The
file format is identical, so you can switch back at any time. Existing
observations longer than 300 characters are kept as they are; only new writes are
checked.

To see what in an existing graph is over budget, and optionally fix it:

```bash
npx -y memory-lean --lint      # report only
npx -y memory-lean --compact   # back up, then move overflow to archive/
```

## Settings

All optional, set as environment variables on the server:

| Variable | Default | Meaning |
|---|---|---|
| `MEMORY_FILE_PATH` | `~/.claude/memory-graph/memory.jsonl` | Where the graph lives |
| `MEMORY_OBS_MAX_CHARS` | `300` | Longest observation accepted |
| `MEMORY_OBS_MAX` | `15` | Observations per entity before the oldest dated ones are archived |
| `MEMORY_SEARCH_LIMIT` | `10` | Default number of search results |
| `MEMORY_BACKUPS_KEPT` | `7` | Daily backups kept |

## Good to know

- **Your graph is private.** It holds whatever your agent learned about your
  projects. Keep it out of git, and never store passwords, keys or tokens in it:
  record where a secret lives, not its value.
- **Search is plain text matching**, not embeddings. Good entity names matter more
  than clever queries.

## Roadmap

- [ ] A Claude Code plugin that installs the server and the agent protocol together
- [ ] Ready-made protocol files for Cursor, Codex and other agents
- [ ] Windows in the CI matrix
- [ ] `rename_entity`, keeping relations intact

## Contributing

Ideas, bug reports and pull requests are welcome. The whole server is one file
with no dependencies, and `npm test` runs in about a second, so a first change is
quick to make. [CONTRIBUTING.md](CONTRIBUTING.md) has the layout, the ground rules
and a list of good first contributions.

If you try memory-lean on your own graph, the output of `tools/bench.mjs` makes a
useful issue post. And if it saves you tokens, a ⭐ helps other people find it.

## Support

memory-lean is free and MIT licensed. If it is useful to you, you can support the
work:

<p>
  <a href="https://www.buymeacoffee.com/zamansheikh"><img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black" alt="Buy Me a Coffee"></a>
  <a href="https://ko-fi.com/zamansheikh"><img src="https://img.shields.io/badge/Ko--fi-support-f16061?style=for-the-badge&logo=kofi&logoColor=white" alt="Ko-fi"></a>
</p>

## Author

Created and maintained by **[Zaman Sheikh](https://zamansheikh.com)** at
[Silifton](https://silifton.com).

<p>
  <a href="https://github.com/zamansheikh"><img src="https://img.shields.io/badge/GitHub-zamansheikh-0b0e17?logo=github&logoColor=white" alt="GitHub"></a>
  <a href="https://x.com/zamansheikh_404"><img src="https://img.shields.io/badge/X-zamansheikh__404-0b0e17?logo=x&logoColor=white" alt="X"></a>
  <a href="https://linkedin.com/in/zamansheikh"><img src="https://img.shields.io/badge/LinkedIn-zamansheikh-0b0e17?logo=linkedin&logoColor=4f8bff" alt="LinkedIn"></a>
  <a href="https://zamansheikh.com"><img src="https://img.shields.io/badge/Web-zamansheikh.com-0b0e17?logo=googlechrome&logoColor=4f8bff" alt="Website"></a>
</p>

Built on the file format and tool names of the
[Model Context Protocol reference memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory).

## License

[MIT](LICENSE) © 2026 [Zaman Sheikh](https://zamansheikh.com). Free to use, change
and share, including commercially; keep the copyright notice.
