# Changelog

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
