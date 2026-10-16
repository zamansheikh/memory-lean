#!/usr/bin/env node
// Copies the version in package.json to the other places that carry it. `npm version` runs this
// (the "version" script), so `npm version minor && git push --follow-tags` is a whole release.
import fs from "node:fs";

const root = new URL("..", import.meta.url);
const { version } = JSON.parse(fs.readFileSync(new URL("package.json", root), "utf8"));
const edit = (file, change) => {
  const url = new URL(file, root), before = fs.readFileSync(url, "utf8"), after = change(before);
  if (after !== before) { fs.writeFileSync(url, after); console.log(`${file} -> ${version}`); }
};
edit("server/memory-lean.mjs", s => s.replace(/const VERSION = "[^"]+";/, `const VERSION = "${version}";`));
edit("plugin/.claude-plugin/plugin.json", s => s.replace(/"version": "[^"]+"/, `"version": "${version}"`));
edit("server.json", s => s.replace(/"version": "[^"]+"/g, `"version": "${version}"`));
