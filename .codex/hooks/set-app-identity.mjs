#!/usr/bin/env node

import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { WORKSPACE_ROOT, isInsideWorkspace } from "./hook-utils.mjs";

const APP_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseEnv(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  return values;
}

function quoteEnv(value) {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : JSON.stringify(value);
}

function upsertEnv(text, name, value) {
  const line = `${name}=${quoteEnv(value)}`;
  const matcher = new RegExp(`^\\s*${name}\\s*=.*$`, "m");
  if (matcher.test(text)) return text.replace(matcher, line);
  const suffix = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  return `${text}${suffix}${line}\n`;
}

async function readExisting(filename) {
  try {
    return await readFile(filename, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return "";
    throw error;
  }
}

const appKey = argument("--app-key")?.trim();
const appName = argument("--app-name")?.trim();
const appRootArg = argument("--app-root") ?? ".";

if (!appKey || !APP_KEY_PATTERN.test(appKey)) {
  throw new Error("--app-key must be a stable 1-128 character slug using letters, numbers, dot, underscore, or hyphen.");
}
if (!appName || appName.length > 120 || /[\r\n]/.test(appName)) {
  throw new Error("--app-name must be a non-empty display name of at most 120 characters.");
}

const appRoot = path.resolve(WORKSPACE_ROOT, appRootArg);
if (!isInsideWorkspace(appRoot) || appRoot.includes(`${path.sep}.codex${path.sep}`)) {
  throw new Error("--app-root must be inside the student workspace and outside .codex.");
}
if (!(await stat(appRoot)).isDirectory()) throw new Error("--app-root must name an existing directory.");

const sourceText = await readFile(path.join(WORKSPACE_ROOT, ".env"), "utf8");
const source = parseEnv(sourceText);
const apiUrl = source.get("TEAM_TELEMETRY_API_URL")?.trim();
const teamToken = source.get("TEAM_TELEMETRY_TOKEN")?.trim();
if (!apiUrl || !teamToken) throw new Error("The protected workspace .env is missing the fixed telemetry API URL or team token.");

const targetPath = path.join(appRoot, ".env");
let targetText = await readExisting(targetPath);
const target = parseEnv(targetText);

for (const [name, expected] of [
  ["TEAM_TELEMETRY_API_URL", apiUrl],
  ["TEAM_TELEMETRY_TOKEN", teamToken],
]) {
  const existing = target.get(name)?.trim();
  if (existing && existing !== expected) throw new Error(`${name} is fixed and cannot be replaced.`);
  targetText = upsertEnv(targetText, name, expected);
}

for (const [name, requested] of [
  ["TEAM_TELEMETRY_APP_KEY", appKey],
  ["TEAM_TELEMETRY_APP_NAME", appName],
]) {
  const existing = target.get(name)?.trim();
  if (existing && existing !== requested) {
    throw new Error(`${name} is already set for this app and must remain stable.`);
  }
  targetText = upsertEnv(targetText, name, requested);
}

await mkdir(path.dirname(targetPath), { recursive: true });
const temporaryPath = `${targetPath}.tmp-${process.pid}`;
await writeFile(temporaryPath, targetText, { encoding: "utf8", mode: 0o600 });
await rename(temporaryPath, targetPath);
await chmod(targetPath, 0o600);
process.stdout.write(`Telemetry identity initialized for ${appKey} (${appName}). Secret values were not printed.\n`);
