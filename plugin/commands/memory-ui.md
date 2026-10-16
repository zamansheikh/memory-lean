---
description: Open the memory-lean web UI to explore and edit the memory graph
---

Start the memory-lean web UI for the user's memory graph.

1. Run `npx -y memory-lean --ui` with the Bash tool in the background. It serves a page on 127.0.0.1 only and opens it in the browser.
2. Read its output and give the user the link it printed (it starts with `http://127.0.0.1:`). The part after `#` is a one-time key for this session; do not store it anywhere.
3. Tell the user the page updates live as agents write to the graph, and that stopping the background command closes it.

If the user asked to try it without their own data, add `--demo`, which opens a throwaway copy of a made-up example graph.
