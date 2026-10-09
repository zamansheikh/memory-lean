# Set up memory-lean with your agent

Every setup has the same two steps:

1. **Add the server**, so the agent has the memory tools.
2. **Give the agent the protocol**, so it reads the graph before working and
   writes to it when something changes. Without this step most agents ignore the
   tools.

The Claude Code and MiMo Code setups below were tested on real installs. The
others follow each tool's documented config format; if one is out of date, please
open an issue.

| Agent | Jump to |
|---|---|
| Claude Code | [plugin](#claude-code) |
| Xiaomi MiMo Code | [config + skill](#xiaomi-mimo-code) |
| opencode | [config + AGENTS.md](#opencode) |
| OpenAI Codex CLI | [config + AGENTS.md](#openai-codex-cli) |
| Cursor | [mcp.json + rule](#cursor) |
| VS Code (GitHub Copilot) | [mcp.json + instructions](#vs-code-github-copilot) |
| Gemini CLI | [settings + GEMINI.md](#gemini-cli) |
| Windsurf | [mcp_config.json + rule](#windsurf) |
| Claude Desktop | [config](#claude-desktop) |
| Anything else that speaks MCP | [generic](#any-other-mcp-client) |

## The two commands that do step 2

```bash
npx -y memory-lean --protocol >> AGENTS.md      # append the protocol to a rules file
npx -y memory-lean --skill .agents/skills       # or install it as an Agent Skill
```

`--protocol` prints the instructions from [AGENT-PROTOCOL.md](AGENT-PROTOCOL.md).
Append them to whatever file your agent always reads (`AGENTS.md`, `CLAUDE.md`,
`GEMINI.md`, …). The agent then follows them in every session.

`--skill <dir>` writes the same instructions to `<dir>/memory-graph/SKILL.md`, for
agents that support [Agent Skills](https://agentskills.io). A skill costs almost
no context until the agent decides to load it, but the agent has to decide. If you
want the graph consulted on every task, use the rules file.

The graph lives at `~/.claude/memory-graph/memory.jsonl` whichever agent writes to
it, so several agents can share one memory. Set `MEMORY_FILE_PATH` on the server
to keep it somewhere else.

---

## Claude Code

Install the plugin. It adds the server, the `memory-graph` skill, and a short
reminder at the start of each session:

```text
/plugin marketplace add zamansheikh/memory-lean
/plugin install memory-lean@memory-lean
```

Or from a terminal: `claude plugin marketplace add zamansheikh/memory-lean`, then
`claude plugin install memory-lean@memory-lean`.

<details>
<summary>Without the plugin</summary>

```bash
claude mcp add --scope user memory -- npx -y memory-lean
npx -y memory-lean --protocol >> ~/.claude/CLAUDE.md
```

Use one or the other. With both, Claude Code runs two copies of the server.
</details>

## Xiaomi MiMo Code

Tested with MiMo Code 0.1.15.

**1. Server.** Add this to `mimocode.jsonc` in your project, or to
`~/.config/mimocode/mimocode.jsonc` for every project:

```jsonc
{
  "$schema": "https://mimo.xiaomi.com/mimocode/config.json",
  "mcp": {
    "memory": {
      "type": "local",
      "command": ["npx", "-y", "memory-lean"],
      "enabled": true,
      "timeout": 20000
    }
  }
}
```

Check it with `mimo mcp list`; `memory` should show as connected. The longer
timeout covers the first start, when `npx` downloads the package.

**2. Protocol.** In your project:

```bash
npx -y memory-lean --skill .mimocode/skills     # as a skill, or
npx -y memory-lean --protocol >> AGENTS.md      # always on
```

`mimo debug skill` lists `memory-graph` once the skill is in place.

MiMo Code also loads MCP servers from Claude Code's config (`~/.claude.json`). If
you already added memory-lean to Claude Code at user scope, MiMo Code has it
without step 1; do not add it twice.

## opencode

**1. Server.** In `opencode.json` (project) or `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "memory": {
      "type": "local",
      "command": ["npx", "-y", "memory-lean"],
      "enabled": true
    }
  }
}
```

**2. Protocol.**

```bash
npx -y memory-lean --protocol >> AGENTS.md
```

## OpenAI Codex CLI

**1. Server.**

```bash
codex mcp add memory -- npx -y memory-lean
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.memory]
command = "npx"
args = ["-y", "memory-lean"]
```

**2. Protocol.**

```bash
npx -y memory-lean --protocol >> AGENTS.md            # this project
npx -y memory-lean --protocol >> ~/.codex/AGENTS.md   # every project
```

## Cursor

**1. Server.** In `.cursor/mcp.json` (project) or `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "memory": { "command": "npx", "args": ["-y", "memory-lean"] }
  }
}
```

**2. Protocol.** Cursor reads `AGENTS.md` in the project root:

```bash
npx -y memory-lean --protocol >> AGENTS.md
```

To make it a Cursor rule instead:

```bash
mkdir -p .cursor/rules
{ printf -- '---\ndescription: Memory graph protocol\nalwaysApply: true\n---\n\n'; npx -y memory-lean --protocol; } > .cursor/rules/memory-graph.mdc
```

## VS Code (GitHub Copilot)

**1. Server.** In `.vscode/mcp.json`:

```json
{
  "servers": {
    "memory": { "type": "stdio", "command": "npx", "args": ["-y", "memory-lean"] }
  }
}
```

**2. Protocol.**

```bash
mkdir -p .github
npx -y memory-lean --protocol >> .github/copilot-instructions.md
```

## Gemini CLI

**1. Server.** In `~/.gemini/settings.json` (or `.gemini/settings.json` in a project):

```json
{
  "mcpServers": {
    "memory": { "command": "npx", "args": ["-y", "memory-lean"] }
  }
}
```

**2. Protocol.**

```bash
npx -y memory-lean --protocol >> GEMINI.md
```

## Windsurf

**1. Server.** In `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "memory": { "command": "npx", "args": ["-y", "memory-lean"] }
  }
}
```

**2. Protocol.**

```bash
mkdir -p .windsurf/rules
npx -y memory-lean --protocol > .windsurf/rules/memory-graph.md
```

## Claude Desktop

**1. Server.** In `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "memory": { "command": "npx", "args": ["-y", "memory-lean"] }
  }
}
```

**2. Protocol.** Paste the output of `npx -y memory-lean --protocol` into a
project's custom instructions.

## Any other MCP client

The server speaks MCP over stdio. Wherever the client asks for a command:

```text
command: npx
args:    -y memory-lean
env:     MEMORY_FILE_PATH=/path/to/memory.jsonl   (optional)
```

Then put the output of `npx -y memory-lean --protocol` wherever the agent keeps
its standing instructions.

If you get memory-lean working with an agent that is not listed, a pull request
adding a section here is very welcome.
