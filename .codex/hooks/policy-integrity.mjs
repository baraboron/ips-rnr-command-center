import { createHash } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { WORKSPACE_ROOT } from "./hook-utils.mjs";

const AGENTS_PATH = path.join(WORKSPACE_ROOT, "AGENTS.md");
const AGENTS_BASELINE_URL = new URL("./AGENTS.protected.md", import.meta.url);
const POLICY_LOCK_URL = new URL("./policy-lock.json", import.meta.url);

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function restoreProtectedAgents() {
  const baseline = await readFile(AGENTS_BASELINE_URL, "utf8");
  let current = "";
  try {
    current = await readFile(AGENTS_PATH, "utf8");
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
  }
  if (current === baseline) return false;

  const temporaryPath = `${AGENTS_PATH}.protected-${process.pid}`;
  await writeFile(temporaryPath, baseline, { encoding: "utf8", mode: 0o644 });
  await rename(temporaryPath, AGENTS_PATH);
  await chmod(AGENTS_PATH, 0o644);
  return true;
}

export async function policyIntegrityChecks() {
  const [baseline, current, lockText, envText] = await Promise.all([
    readFile(AGENTS_BASELINE_URL, "utf8"),
    readFile(AGENTS_PATH, "utf8").catch(() => ""),
    readFile(POLICY_LOCK_URL, "utf8"),
    readFile(path.join(WORKSPACE_ROOT, ".env"), "utf8").catch(() => ""),
  ]);
  const lock = JSON.parse(lockText);
  const env = parseEnv(envText);
  const token = env.get("TEAM_TELEMETRY_TOKEN") ?? "";
  const agentsValid = current === baseline;
  const fixedEnvValid = lock.schemaVersion === 1
    && env.get("TEAM_TELEMETRY_API_URL") === lock.apiUrl
    && Boolean(token)
    && sha256(token) === lock.teamTokenSha256;

  return [
    {
      id: "protected-agents",
      passed: agentsValid,
      message: agentsValid
        ? "AGENTS.md matches the protected policy baseline."
        : "AGENTS.md was changed outside the protected policy and must be restored.",
      files: ["AGENTS.md"],
    },
    {
      id: "fixed-workspace-env",
      passed: fixedEnvValid,
      message: fixedEnvValid
        ? "The fixed workspace telemetry endpoint and token match the protected policy lock."
        : "The fixed workspace telemetry endpoint or token is missing or was changed.",
      files: [".env"],
    },
  ];
}
