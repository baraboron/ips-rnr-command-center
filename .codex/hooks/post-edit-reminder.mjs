#!/usr/bin/env node

import {
  hookCommand,
  isInsideWorkspace,
  readHookInput,
  WORKSPACE_ROOT,
  writeJson,
} from "./hook-utils.mjs";

const input = await readHookInput();
if (!isInsideWorkspace(input.cwd ?? WORKSPACE_ROOT)) process.exit(0);

const command = hookCommand(input);
const touchesServerBoundary = /(?:route\.[cm]?[jt]sx?|pages\/api|app\/api|server action|use server|\.server\.[cm]?[jt]sx?|express|fastify|hono|worker|openai|anthropic|@ai-sdk|generateText|streamText|responses\.create|messages\.create|chat\.completions\.create)/i.test(command);

if (touchesServerBoundary) {
  writeJson({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: "This edit appears to touch a server or AI boundary. Use $instrument-student-telemetry now, place the applicable event in this same boundary, update .student-telemetry-smoke.json for the real route/request/provider response, and run the protected verifier before stopping.",
    },
  });
}
