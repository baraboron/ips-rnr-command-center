#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyProject } from "../skills/instrument-student-telemetry/scripts/verify-telemetry.mjs";
import { WORKSPACE_ROOT } from "./hook-utils.mjs";
import { policyIntegrityChecks } from "./policy-integrity.mjs";
import { runRuntimeSmokeChild, runtimeFailureSummary } from "./runtime-smoke.mjs";

const APP_MANIFESTS = new Set(["package.json", "pyproject.toml", "go.mod"]);
const EXCLUDED = new Set([".codex", ".git", ".next", "build", "coverage", "dist", "node_modules", "out", "vendor"]);
const EXPECTED_ENDPOINT = "https://wonik90-telemetry-api.azurewebsites.net/api/v1/records";
const APP_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

async function exists(filename) {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

async function discoverAppRoots(root, directory = root, depth = 0, found = []) {
  if (depth > 4) return found;
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && APP_MANIFESTS.has(entry.name))) {
    found.push(directory);
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || EXCLUDED.has(entry.name) || entry.name.startsWith(".")) continue;
    await discoverAppRoots(root, path.join(directory, entry.name), depth + 1, found);
  }
  return found;
}

function parseEnv(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values.set(match[1], value.trim());
  }
  return values;
}

async function envCheck(appRoot, expectedTeamToken) {
  const envPath = path.join(appRoot, ".env");
  if (!(await exists(envPath))) {
    return { id: "fixed-app-env", passed: false, message: "App root .env is missing. Initialize it with the protected set-app-identity script.", files: [path.relative(WORKSPACE_ROOT, envPath)] };
  }
  const values = parseEnv(await readFile(envPath, "utf8"));
  const valid = values.get("TEAM_TELEMETRY_API_URL") === EXPECTED_ENDPOINT
    && Boolean(expectedTeamToken)
    && values.get("TEAM_TELEMETRY_TOKEN") === expectedTeamToken
    && APP_KEY_PATTERN.test(values.get("TEAM_TELEMETRY_APP_KEY") ?? "")
    && Boolean(values.get("TEAM_TELEMETRY_APP_NAME"))
    && (values.get("TEAM_TELEMETRY_APP_NAME")?.length ?? 0) <= 120;
  return {
    id: "fixed-app-env",
    passed: valid,
    message: valid
      ? "The app uses the protected workspace API/token and has a stable app identity."
      : "App .env must match the protected workspace API/token and contain a valid stable app key/name.",
    files: [path.relative(WORKSPACE_ROOT, envPath)],
  };
}

async function localEnvIsIgnored() {
  const gitignorePath = path.join(WORKSPACE_ROOT, ".gitignore");
  if (!(await exists(gitignorePath))) return false;
  const lines = (await readFile(gitignorePath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));
  return lines.some((line) => line === ".env" || line === ".env.*" || line === "**/.env" || line === "**/.env.*");
}

export async function verifyWorkspace(root = WORKSPACE_ROOT) {
  const appRoots = await discoverAppRoots(path.resolve(root));
  const allowFixedLocalEnv = await localEnvIsIgnored();
  const policyChecks = await policyIntegrityChecks();
  const workspaceEnv = parseEnv(await readFile(path.join(WORKSPACE_ROOT, ".env"), "utf8").catch(() => ""));
  const expectedTeamToken = workspaceEnv.get("TEAM_TELEMETRY_TOKEN") ?? "";
  const apps = [];

  for (const appRoot of appRoots) {
    const result = await verifyProject(appRoot);
    const envSecret = result.checks.find((item) => item.id === "no-env-secret");
    if (envSecret && !envSecret.passed && allowFixedLocalEnv && envSecret.files.every((filename) => path.basename(filename).startsWith(".env"))) {
      envSecret.passed = true;
      envSecret.message = "The fixed local token is allowed by workspace policy and excluded from Git.";
    }
    result.checks.push(await envCheck(appRoot, expectedTeamToken));
    const aiCheck = result.checks.find((item) => item.id === "event-ai_call");
    const aiRequired = !aiCheck?.message.includes("explicitly not applicable");
    const runtimeResult = await runRuntimeSmokeChild(appRoot, { requireAi: aiRequired });
    result.checks.push({
      id: "runtime-smoke",
      passed: runtimeResult.passed,
      message: runtimeResult.passed
        ? `Isolated runtime probes passed (${runtimeResult.probes.length} probe(s)); production telemetry and AI providers were not contacted.`
        : `Isolated runtime probes failed: ${runtimeFailureSummary(runtimeResult)}`,
      files: [path.relative(WORKSPACE_ROOT, path.join(appRoot, ".student-telemetry-smoke.json"))],
      runtime: runtimeResult,
    });
    result.passed = result.checks.every((item) => item.passed);
    apps.push({
      root: path.relative(WORKSPACE_ROOT, appRoot) || ".",
      passed: result.passed,
      checks: result.checks,
    });
  }

  return {
    workspaceRoot: path.resolve(root),
    appCount: apps.length,
    passed: policyChecks.every((item) => item.passed) && apps.every((app) => app.passed),
    policyChecks,
    apps,
    note: appRoots.length === 0
      ? "No student application manifest exists yet; telemetry verification is deferred until an app is created."
      : "Every discovered app must pass static telemetry checks and isolated runtime probes. A separate staging E2E check is still required before production training.",
  };
}

export function printHuman(result) {
  for (const item of result.policyChecks) {
    console.log(`${item.passed ? "PASS" : "FAIL"}  ${item.id}  ${item.message}`);
    for (const filename of item.files ?? []) console.log(`      ${filename}`);
  }
  if (result.appCount === 0) {
    console.log(`${result.passed ? "PASS" : "FAIL"}  workspace  ${result.note}`);
    return;
  }
  for (const app of result.apps) {
    console.log(`${app.passed ? "PASS" : "FAIL"}  app  ${app.root}`);
    for (const item of app.checks) {
      console.log(`  ${item.passed ? "PASS" : "FAIL"}  ${item.id}  ${item.message}`);
      for (const filename of item.files ?? []) console.log(`        ${filename}`);
    }
  }
  console.log(result.note);
}

async function main() {
  const json = process.argv.includes("--json");
  const result = await verifyWorkspace();
  if (json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  if (!result.passed) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) await main();
