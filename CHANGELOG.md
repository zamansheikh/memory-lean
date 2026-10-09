# Changelog

## 1.4.1

- Releases are now published by a GitHub workflow (npm trusted publishing, then the MCP registry). No change to the server.

## 1.4.0

### Added

- `archived_observations`: lists what was archived for an entity, optionally
  filtered by a query, and restores chosen observations to the entity.
- `open_nodes` shows how many observations an entity has in the archive.
- `server.json` and `mcpName`, the metadata for the official MCP registry, with a
  workflow that publishes it.

## 1.3.0

### Added

- `rename_entity`: renames an entity and keeps its observations, relations and
  archive file. This is the one tool the reference server does not have.
- Setup guides for Cline, Zed and JetBrains IDEs (AI Assistant and Junie), and a
  note for starting the server on Windows.
- Windows in the CI matrix.

### Fixed

- The writer lock treats a lock file that Windows is still deleting as busy,
  instead of failing the write.

## 1.2.0

### Added

- A Claude Code plugin (`/plugin marketplace add zamansheikh/memory-lean`): the
  server, the protocol as a `memory-graph` skill, and a short session-start reminder.
- `--protocol` prints the agent instructions, ready to append to `AGENTS.md`,
  `CLAUDE.md`, `GEMINI.md` or any other rules file.
- `--skill <dir>` writes the same instructions as an Agent Skill.
- `docs/SETUP.md`: copy-paste setup for Claude Code, Xiaomi MiMo Code, opencode,
  Codex CLI, Cursor, VS Code, Gemini CLI, Windsurf and Claude Desktop.

## 1.1.1

- Project icon, reorganised README, author and funding details in the package. No change to the server.

## 1.1.0

### Fixed

- An entity created without an `entityType` no longer breaks every later search.
  Writes without a name or type are rejected, and such entities already in a file
  load with the type `unknown`.
- A line in the graph file that cannot be read is no longer deleted by the next
  write. It is moved to `memory.jsonl.unreadable` and the write reports it.
- Undated observations are never archived, as documented. An entity whose undated
  facts alone exceed the cap stays over it and says so.
- Entities with non-ASCII names no longer share one archive file.
- Two sessions writing at the same moment no longer lose one of the writes: writers
  take a lock file.
- Malformed tool arguments return a readable error.

### Added

- `--lint` and `--compact` on the server replace `tools/graph-compact.py`, with the
  same limits and settings the server enforces. Python is no longer needed.
- `search_nodes` also matches the type of a relation touching an entity, so a query
  like `blocks` finds pending work.
- The read tools are marked read-only (`readOnlyHint`).
- `tools/bench.mjs` measures answer sizes against the reference server.
- `--version`.

### Changed

- `open_nodes` over its size budget leaves out whole entities and names them,
  rather than cutting the output off before the relations.
- `--compact` follows the server's cap (15 observations per entity, `rule` entities
  included); the old script kept 10 dated observations and skipped rules.

## 1.0.0

First release.
