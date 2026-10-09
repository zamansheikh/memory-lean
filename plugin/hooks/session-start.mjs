#!/usr/bin/env node
// Kept short on purpose: this is added to every session. The full protocol is the memory-graph skill.
const additionalContext = [
  "A knowledge graph of the user's projects lives in the `memory` MCP server (memory-lean).",
  "Before reading code for a task, call open_nodes with the exact names of the projects, packages and services it touches (search_nodes if you do not know the names).",
  "Record state changes (version bump, publish, deploy, config change, new service, rule learned from a failure) as short dated observations when they happen.",
  "Load the memory-graph skill for the full protocol before writing to the graph.",
].join(" ");
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
