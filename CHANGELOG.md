# Changelog

## 1.6.0

### Added

- `search_nodes` also searches archived facts. An entity whose only match is in
  its archive is named after the current matches, or shown with a snippet (up
  to three) when nothing current matches. A current match says how many more of
  its facts match in the archive. When the current matches already overflow the
  list, the archive costs one line.
- `replace_observation`: replaces one fact in place. The old fact is named by its
  exact text or by a part of it (8 or more characters) that no other fact of the
  entity contains, so the agent does not repeat a long fact to change it.
  `delete_observations` accepts such a part too, and reports what it matched.
- The server sends MCP `instructions` when it starts: four sentences on when to
  read the graph and what to record, for agents where the protocol was never
  installed. `MEMORY_INSTRUCTIONS=off` turns it off.
- `open_nodes` takes `related: true`: the rules and pending work a relation
  leads to come first, each introduced by its first fact, with `(+N more)` when
  it has others. A rule is often one fact, so a task starts with one call
  instead of two.
- A search that matches nothing names the terms found in no entity and the
  entities that hold the most terms, instead of a bare "No entities match".
- `open_nodes` opens a name that differs from an entity's only in case or
  separators. "Entity not found" on a write suggests the names that were
  probably meant; writes still never guess.
- The startup note names the entity that matches the folder the server was
  started in (or `CLAUDE_PROJECT_DIR`), so the agent knows what to open first.
- An entity is asked for one undated fact saying what it is: `create_entities`
  and `add_observations` say so when an entity has only dated facts (rules and
  pending work excepted), and `--lint` lists such entities. A search shows that
  fact for an entity matched by its name alone.
- `--lint` and the web UI overview report what needs tidying: pending work that
  blocks nothing or has no dated fact in 30 days, entities with no relations,
  names that differ only in case or separators, relations to an entity that does
  not exist, and archive files of no current entity. `create_entities` warns
  when a new name is a near-duplicate of an existing one.

### Changed

- Search ranking: a term found in the entity's name counts even when the other
  terms are elsewhere, and a fact holding every term counts for more than
  several facts holding one each.
- Search still matches any part of a word, but a term found as a whole word
  ranks above one found at the start of a longer word, and that above one found
  in the middle of a word.
- Search snippets: the facts shown are about the terms the entity's name does
  not already hold, a standing (undated) fact first, then the newest. A second
  fact is shown when it adds a term, and otherwise only for the top three
  matches.
- The write tools, the rejection message and the protocol give a target length
  for a fact: half the limit, 150 characters by default, and a write that goes
  over it says so in its answer. Told only the limit, agents wrote up to it, and
  overshot it now and then.
- `read_graph` has a budget (about 2,000 tokens). Past it, the types with the
  longest lists are given as a count; `entityType` lists one.
- The Claude Code plugin starts the server of its own version
  (`memory-lean@x.y.z`) instead of whichever one npx resolves, and its
  session-start reminder is two sentences now that the server sends the rest.
- The publish workflow pins `mcp-publisher` to a release, checks its SHA-256, and
  runs it in a separate job from the npm publish.

### Fixed

- Two entities whose names map to one archive file (`shop api` and `shop_api`,
  or `API` and `api` on macOS and Windows) no longer see, or restore, each
  other's archived facts. Sections belong to the entity named in their header.
- Renaming an entity so that only its case changes no longer deletes its archive
  on macOS and Windows.
- A deleted entity's archived facts are marked as deleted on disk and are no
  longer inherited by a later entity of the same name.
- Names, types and facts must be on one line; names and types must not start or
  end with a space, and a fact must not be empty. A multi-line fact was mangled
  in the archive and could not be restored; one already in a graph is now
  archived on one line. A name with a line break could forge a heading in
  `open_nodes` output.
- `initialize` answers a protocol version the server does not know with the
  newest one it speaks, instead of echoing the request.

## 1.5.0

### Added

- `--ui`: a web page to explore and edit the graph. Entities are grouped by type
  in non-overlapping bubbles; selecting one highlights its relations. Facts,
  names, types, relations and archived facts can all be edited, through the same
  checks the tools apply. Agent writes appear within two seconds. It listens on
  127.0.0.1 only and every API call needs the one-time key in the printed link.
- `--ui --demo` opens a throwaway copy of a made-up example graph
  (`examples/demo-memory.jsonl`).
- `/memory-ui` in the Claude Code plugin starts the web UI.

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
