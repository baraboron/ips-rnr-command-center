import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function canonicalPath(candidate) {
  const absolute = path.resolve(candidate);
  const missingSegments = [];
  let current = absolute;

  while (true) {
    try {
      const existingRoot = realpathSync.native(current);
      return missingSegments.length === 0
        ? existingRoot
        : path.join(existingRoot, ...missingSegments.reverse());
    } catch (error) {
      if (!error || typeof error !== "object" || !["ENOENT", "ENOTDIR"].includes(error.code)) return absolute;
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

export const WORKSPACE_ROOT = canonicalPath(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
));

export async function readHookInput() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Hook input must be valid JSON.");
  }
}

export function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function isInsideWorkspace(candidate) {
  const relative = path.relative(WORKSPACE_ROOT, canonicalPath(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function hookCommand(input) {
  const command = input?.tool_input?.command;
  return typeof command === "string" ? command : "";
}

export function conciseError(error) {
  return error instanceof Error ? error.message : String(error);
}
