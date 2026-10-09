# Memory graph protocol

*Instructions for an AI coding agent. Paste this into `CLAUDE.md`, `AGENTS.md` or
your system prompt, and adjust the entity types and names to your own work.*

A knowledge graph of every project lives in the `memory` MCP server. It is the
cross-project memory: what depends on what, at which version, what is pending,
which rules apply. Narrative notes belong in the repo; the graph is for short
facts that other projects and later sessions need.

**At the start of any task**, before reading code: `open_nodes` on the exact names
of the projects, packages and services the task touches (entity names are
directory or package names, so you usually know them). Then `open_nodes` on the
`rule` and `pending` entities their relations point to. Treat an observation that
names a version, file, flag or command as a claim to re-verify against the repo,
not as truth.

**Querying**

- `open_nodes` with exact names returns full entities plus their relations;
  unknown names come back with "did you mean" suggestions.
- `search_nodes` returns a ranked list of at most 10 names with snippets, never
  full entities. All terms must match, so add terms to narrow it, then
  `open_nodes` on the names you need.
- `read_graph` returns only a name index grouped by type.

**Keep the graph small.** It is a fact index, not a work log.

- One fact per observation. Over 300 characters is rejected by the server.
- Above 15 observations the server moves the oldest dated ones to `archive/`
  (undated facts always stay), so delete stale
  or superseded facts yourself first (an old version number, a "left uncommitted"
  that is now committed) to choose what is kept.
- Archived facts are not lost: `archived_observations` lists them for an entity
  and can restore one. Look there when the history of a project matters.
- Update by replacing: delete the old fact, add the new one. Do not append
  "correction to the earlier observation".
- Session narratives, test transcripts, gap lists and roadmaps go in the repo
  (`docs/`, `TODO`), with the graph holding one observation that points to where.

**When the work changes state**, record it at once, not at the end.

- A version bump, publish, deploy, migration or config change: `add_observations`
  on that entity with the date, and `create_entities` a `PENDING <what> <version>`
  entity of type `pending` with a `blocks` relation to every consumer still to be
  updated.
- A consumer updated, built and verified: delete the matching `blocks` relation;
  delete the PENDING entity when none remain.
- A new project, service, device, key location or script: an entity with the right
  type and `part_of` / `depends_on` / `talks_to` relations.
- A rule learned from a failure: an entity of type `rule` with `applies_to`
  relations. One fact per observation; date it.

**Before saying a task is done**: `add_observations` for files left uncommitted,
tests not run, and anything promised but deferred. A task is not done while a
PENDING entity it created still has `blocks` relations, unless the user has said to
leave them.

**Never store secrets in the graph.** No admin keys, signing seeds, tokens or
passwords. Record where a secret lives, not its value.

**Naming**

- Repos by directory name (`shop-backend`), packages by published name.
- Rules as `RULE <topic>`, pending work as `PENDING <topic>`.
- Devices as `<model> (<serial>)`.
- Relations in the active voice: `depends_on`, `talks_to`, `part_of`, `blocks`,
  `applies_to`, `replaces`.
- Date every observation that can go stale: `2026-01-15: deployed 1.4.0`.
- A name turned out wrong or a project was renamed: `rename_entity`, which keeps
  the observations and relations. Do not delete and recreate.
