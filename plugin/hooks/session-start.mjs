#!/usr/bin/env node
// Kept short on purpose: this is added to every session. The server's own instructions say when
// to read the graph and what to record; this only points at the skill holding the full protocol.
const additionalContext = [
  "A knowledge graph of the user's projects lives in the `memory` MCP server (memory-lean); its instructions say when to read it and what to record.",
  "Load the memory-graph skill for the full protocol before writing to the graph.",
].join(" ");
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
