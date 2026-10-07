# memory-lean

A memory server for AI coding agents that doesn't burn your context window.

It is a drop-in replacement for the reference MCP memory server
([`@modelcontextprotocol/server-memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)):
same `memory.jsonl` file, same nine tool names. The difference is what the tools
send back. The reference server answers a search with every matching entity in
full, as pretty-printed JSON. This one answers with a short ranked list of names
and the matching lines, and the agent opens only the entities it needs.

One file, no dependencies, Node 18+.

## Why

A knowledge graph is only useful if the agent can afford to look at it. On a real
graph (229 entities, 349 relations, 1,119 observations), measured as characters ÷ 4:

| Call | Reference server | memory-lean | |
|---|---:|---:|---:|
| `read_graph` | ~75,000 tokens | ~1,900 tokens | 40× smaller |
| `search_nodes` (average of 8 everyday queries) | ~19,400 tokens | ~590 tokens | 33× smaller |

A search for a common word ("deploy", 57 matches) drops from ~32,500 tokens to ~860.
A narrow search that matches two entities saves much less (~990 → ~650), because
there was little to trim.

The graph also stays small on its own:

- An observation longer than **300 characters** is rejected, with a message telling
  the agent to split it or put the detail in the repo.
- An entity keeps at most **15 observations**. Past that, the oldest dated ones move
  to `archive/<entity>.md` next to the graph file. Nothing is deleted; undated
  observations (the identity facts) always stay.
- A copy of the graph is saved to `backups/` once a day, keeping the last 7.

## Install

```bash
git clone https://github.com/zamansheikh/memory-lean.git
```

No `npm install` is needed.

### Claude Code

```bash
claude mcp add --scope user memory \
  --env MEMORY_FILE_PATH="$HOME/.claude/memory-graph/memory.jsonl" \
  -- node /absolute/path/to/memory-lean/server/memory-lean.mjs
```

### Claude Desktop, Cursor, and other MCP clients

Add this to the client's MCP config (`claude_desktop_config.json`, `.cursor/mcp.json`, …):

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/absolute/path/to/memory-lean/server/memory-lean.mjs"],
      "env": { "MEMORY_FILE_PATH": "/absolute/path/to/memory.jsonl" }
    }
  }
}
```

The graph file and its folder are created on the first write.

### Coming from the reference memory server

Point `MEMORY_FILE_PATH` at your existing `memory.jsonl` and swap the command. The
file format is identical, so you can switch back at any time. Existing observations
longer than 300 characters are kept as they are; only new writes are checked. Run
`tools/graph-compact.py` once to see what is over budget.

## Tools

| Tool | What it returns |
|---|---|
| `search_nodes` | Ranked list of entity names with counts and up to two matching snippets each. Every word in the query must match. At most 10 results by default. |
| `open_nodes` | The full entities you name, as compact text, with every relation touching them. Unknown names come back with "did you mean" suggestions. |
| `read_graph` | An index: entity names grouped by type, with observation counts. Never the observations. |
| `create_entities` | Creates entities; existing names are skipped. |
| `create_relations` | Creates relations between existing entities; duplicates are skipped. |
| `add_observations` | Adds facts to an entity, enforcing the length limit and the per-entity cap. |
| `delete_observations` | Removes observations by exact text. |
| `delete_relations` | Removes specific relations. |
| `delete_entities` | Removes entities and every relation touching them. |

The intended pattern is **search, then open**: `search_nodes` to find the right
names cheaply, `open_nodes` on the two or three that matter.

## Teach your agent to use it

A memory server only helps if the agent reads it before working and writes to it
when something changes. [`docs/AGENT-PROTOCOL.md`](docs/AGENT-PROTOCOL.md) is a
ready-made set of instructions. Paste it into your `CLAUDE.md`, `AGENTS.md` or
system prompt and adjust the entity types to your work.

## Settings

All optional, set as environment variables on the server:

| Variable | Default | Meaning |
|---|---|---|
| `MEMORY_FILE_PATH` | `~/.claude/memory-graph/memory.jsonl` | Where the graph lives |
| `MEMORY_OBS_MAX_CHARS` | `300` | Longest observation accepted |
| `MEMORY_OBS_MAX` | `15` | Observations per entity before the oldest are archived |
| `MEMORY_SEARCH_LIMIT` | `10` | Default number of search results |
| `MEMORY_BACKUPS_KEPT` | `7` | Daily backups kept |

## Cleaning up an existing graph

```bash
python3 tools/graph-compact.py            # dry run: what is over budget
python3 tools/graph-compact.py --apply    # back up, then move overflow to archive/
```

It reads `MEMORY_FILE_PATH` too. Stop any agent session using the server before
`--apply`, because it rewrites the file.

## Good to know

- **Your graph is private.** It holds whatever your agent learned about your
  projects. Keep it out of git (this repo's `.gitignore` already excludes
  `*.jsonl`, `archive/` and `backups/`), and never store passwords, keys or tokens
  in it: record where a secret lives, not its value.
- **Several sessions can share one graph.** Each write reloads the file, changes it
  and replaces it atomically. Two writes landing in the same instant can still lose
  one of them; in practice agents write rarely enough that this does not come up.
- **Search is plain text matching**, not embeddings: every word must appear in the
  entity's name, type or observations. Good entity names matter more than clever
  queries.

## Tests

```bash
npm test
```

## License

MIT
