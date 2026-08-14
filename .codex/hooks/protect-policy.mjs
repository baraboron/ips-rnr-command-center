#!/usr/bin/env node

import path from "node:path";
import {
  canonicalPath,
  hookCommand,
  isInsideWorkspace,
  readHookInput,
  WORKSPACE_ROOT,
  writeJson,
} from "./hook-utils.mjs";

const PROTECTED_ROOT_FILES = new Set([
  "AGENTS.md",
  ".env",
  "STUDENT_APP_TELEMETRY_TEMPLATE.md",
]);

function normalizedTarget(rawTarget, cwd) {
  const cleaned = rawTarget.trim().replace(/^['"]|['"]$/g, "");
  return canonicalPath(path.resolve(cwd, cleaned));
}

function protectedTarget(rawTarget, cwd) {
  const absolute = normalizedTarget(rawTarget, cwd);
  if (!isInsideWorkspace(absolute)) return false;
  const relative = path.relative(WORKSPACE_ROOT, absolute).replaceAll(path.sep, "/");
  if (relative === ".codex" || relative.startsWith(".codex/")) return true;
  if (relative === "AGENTS.md" || relative === "STUDENT_APP_TELEMETRY_TEMPLATE.md") return true;
  const basename = path.basename(relative);
  return basename === ".env" || basename.startsWith(".env.");
}

function patchTargets(command) {
  const targets = [];
  const matcher = /^\*\*\* (?:Add|Update|Delete|Move to) File:\s*(.+?)\s*$/gm;
  let match;
  while ((match = matcher.exec(command)) !== null) targets.push(match[1]);
  return targets;
}

function appearsMutatingShell(command) {
  return /(?:^|[;&|]\s*|\s)(?:rm|mv|cp|chmod|chown|touch|truncate|install|unlink)(?=\s|$)|\bsed\b[^\n;&|]*\s-i(?:\s|$)|\bperl\b[^\n;&|]*\s-pi(?:\s|$)|\btee\b|(?:^|[^<])>{1,2}(?!=)|\bgit\s+(?:checkout|restore|clean|reset)\b|\b(?:node|python\d*|ruby)\b[^\n;&|]*(?:\s-e\s|\s-c\s)/i.test(command);
}

function mutatesProtectedPath(command) {
  const protectedPath = "(?:AGENTS\\.md|STUDENT_APP_TELEMETRY_TEMPLATE\\.md|\\.env(?:\\.[A-Za-z0-9_.-]+)?|\\.codex(?:/|\\b))";
  return new RegExp(`(?:\\b(?:rm|mv|cp|chmod|chown|touch|truncate|install|unlink)\\b[^\\n;&|]*${protectedPath}|\\b(?:sed|perl)\\b[^\\n;&|]*(?:-i|-pi)[^\\n;&|]*${protectedPath}|\\btee\\b[^\\n;&|]*${protectedPath}|>{1,2}\\s*['\"]?${protectedPath}|\\bgit\\s+(?:checkout|restore|clean|reset)\\b[^\\n;&|]*${protectedPath}|\\b(?:node|python\\d*|ruby)\\b[^\\n;&|]*(?:\\s-e\\s|\\s-c\\s)[^\\n;&|]*${protectedPath})`, "i").test(command);
}

function deny(reason) {
  writeJson({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

const input = await readHookInput();
const cwd = canonicalPath(input.cwd ?? WORKSPACE_ROOT);
if (!isInsideWorkspace(cwd)) process.exit(0);

const command = hookCommand(input);
if (input.tool_name === "Edit" || input.tool_name === "Write") {
  const directTarget = input.tool_input?.file_path ?? input.tool_input?.path ?? input.tool_input?.filename;
  if (typeof directTarget === "string" && protectedTarget(directTarget, cwd)) {
    deny(`Protected telemetry policy file cannot be edited: ${directTarget}`);
  }
} else if (input.tool_name === "apply_patch") {
  const target = patchTargets(command).find((candidate) => protectedTarget(candidate, cwd));
  if (target) deny(`Protected telemetry policy file cannot be edited: ${target}`);
} else if (input.tool_name === "Bash" && appearsMutatingShell(command) && mutatesProtectedPath(command)) {
  deny("Protected AGENTS, environment, or .codex telemetry policy files cannot be changed from the student workspace.");
}
