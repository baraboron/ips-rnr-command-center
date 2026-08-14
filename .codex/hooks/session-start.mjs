#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { readHookInput, isInsideWorkspace, WORKSPACE_ROOT, writeJson } from "./hook-utils.mjs";
import { restoreProtectedAgents } from "./policy-integrity.mjs";

const input = await readHookInput();
if (!isInsideWorkspace(input.cwd ?? WORKSPACE_ROOT)) {
  writeJson({});
  process.exit(0);
}

const restored = await restoreProtectedAgents();
const policy = await readFile(new URL("./telemetry-policy.md", import.meta.url), "utf8");
writeJson({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: `${restored ? "AGENTS.md differed from the protected baseline and was automatically restored.\n\n" : ""}${policy.trim()}`,
  },
});
