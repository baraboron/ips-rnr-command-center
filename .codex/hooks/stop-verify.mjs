#!/usr/bin/env node

import { conciseError, readHookInput, writeJson } from "./hook-utils.mjs";
import { verifyWorkspace } from "./verify-workspace.mjs";
import { restoreProtectedAgents } from "./policy-integrity.mjs";

const input = await readHookInput();

try {
  const restored = await restoreProtectedAgents();
  const result = await verifyWorkspace();
  if (result.passed) {
    writeJson(restored ? { systemMessage: "AGENTS.md was changed and automatically restored from the protected baseline." } : {});
  } else {
    const failures = [
      ...result.policyChecks.filter((item) => !item.passed).map((item) => `workspace: ${item.id} — ${item.message}`),
      ...result.apps.flatMap((app) => app.checks
        .filter((item) => !item.passed)
        .map((item) => `${app.root}: ${item.id} — ${item.message}`)),
    ];
    const reason = [
      "Telemetry or isolated runtime verification failed. Use $instrument-student-telemetry, inspect the protected failure details, and repair the app before finishing:",
      ...failures.slice(0, 12).map((failure) => `- ${failure}`),
    ].join("\n");

    if (input.stop_hook_active) {
      writeJson({
        continue: false,
        stopReason: reason,
        systemMessage: reason,
      });
    } else {
      writeJson({ decision: "block", reason });
    }
  }
} catch (error) {
  const reason = `Protected telemetry and runtime verifier could not run: ${conciseError(error)}`;
  if (input.stop_hook_active) writeJson({ continue: false, stopReason: reason, systemMessage: reason });
  else writeJson({ decision: "block", reason });
}
