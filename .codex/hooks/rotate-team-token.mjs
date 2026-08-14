#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { WORKSPACE_ROOT } from "./hook-utils.mjs";

const EXCLUDED_DIRECTORIES = new Set([".codex", ".git", ".next", "build", "coverage", "dist", "node_modules", "out", "vendor"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseEnv(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
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
  return `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
}

function validateToken(rawToken) {
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  if (!token) throw new Error("A non-empty new team telemetry token is required.");
  if (token.length > 4_096 || /[\u0000-\u001f\u007f]/.test(token)) {
    throw new Error("The new team telemetry token contains unsupported characters or is too long.");
  }
  return token;
}

function promptHidden(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive token input requires a terminal. For automation, set NEW_TEAM_TELEMETRY_TOKEN in the process environment.");
  }
  return new Promise((resolve, reject) => {
    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const originalWrite = terminal._writeToOutput.bind(terminal);
    let muted = false;
    let settled = false;
    terminal._writeToOutput = (value) => {
      if (!muted) originalWrite(value);
    };
    terminal.once("SIGINT", () => {
      if (settled) return;
      settled = true;
      muted = false;
      originalWrite("\n");
      terminal.close();
      reject(new Error("Team token input was cancelled."));
    });
    terminal.question(question, (answer) => {
      if (settled) return;
      settled = true;
      muted = false;
      originalWrite("\n");
      terminal.close();
      resolve(answer);
    });
    muted = true;
  });
}

async function discoverEnvFiles(directory, depth = 0, found = []) {
  if (depth > 6) return found;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === ".env") {
      found.push(path.join(directory, entry.name));
      continue;
    }
    if (!entry.isDirectory() || EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    await discoverEnvFiles(path.join(directory, entry.name), depth + 1, found);
  }
  return found;
}

export async function rotateTeamToken({ workspaceRoot = WORKSPACE_ROOT, newToken: rawNewToken }) {
  const root = path.resolve(workspaceRoot);
  const newToken = validateToken(rawNewToken);
  const rootEnvPath = path.join(root, ".env");
  const lockPath = path.join(root, ".codex", "hooks", "policy-lock.json");
  const [rootEnvText, lockText] = await Promise.all([
    readFile(rootEnvPath, "utf8"),
    readFile(lockPath, "utf8"),
  ]);
  const rootEnv = parseEnv(rootEnvText);
  const lock = JSON.parse(lockText);
  const currentToken = rootEnv.get("TEAM_TELEMETRY_TOKEN")?.trim() ?? "";
  const currentApiUrl = rootEnv.get("TEAM_TELEMETRY_API_URL")?.trim() ?? "";
  if (lock.schemaVersion !== 1 || !currentToken || currentApiUrl !== lock.apiUrl || sha256(currentToken) !== lock.teamTokenSha256) {
    throw new Error("The current workspace endpoint/token does not match the protected policy lock; rotation was refused.");
  }
  if (newToken === currentToken) return { changed: false, updatedEnvFiles: 0 };

  const candidatePaths = [...new Set(await discoverEnvFiles(root))];
  const updates = [];
  for (const filename of candidatePaths) {
    const text = filename === rootEnvPath ? rootEnvText : await readFile(filename, "utf8");
    const values = parseEnv(text);
    if (values.get("TEAM_TELEMETRY_API_URL") !== lock.apiUrl || !values.has("TEAM_TELEMETRY_TOKEN")) continue;
    if (values.get("TEAM_TELEMETRY_TOKEN")?.trim() !== currentToken) {
      throw new Error(`A managed app environment has a different team token: ${path.relative(root, filename) || ".env"}`);
    }
    updates.push({ filename, text: upsertEnv(text, "TEAM_TELEMETRY_TOKEN", newToken) });
  }
  if (!updates.some((item) => item.filename === rootEnvPath)) throw new Error("The protected root .env was not discovered for rotation.");

  const staged = [];
  try {
    for (const update of updates) {
      const temporary = `${update.filename}.token-rotate-${process.pid}`;
      await writeFile(temporary, update.text, { encoding: "utf8", mode: 0o600 });
      staged.push({ temporary, destination: update.filename });
    }
    const lockTemporary = `${lockPath}.token-rotate-${process.pid}`;
    const nextLock = { ...lock, teamTokenSha256: sha256(newToken) };
    await writeFile(lockTemporary, `${JSON.stringify(nextLock, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    staged.push({ temporary: lockTemporary, destination: lockPath });

    for (const item of staged) {
      await rename(item.temporary, item.destination);
      await chmod(item.destination, 0o600);
    }
  } finally {
    await Promise.all(staged.map((item) => rm(item.temporary, { force: true }).catch(() => {})));
  }
  return { changed: true, updatedEnvFiles: updates.length };
}

async function main() {
  const supplied = process.env.NEW_TEAM_TELEMETRY_TOKEN?.trim();
  const newToken = supplied || await promptHidden("New team telemetry token: ");
  const result = await rotateTeamToken({ newToken });
  if (result.changed) {
    console.log(`Team telemetry token rotated in ${result.updatedEnvFiles} managed environment file(s). Secret values were not printed.`);
    console.log("Update the deployment platform secret separately before the next staging check.");
  } else {
    console.log("The supplied token already matches the protected workspace token; no files were changed.");
  }
}

async function isMainModule() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  const invokedPath = path.resolve(process.argv[1]);
  const [realModulePath, realInvokedPath] = await Promise.all([
    realpath(modulePath).catch(() => path.resolve(modulePath)),
    realpath(invokedPath).catch(() => invokedPath),
  ]);
  return realModulePath === realInvokedPath;
}

if (await isMainModule()) await main();
