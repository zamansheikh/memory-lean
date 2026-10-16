<p align="center">
  <img src="https://raw.githubusercontent.com/zamansheikh/memory-lean/main/assets/icon.svg" width="104" height="104" alt="memory-lean icon">
</p>

<h1 align="center">memory-lean</h1>

<p align="center">
  <strong>Long-term memory for AI coding agents that doesn't burn the context window.</strong><br>
  A knowledge graph your agent searches cheaply, and a web UI where you can see and edit all of it.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/memory-lean"><img src="https://img.shields.io/npm/v/memory-lean.svg?color=4f8bff" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/memory-lean"><img src="https://img.shields.io/npm/dm/memory-lean.svg?color=8a6bff" alt="npm downloads"></a>
  <a href="https://github.com/zamansheikh/memory-lean/actions/workflows/test.yml"><img src="https://github.com/zamansheikh/memory-lean/actions/workflows/test.yml/badge.svg" alt="tests"></a>
  <a href="https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.zamansheikh/memory-lean"><img src="https://img.shields.io/badge/MCP%20registry-listed-2ec4b6.svg" alt="listed in the MCP registry"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen.svg" alt="zero dependencies">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#web-ui">Web UI</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#tools">Tools</a> ·
  <a href="docs/SETUP.md">Setup for 12 agents</a> ·
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/zamansheikh/memory-lean/main/assets/demo.gif" width="900" alt="A tour of the memory-lean web UI: hovering an entity, selecting one to highlight its relations, searching, editing a fact, and switching between the free layout and the layout grouped by type">
</p>

memory-lean is an [MCP](https://modelcontextprotocol.io) server that gives Claude
Code, Codex, Cursor, MiMo Code and any other MCP client a memory that lasts between
sessions: which projects exist, what depends on what, which version shipped, what
is still pending, and which rules were learned the hard way. It is a drop-in
replacement for the reference memory server
([`@modelcontextprotocol/server-memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)),
with the same file and tool names, but its answers are about 40 times smaller.

## Highlights

<table>
<tr>
<td width="50%" valign="top">

**About 40× smaller answers.** Search returns a ranked list of names and the lines
that matched, not every entity in full, so the agent can afford to check its
memory before every task.

</td>
<td width="50%" valign="top">

**A web UI for people.** See the whole graph grouped by type, follow relations,
and add, edit or delete anything. Agent writes show up live.

</td>
</tr>
<tr>
<td valign="top">

**Drop-in replacement.** Same `memory.jsonl` file and the same nine tools as the
reference server. Switch in, and switch back whenever you like.

</td>
<td valign="top">

**Works with every agent.** Copy-paste setup for Claude Code, MiMo Code, Codex,
Cursor, Copilot, Gemini CLI, Zed, JetBrains and more, plus the instructions that
teach the agent to use it.

</td>
</tr>
<tr>
<td valign="top">

**Stays small by itself.** Short facts, a cap per entity, and an archive for the
overflow, so the graph never grows into a wall of text.

</td>
<td valign="top">

**Private and safe.** Plain local files, daily backups, a write lock for parallel
sessions, and no network access. One server file, zero dependencies.

</td>
</tr>
</table>

## The numbers

Measured on a real graph of 237 entities, 355 relations and 1,160 facts
(tokens ≈ characters ÷ 4):

| Call | Reference server | memory-lean | |
|---|---:|---:|---:|
| `read_graph` | ~77,800 tokens | ~2,000 tokens | **40× smaller** |
| `search_nodes`, average of 5 common words | ~31,000 tokens | ~770 tokens | **40× smaller** |

A narrow search that matches one or two entities saves less, because there is
little to trim. To measure your own graph, run `node tools/bench.mjs` from a clone;
it is read-only and prints sizes, never content.

## Quick start

**Claude Code**: install the plugin. It adds the server, the instructions as a
skill, a short reminder at the start of each session, and `/memory-ui`.

```text
/plugin marketplace add zamansheikh/memory-lean
/plugin install memory-lean@memory-lean
```

**Any other agent**: add the server to its MCP config, then give it the instructions.

```json
{
  "mcpServers": {
    "memory": { "command": "npx", "args": ["-y", "memory-lean"] }
  }
}
```

```bash
npx -y memory-lean --protocol >> AGENTS.md   # into the rules file your agent reads
```

**Just looking?** Open the web UI on a made-up example graph:

```bash
npx -y memory-lean --ui --demo
```

<details>
<summary><b>Setup for each agent</b></summary>

<br>

| Agent | Server config | Instructions |
|---|---|---|
| [Claude Code](docs/SETUP.md#claude-code) | plugin | included in the plugin |
| [Xiaomi MiMo Code](docs/SETUP.md#xiaomi-mimo-code) | `mimocode.jsonc` | skill or `AGENTS.md` |
| [opencode](docs/SETUP.md#opencode) | `opencode.json` | `AGENTS.md` |
| [OpenAI Codex CLI](docs/SETUP.md#openai-codex-cli) | `codex mcp add` | `AGENTS.md` |
| [Cursor](docs/SETUP.md#cursor) | `.cursor/mcp.json` | `AGENTS.md` or a rule |
| [VS Code (Copilot)](docs/SETUP.md#vs-code-github-copilot) | `.vscode/mcp.json` | `copilot-instructions.md` |
| [Gemini CLI](docs/SETUP.md#gemini-cli) | `settings.json` | `GEMINI.md` |
| [Windsurf](docs/SETUP.md#windsurf) | `mcp_config.json` | a rule |
| [Cline](docs/SETUP.md#cline) | `cline_mcp_settings.json` | `.clinerules/` |
| [Zed](docs/SETUP.md#zed) | `settings.json` | `AGENTS.md` or `.rules` |
| [JetBrains IDEs](docs/SETUP.md#jetbrains-ides) | AI Assistant settings | a rule or guidelines |
| [Claude Desktop](docs/SETUP.md#claude-desktop) | `claude_desktop_config.json` | project instructions |

</details>

The graph is created on the first write at `~/.claude/memory-graph/memory.jsonl`,
whichever agent writes it, so all your agents share one memory. Set
`MEMORY_FILE_PATH` to keep it somewhere else.

## Web UI

```bash
npx -y memory-lean --ui
```

This opens your memory in the browser. Everything an agent can do, you can do here:

- **Explore.** Each type gets its own bubble. Click an entity to highlight
  everything it connects to, drag nodes to arrange them, and scroll to zoom.
  Search matches names, types and facts.
- **Edit.** Add, edit and delete facts, rename an entity or change its type, add
  and remove relations, create and delete entities, and restore archived facts.
  Every change passes the same checks as the agents' tools.
- **Watch.** Changes your agents make appear within two seconds.
- **Spot problems.** The overview lists pending work, the most connected
  entities, and anything over budget, which is also marked on the graph.

<table>
<tr>
<td width="50%"><img src="https://raw.githubusercontent.com/zamansheikh/memory-lean/main/assets/ui-entity.png" alt="An entity selected: its relations highlighted on the graph and listed in the side panel"></td>
<td width="50%"><img src="https://raw.githubusercontent.com/zamansheikh/memory-lean/main/assets/ui-search.png" alt="Searching for payments: matching entities stay bright, the rest fade"></td>
</tr>
<tr>
<td align="center"><sub><b>Follow the connections.</b> Select an entity to see its facts and relations.</sub></td>
<td align="center"><sub><b>Find anything.</b> Search names, types and facts at once.</sub></td>
</tr>
<tr>
<td width="50%"><img src="https://raw.githubusercontent.com/zamansheikh/memory-lean/main/assets/ui-edit.png" alt="Editing a fact in place, with a character counter"></td>
<td width="50%"><img src="https://raw.githubusercontent.com/zamansheikh/memory-lean/main/assets/ui-light.png" alt="The web UI in the light theme"></td>
</tr>
<tr>
<td align="center"><sub><b>Edit in place.</b> With the same 300-character limit the agents have.</sub></td>
<td align="center"><sub><b>Light or dark.</b> It follows your system, or pick one.</sub></td>
</tr>
</table>

The page runs on your machine only (`127.0.0.1`) and needs the one-time key in
the link it prints, so other websites cannot read or change your memory. Nothing
is uploaded anywhere.

## How it works

### Search, then open

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

## shop-backend [service] (3 archived)
- NestJS API behind api.example.com
- 2026-03-02: deployed 2.4.0 to production

## relations
shop-app -talks_to-> shop-backend
PENDING shop-backend 2.4.0 -blocks-> shop-app
```

### Why it stays lean

| Limit | What it means |
|---|---|
| **Small answers** | `search_nodes` returns at most 10 names with snippets, `read_graph` returns an index of names, and only `open_nodes` returns full entities. |
| **Short facts** | An observation longer than 300 characters is rejected, with a message telling the agent to split it or put the detail in the repo. |
| **A cap per entity** | An entity keeps 15 observations. Past that, the oldest dated ones move to `archive/<entity>.md`. Nothing is deleted: they can be listed and restored, and undated facts (the identity facts) always stay. |
| **Search that narrows** | Every word must match somewhere in the entity, so adding a word narrows the result. The reference server looks for the query as one exact phrase. |

### How it keeps your data safe

| Safeguard | What it means |
|---|---|
| **Safe to share** | Writers take a lock file, so several agent sessions can use one graph without overwriting each other. Every write replaces the file atomically. |
| **Daily backups** | A copy goes to `backups/` once a day; the last 7 are kept. |
| **Damaged lines are kept** | A line that cannot be read is moved to `memory.jsonl.unreadable` on the next write and reported, never silently dropped. |
| **Plain files** | The graph is JSON lines, archives are Markdown, backups are copies. You can read, grep and edit all of it by hand. |

## Tools

| Tool | What it returns |
|---|---|
| `search_nodes` | Ranked list of entity names with counts and up to two matching snippets each. Every word must match the name, type, an observation, or the type of a relation touching the entity. |
| `open_nodes` | The full entities you name, as compact text, with every relation touching them and their archive count. Unknown names come back with "did you mean" suggestions. |
| `read_graph` | An index: entity names grouped by type, with observation counts. Never the observations. |
| `create_entities` | Creates entities; existing names are skipped. |
| `create_relations` | Creates relations between existing entities; duplicates are skipped. |
| `add_observations` | Adds facts to an entity, enforcing the length limit and the per-entity cap. |
| `delete_observations` | Removes observations by exact text. |
| `delete_relations` | Removes specific relations. |
| `delete_entities` | Removes entities and every relation touching them. |
| `rename_entity` | Renames an entity, keeping its observations, relations and archive. *Not in the reference server.* |
| `archived_observations` | Lists what was archived for an entity, optionally filtered, and restores chosen facts. *Not in the reference server.* |

The three read tools are marked read-only, so clients that support it can run them
without asking.

## Command line

| Command | What it does |
|---|---|
| `memory-lean` | Runs the MCP server over stdio. This is what agents start. |
| `memory-lean --ui [port]` | Opens the web UI. `--no-open` only prints the link; `--demo` uses a throwaway copy of a made-up graph. |
| `memory-lean --protocol` | Prints the agent instructions, ready to append to `AGENTS.md`, `CLAUDE.md` or `GEMINI.md`. |
| `memory-lean --skill <dir>` | Writes the same instructions as an Agent Skill into `<dir>/memory-graph`. |
| `memory-lean --lint` | Reports what in the graph is over budget. Read-only. |
| `memory-lean --compact` | Backs up the graph, then moves overflow observations to the archive. |
| `memory-lean --version` | Prints the version. |

With npx, put `npx -y` in front: `npx -y memory-lean --ui`.

## Teach your agent to use it

A memory server only helps if the agent reads it before working and writes to it
when something changes. [`docs/AGENT-PROTOCOL.md`](docs/AGENT-PROTOCOL.md) is a
ready-made set of instructions: what to look up at the start of a task, what to
record, how to name things, and what never to store. The Claude Code plugin
includes it. For every other agent, one command installs it:

```bash
npx -y memory-lean --protocol >> AGENTS.md     # into a rules file: always on
npx -y memory-lean --skill .agents/skills      # as an Agent Skill: loaded when relevant
```

Adjust the entity types and names in it to your own work.

## Coming from the reference memory server

Point `MEMORY_FILE_PATH` at your existing `memory.jsonl` and swap the command. The
file format is identical, so you can switch back at any time. Existing
observations longer than 300 characters are kept as they are; only new writes are
checked. To see what is over budget, and optionally fix it:

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

## FAQ

<details>
<summary><b>Is my memory sent anywhere?</b></summary>

<br>No. The server reads and writes local files and makes no network requests. The
web UI listens on <code>127.0.0.1</code> only. Keep the graph out of git, and never
store passwords, keys or tokens in it: record where a secret lives, not its value.
</details>

<details>
<summary><b>Can several agents or sessions share one graph?</b></summary>

<br>Yes. Every write takes a lock, re-reads the file and replaces it atomically, so
parallel sessions (and the web UI) do not overwrite each other.
</details>

<details>
<summary><b>Why plain text search instead of embeddings?</b></summary>

<br>It needs no model, no index and no dependencies, and an agent's queries are
mostly names it already knows. Good entity names matter more than clever queries.
</details>

<details>
<summary><b>What happens to old facts?</b></summary>

<br>When an entity passes 15 facts, the oldest dated ones move to
<code>archive/&lt;entity&gt;.md</code> next to the graph. <code>archived_observations</code>,
or the Archive section in the web UI, lists and restores them.
</details>

## Roadmap

- [x] Claude Code plugin with the server, a skill and `/memory-ui`
- [x] Setup guides for 12 agents
- [x] `rename_entity` and archive restore
- [x] A web UI to explore and edit the graph
- [x] Listed in the official MCP registry
- [ ] Listed in the Claude Code plugin directory
- [ ] Search across the archived facts of every entity
- [ ] Undo in the web UI

## Contributing

Ideas, bug reports and pull requests are welcome. The server is one file with no
dependencies, the web UI is one HTML file, and `npm test` runs in a few seconds,
so a first change is quick to make. [CONTRIBUTING.md](CONTRIBUTING.md) has the
layout, the ground rules and a list of good first contributions.

If memory-lean saves you tokens, a ⭐ helps other people find it.

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
