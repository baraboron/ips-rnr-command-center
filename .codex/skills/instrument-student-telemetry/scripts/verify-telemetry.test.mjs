import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { verifyProject } from "./verify-telemetry.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const clientSource = await readFile(path.join(scriptDirectory, "..", "assets", "telemetry.server.ts"), "utf8");
const mjsClientSource = await readFile(path.join(scriptDirectory, "..", "assets", "telemetry.server.mjs"), "utf8");

const callSitesSource = `
'use server';
import { logAiCall, logAppOpen, logUserAction } from "./telemetry.server";
export async function bootstrap() { await logAppOpen({ source: "home" }); }
export async function save() { await logUserAction({ action: "save" }); }
export async function callModel() {
  await logAiCall({ provider: "openai", model: "luna", success: true, latencyMs: 12 });
}
`;

async function makeProject(t, extras = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "telemetry-verifier-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { next: "test" } }));
  await writeFile(path.join(root, "src", "telemetry.server.ts"), clientSource);
  await writeFile(path.join(root, "src", "actions.ts"), callSitesSource);
  for (const [relativePath, contents] of Object.entries(extras)) {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents);
  }
  return root;
}

function findCheck(result, id) {
  const item = result.checks.find((candidate) => candidate.id === id);
  assert.ok(item, `missing check: ${id}`);
  return item;
}

test("accepts a server-only implementation with all required events", async (t) => {
  const root = await makeProject(t);
  const result = await verifyProject(root);
  assert.equal(
    result.passed,
    true,
    JSON.stringify(result.checks.filter((item) => !item.passed), null, 2),
  );
});

test("ignores protected .codex implementation and test files", async (t) => {
  const root = await makeProject(t, {
    ".codex/hooks/decoy.mjs": `
const token = process.env.NEXT_PUBLIC_TEAM_TELEMETRY_TOKEN;
fetch("/v1/records", { headers: { Authorization: "Bearer fake-protected-value" } });
await logAppOpen({ source: "protected-hook" });
`,
  });
  const result = await verifyProject(root);
  assert.equal(
    result.passed,
    true,
    JSON.stringify(result.checks.filter((item) => !item.passed), null, 2),
  );
});

test("rejects a public token and browser-side ingestion", async (t) => {
  const root = await makeProject(t, {
    "src/client.tsx": `'use client';\nconst token = process.env.NEXT_PUBLIC_TEAM_TELEMETRY_TOKEN;\nfetch("/v1/records");`,
  });
  const result = await verifyProject(root);
  assert.equal(findCheck(result, "no-public-secret").passed, false);
  assert.equal(findCheck(result, "server-boundary").passed, false);
});

test("rejects required call sites that exist only in a client module through aliased imports", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": `
/* a leading comment must not hide the client directive */
'use client';
import {
  logAppOpen as reportOpen,
  logUserAction as reportAction,
  logAiCall as reportModelCall,
} from "@/lib/observability";
export async function bootstrap() { await reportOpen({ source: "home" }); }
export async function save() { await reportAction({ action: "save" }); }
export async function callModel() {
  await reportModelCall({ provider: "openai", model: "luna", success: true });
}
`,
  });
  const result = await verifyProject(root);
  assert.equal(findCheck(result, "event-app_open").passed, false);
  assert.equal(findCheck(result, "event-user_action").passed, false);
  assert.equal(findCheck(result, "event-ai_call").passed, false);
  assert.equal(findCheck(result, "server-boundary").passed, false);
});

test("rejects a hardcoded bearer credential", async (t) => {
  const fakeCredential = "a".repeat(36);
  const root = await makeProject(t, {
    "src/leak.ts": `const headers = { Authorization: "Bearer ${fakeCredential}" };`,
  });
  const result = await verifyProject(root);
  assert.equal(findCheck(result, "no-hardcoded-secret").passed, false);
});

test("rejects a token pasted into agent instructions", async (t) => {
  const fakeCredential = "b".repeat(36);
  const root = await makeProject(t, {
    "AGENTS.md": `Never change TEAM_TELEMETRY_TOKEN = "${fakeCredential}"`,
  });
  const result = await verifyProject(root);
  assert.equal(findCheck(result, "no-hardcoded-secret").passed, false);
});

test("rejects a token-like assignment in a committed env-style file", async (t) => {
  const fakeCredential = `wk_${"c".repeat(40)}`;
  const root = await makeProject(t, {
    ".env.local": `TEAM_TELEMETRY_API_URL=https://telemetry.example/api\nTEAM_TELEMETRY_TOKEN=${fakeCredential}\n`,
  });
  const result = await verifyProject(root);
  const envCheck = findCheck(result, "no-env-secret");
  assert.equal(envCheck.passed, false);
  assert.deepEqual(envCheck.files, [".env.local"]);
  assert.equal(JSON.stringify(envCheck).includes(fakeCredential), false);
});

test("allows an empty token placeholder in an env example", async (t) => {
  const root = await makeProject(t, {
    ".env.example": "TEAM_TELEMETRY_API_URL=https://telemetry.example/api\nTEAM_TELEMETRY_TOKEN=\n",
  });
  const result = await verifyProject(root);
  assert.equal(findCheck(result, "no-env-secret").passed, true);
});

test("rejects obvious raw AI content fields", async (t) => {
  const root = await makeProject(t, {
    "src/bad-ai.ts": `async function unsafe() { await logAiCall({ provider: "x", model: "y", success: true, response: "raw model output" }); }`,
  });
  const result = await verifyProject(root);
  assert.equal(findCheck(result, "no-sensitive-ai-payload").passed, false);
});

test("rejects camelCase secrets and raw error fields in an aliased AI call", async (t) => {
  const root = await makeProject(t, {
    "src/bad-ai.ts": `
'use server';
import { logAiCall as reportModelCall } from "@/lib/observability";
async function unsafe() {
  await reportModelCall({
    provider: "x",
    model: "y",
    success: false,
    accessToken: "secret",
    errorMessage: "raw failure",
    stackTrace: "raw stack",
  });
}
`,
  });
  const result = await verifyProject(root);
  assert.equal(findCheck(result, "no-sensitive-ai-payload").passed, false);
});

test("accepts the exact no-runtime-AI declaration without inventing an ai_call", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": `
'use server';
import { logAppOpen, logUserAction } from "./telemetry.server";
export async function bootstrap() { await logAppOpen({ source: "app_bootstrap" }); }
export async function save() { await logUserAction({ action: "save_record" }); }
`,
    ".student-telemetry.json": JSON.stringify({
      schema_version: 1,
      ai_call: "not_applicable",
      reason: "no_runtime_ai",
    }),
  });
  const result = await verifyProject(root);
  assert.equal(findCheck(result, "event-ai_call").passed, true);
  assert.equal(findCheck(result, "ai-applicability").passed, true);
  assert.deepEqual(findCheck(result, "event-ai_call").files, [".student-telemetry.json"]);
});

test("rejects a no-AI declaration when a direct provider endpoint exists", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": `
'use server';
import { logAppOpen, logUserAction } from "./telemetry.server";
export async function bootstrap() { await logAppOpen({ source: "app_bootstrap" }); }
export async function run() { await logUserAction({ action: "generate_report" }); }
`,
    "src/provider.server.ts": `export async function generate() { return fetch("https://generativelanguage.googleapis.com/v1beta/models/example:generateContent"); }`,
    ".student-telemetry.json": JSON.stringify({
      schema_version: 1,
      ai_call: "not_applicable",
      reason: "no_runtime_ai",
    }),
  });
  const result = await verifyProject(root);
  const applicability = findCheck(result, "ai-applicability");
  assert.equal(applicability.passed, false);
  assert.ok(applicability.files.includes("src/provider.server.ts"));
  assert.equal(findCheck(result, "event-ai_call").passed, false);
});

test("rejects a no-AI declaration when an AI dependency manifest exists", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": `
'use server';
import { logAppOpen, logUserAction } from "./telemetry.server";
export async function bootstrap() { await logAppOpen({ source: "app_bootstrap" }); }
export async function run() { await logUserAction({ action: "run_report" }); }
`,
    "package.json": JSON.stringify({ dependencies: { openai: "latest" } }),
    ".student-telemetry.json": JSON.stringify({
      schema_version: 1,
      ai_call: "not_applicable",
      reason: "no_runtime_ai",
    }),
  });
  const result = await verifyProject(root);
  const applicability = findCheck(result, "ai-applicability");
  assert.equal(applicability.passed, false);
  assert.ok(applicability.files.includes("package.json"));
});

test("rejects a malformed applicability declaration", async (t) => {
  const root = await makeProject(t, {
    ".student-telemetry.json": JSON.stringify({ schema_version: 1, ai_call: "optional" }),
  });
  const result = await verifyProject(root);
  assert.equal(findCheck(result, "ai-applicability").passed, false);
});

test("recognizes Python telemetry calls at a server boundary", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": "export {};",
    "app.py": `
from fastapi import FastAPI
app = FastAPI()
@app.post("/bootstrap")
async def bootstrap():
    await telemetry.log_app_open(source="app_bootstrap")
@app.post("/save")
async def save():
    await telemetry.log_user_action(action="save_record")
@app.post("/model")
async def model_call():
    await telemetry.log_ai_call(provider="openai", model="model", success=True)
`,
  });
  const result = await verifyProject(root);
  for (const eventType of ["app_open", "user_action", "ai_call"]) {
    assert.deepEqual(findCheck(result, `event-${eventType}`).files, ["app.py"]);
  }
});

test("does not mistake Python logger definitions for event call sites", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": "export {};",
    "instrumentation.py": `
async def log_app_open(source): pass
async def log_user_action(action): pass
async def log_ai_call(provider, model, success): pass
`,
  });
  const result = await verifyProject(root);
  for (const eventType of ["app_open", "user_action", "ai_call"]) {
    assert.equal(findCheck(result, `event-${eventType}`).passed, false);
  }
});

test("recognizes Go telemetry calls at a server boundary", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": "export {};",
    "main.go": `
package main
import "net/http"
func handler(w http.ResponseWriter, r *http.Request) {
  client.LogAppOpen(ctx, "app_bootstrap")
  client.LogUserAction(ctx, "save_record")
  client.LogAICall(ctx, "openai", "model", true)
}
`,
  });
  const result = await verifyProject(root);
  for (const eventType of ["app_open", "user_action", "ai_call"]) {
    assert.deepEqual(findCheck(result, `event-${eventType}`).files, ["main.go"]);
  }
});

test("does not mistake Go method definitions for event call sites", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": "export {};",
    "instrumentation.go": `
package app
func (client *Client) LogAppOpen() {}
func (client *Client) LogUserAction() {}
func (client *Client) LogAICall() {}
`,
  });
  const result = await verifyProject(root);
  for (const eventType of ["app_open", "user_action", "ai_call"]) {
    assert.equal(findCheck(result, `event-${eventType}`).passed, false);
  }
});

test("recognizes a generic Express route as a proven Node server module", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": "export {};",
    "src/index.ts": `
import express from "express";
import { logAiCall, logAppOpen, logUserAction } from "./telemetry.server";
const app = express();
app.post("/run", async () => {
  await logAppOpen({ source: "app_bootstrap" });
  await logUserAction({ action: "run_job" });
  await logAiCall({ provider: "openai", model: "model", success: true });
});
`,
  });
  const result = await verifyProject(root);
  for (const eventType of ["app_open", "user_action", "ai_call"]) {
    assert.deepEqual(findCheck(result, `event-${eventType}`).files, ["src/index.ts"]);
  }
});

test("recognizes a Node server after JavaScript regex literals containing quotes and comment markers", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "telemetry-verifier-regex-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src", "lib", "server"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await writeFile(
    path.join(root, ".student-telemetry.json"),
    JSON.stringify({ schema_version: 1, ai_call: "not_applicable", reason: "no_runtime_ai" }),
  );
  await writeFile(path.join(root, "src", "lib", "server", "telemetry.server.mjs"), mjsClientSource);
  await writeFile(path.join(root, "server.mjs"), `
import http from "node:http";
import { logAppOpen, logUserAction } from "./src/lib/server/telemetry.server.mjs";

const quotedEdge = String.raw.replace(/^['"]|['"]$/g, "");
const slashOrStar = /[\\/*]/g;
const urlPattern = /https?:\\/\\/[^'"]+/g;
const ratio = 10 / 2;
void quotedEdge; void slashOrStar; void urlPattern; void ratio;

http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/api/bootstrap") {
    await logAppOpen({ source: "app_bootstrap" });
  }
  if (req.method === "POST" && req.url === "/api/actions") {
    await logUserAction({ action: "submit_action", success: true });
  }
  res.end("ok");
}).listen(8123);
`);

  const result = await verifyProject(root);
  assert.equal(
    result.passed,
    true,
    JSON.stringify(result.checks.filter((item) => !item.passed), null, 2),
  );
});

test("rejects fire-and-forget telemetry wrappers even when the wrapper awaits internally", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": `
'use server';
import { logAiCall, logAppOpen, logUserAction } from "./telemetry.server";
async function recordOpen(): Promise<void> {
  try { await logAppOpen({ source: "app_bootstrap" }); } catch {}
}
export async function bootstrap() {
  void recordOpen();
  await logUserAction({ action: "bootstrap" });
  await logAiCall({ provider: "openai", model: "model", success: true });
}
`,
  });
  const result = await verifyProject(root);
  const floating = findCheck(result, "no-floating-telemetry");
  assert.equal(floating.passed, false);
  assert.deepEqual(floating.files, ["src/actions.ts"]);
});

test("rejects detached Python and Go telemetry tasks", async (t) => {
  const root = await makeProject(t, {
    "detached.py": `asyncio.create_task(telemetry.log_app_open(source="bootstrap"))`,
    "detached.go": `package app\nfunc run() {\n  go client.LogUserAction(ctx, "save")\n}`,
  });
  const result = await verifyProject(root);
  const floating = findCheck(result, "no-floating-telemetry");
  assert.equal(floating.passed, false);
  assert.deepEqual(floating.files.sort(), ["detached.go", "detached.py"]);
});

test("does not accept Python browser or Go WASM call sites as trusted servers", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": "export {};",
    "browser.py": `
import pyodide
async def run():
    await telemetry.log_app_open(source="bootstrap")
    await telemetry.log_user_action(action="save")
    await telemetry.log_ai_call(provider="openai", model="model", success=True)
`,
    "browser.go": `
//go:build js && wasm
package app
import "syscall/js"
func run() {
  client.LogAppOpen(ctx, "bootstrap")
  client.LogUserAction(ctx, "save")
  client.LogAICall(ctx, "openai", "model", true)
}
`,
  });
  const result = await verifyProject(root);
  for (const eventType of ["app_open", "user_action", "ai_call"]) {
    assert.equal(findCheck(result, `event-${eventType}`).passed, false);
  }
  const boundary = findCheck(result, "server-boundary");
  assert.equal(boundary.passed, false);
  assert.deepEqual(boundary.files.sort(), ["browser.go", "browser.py", "src/telemetry.server.ts"]);
});

test("does not accept telemetry evidence that exists only in comments, strings, or regex literals", async (t) => {
  const decoys = `
"use server";
const documentation = "await logAppOpen(); await logUserAction(); await logAiCall(); process.env.TEAM_TELEMETRY_TOKEN /v1/records Authorization Bearer idempotency_key randomUUID MAX_ATTEMPTS retryable 408 425 429 status >= 500";
const expressionExamples = /await\\s+logAppOpen\\(\\)|await\\s+logUserAction\\(\\)|await\\s+logAiCall\\(\\)/g;
// await logAppOpen({});
// await logUserAction({});
// await logAiCall({});
// process.env.TEAM_TELEMETRY_TOKEN /v1/records Authorization Bearer
// idempotency_key randomUUID MAX_ATTEMPTS retryable 408 425 429 status >= 500
`;
  const root = await makeProject(t, {
    "src/actions.ts": decoys,
    "src/telemetry.server.ts": decoys,
  });
  const result = await verifyProject(root);
  for (const id of [
    "event-app_open",
    "event-user_action",
    "event-ai_call",
    "server-token-env",
    "ingest-endpoint",
    "bearer-auth",
    "idempotency",
    "bounded-retry",
  ]) {
    assert.equal(findCheck(result, id).passed, false, id);
  }
});

test("does not treat test-only telemetry and provider decoys as runtime call sites", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": `
"use server";
export async function bootstrap() { await logAppOpen({ source: "app" }); }
export async function save() { await logUserAction({ action: "save" }); }
`,
    "tests/provider.test.mjs": `
const endpoint = "https://api.openai.com/v1/responses";
await logAiCall({ prompt: "fixture" });
`,
    ".student-telemetry.json": JSON.stringify({
      schema_version: 1,
      ai_call: "not_applicable",
      reason: "no_runtime_ai",
    }),
  });

  const result = await verifyProject(root);
  assert.equal(findCheck(result, "event-ai_call").passed, true);
  assert.equal(findCheck(result, "ai-applicability").passed, true);
  assert.equal(findCheck(result, "server-boundary").passed, true);
  assert.equal(findCheck(result, "no-sensitive-ai-payload").passed, true);
});

test("does not treat a Vite src/api browser module as a trusted backend", async (t) => {
  const root = await makeProject(t, {
    "package.json": JSON.stringify({ devDependencies: { vite: "latest" } }),
    "src/actions.ts": "export {};",
    "src/api/telemetry.ts": `
const token = process.env.TEAM_TELEMETRY_TOKEN;
const endpoint = "https://telemetry.example/v1/records";
export async function run() {
  await logAppOpen({ source: "browser" });
  await logUserAction({ action: "save" });
  await logAiCall({ provider: "custom", model: "model", success: true });
  await fetch(endpoint, { headers: { Authorization: "Bearer " + token } });
}
`,
  });
  const result = await verifyProject(root);
  for (const eventType of ["app_open", "user_action", "ai_call"]) {
    assert.equal(findCheck(result, `event-${eventType}`).passed, false);
  }
  const boundary = findCheck(result, "server-boundary");
  assert.equal(boundary.passed, false);
  assert.ok(boundary.files.includes("src/api/telemetry.ts"));
});

test("does not trust a generic root api directory without executable server evidence", async (t) => {
  const root = await makeProject(t, {
    "package.json": JSON.stringify({ devDependencies: { vite: "latest" } }),
    "src/actions.ts": "export {};",
    "api/telemetry.ts": `
const token = process.env.TEAM_TELEMETRY_TOKEN;
export async function run() {
  await logAppOpen({ source: "browser_helper" });
  await logUserAction({ action: "save" });
  await logAiCall({ provider: "custom", model: "model", success: true });
  await fetch("https://telemetry.example/v1/records", {
    headers: { Authorization: "Bearer " + token },
  });
}
`,
  });

  const result = await verifyProject(root);
  for (const eventType of ["app_open", "user_action", "ai_call"]) {
    assert.equal(findCheck(result, `event-${eventType}`).passed, false);
  }
  assert.ok(findCheck(result, "server-boundary").files.includes("api/telemetry.ts"));
});

test("requires positive Python and Go server evidence", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": "export {};",
    "desktop.py": `
async def run():
    await telemetry.log_app_open(source="desktop")
    await telemetry.log_user_action(action="save")
    await telemetry.log_ai_call(provider="custom", model="model", success=True)
`,
    "desktop.go": `
package main
func run() {
  client.LogAppOpen(ctx, "desktop")
  client.LogUserAction(ctx, "save")
  client.LogAICall(ctx, "custom", "model", true)
}
`,
  });
  const result = await verifyProject(root);
  for (const eventType of ["app_open", "user_action", "ai_call"]) {
    assert.equal(findCheck(result, `event-${eventType}`).passed, false);
  }
  assert.deepEqual(findCheck(result, "server-boundary").files.sort(), ["desktop.go", "desktop.py", "src/telemetry.server.ts"]);
});

test("rejects unawaited Python telemetry coroutines in a real server handler", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": "export {};",
    "app.py": `
from fastapi import FastAPI
app = FastAPI()
@app.post("/run")
async def run():
    telemetry.log_app_open(source="bootstrap")
    telemetry.log_user_action(action="save")
    telemetry.log_ai_call(provider="custom", model="model", success=True)
`,
  });
  const result = await verifyProject(root);
  for (const eventType of ["app_open", "user_action", "ai_call"]) {
    assert.equal(findCheck(result, `event-${eventType}`).passed, false);
  }
  assert.equal(findCheck(result, "no-floating-telemetry").passed, false);
});

test("rejects telemetry inside an anonymous Go goroutine wrapper", async (t) => {
  const root = await makeProject(t, {
    "main.go": `
package main
import "net/http"
func handler(w http.ResponseWriter, r *http.Request) {
  go func() {
    client.LogAppOpen(ctx, "bootstrap")
    client.LogUserAction(ctx, "save")
    client.LogAICall(ctx, "custom", "model", true)
  }()
}
`,
  });
  const result = await verifyProject(root);
  assert.equal(findCheck(result, "no-floating-telemetry").passed, false);
  assert.ok(findCheck(result, "no-floating-telemetry").files.includes("main.go"));
});

test("rejects a no-AI declaration for an expanded direct provider endpoint", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": `
"use server";
export async function bootstrap() { await logAppOpen({ source: "app" }); }
export async function save() { await logUserAction({ action: "save" }); }
`,
    "src/model.server.ts": `export async function generate() { return fetch("https://api.mistral.ai/v1/chat/completions"); }`,
    ".student-telemetry.json": JSON.stringify({
      schema_version: 1,
      ai_call: "not_applicable",
      reason: "no_runtime_ai",
    }),
  });
  const result = await verifyProject(root);
  assert.equal(findCheck(result, "event-ai_call").passed, false);
  assert.equal(findCheck(result, "ai-applicability").passed, false);
  assert.ok(findCheck(result, "ai-applicability").files.includes("src/model.server.ts"));
});

test("rejects a no-AI declaration for expanded dependency manifests", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": `
"use server";
export async function bootstrap() { await logAppOpen({ source: "app" }); }
export async function save() { await logUserAction({ action: "save" }); }
`,
    "requirements.txt": "mistralai==1.2.3\n",
    ".student-telemetry.json": JSON.stringify({
      schema_version: 1,
      ai_call: "not_applicable",
      reason: "no_runtime_ai",
    }),
  });
  const result = await verifyProject(root);
  assert.equal(findCheck(result, "ai-applicability").passed, false);
  assert.ok(findCheck(result, "ai-applicability").files.includes("requirements.txt"));
});

test("recognizes variant Python requirement manifests and newer provider packages", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": `
"use server";
export async function bootstrap() { await logAppOpen({ source: "app" }); }
export async function save() { await logUserAction({ action: "save" }); }
`,
    "requirements-dev.txt": "google-cloud-aiplatform==1.95.0\n",
    ".student-telemetry.json": JSON.stringify({
      schema_version: 1,
      ai_call: "not_applicable",
      reason: "no_runtime_ai",
    }),
  });

  const result = await verifyProject(root);
  assert.equal(findCheck(result, "ai-applicability").passed, false);
  assert.ok(findCheck(result, "ai-applicability").files.includes("requirements-dev.txt"));
});

test("rejects quoted and runtime-forbidden keys passed through an AI payload variable", async (t) => {
  const root = await makeProject(t, {
    "src/bad-ai.ts": `
"use server";
async function unsafe(teamToken: string) {
  const payload = { ["team_token"]: teamToken, "prompt": "raw input" };
  await logAiCall(payload);
}
`,
  });
  const result = await verifyProject(root);
  assert.equal(findCheck(result, "no-sensitive-ai-payload").passed, false);
});

test("rejects sensitive fields in non-AI telemetry and spread payloads", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": `
"use server";
async function unsafe(userText: string) {
  const privateFields = { "form_value": userText };
  await logUserAction({ action: "submit_form", ...privateFields });
}
`,
  });

  const result = await verifyProject(root);
  assert.equal(findCheck(result, "no-sensitive-ai-payload").passed, false);
});

test("does not accept client-only Vite files merely because they use server-looking names", async (t) => {
  for (const relativePath of ["src/fake.server.ts", "server/events.ts"]) {
    const root = await makeProject(t, {
      "package.json": JSON.stringify({ devDependencies: { vite: "latest" } }),
      "src/actions.ts": "export {};",
      [relativePath]: `
import { logAiCall, logAppOpen, logUserAction } from "../src/telemetry.server";
export async function fakeBoundary() {
  await logAppOpen({ source: "fake" });
  await logUserAction({ action: "fake" });
  await logAiCall({ provider: "fake", model: "fake", success: true });
}
`,
    });
    const result = await verifyProject(root);
    assert.equal(result.passed, false, relativePath);
    assert.equal(findCheck(result, "event-app_open").passed, false, relativePath);
    assert.equal(findCheck(result, "cohesive-transport").passed, false, relativePath);
    assert.ok(findCheck(result, "server-boundary").files.includes(relativePath));
  }
});

test("rejects bare JavaScript and scheduled Python or Go telemetry wrappers", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": `
"use server";
import { logAiCall, logAppOpen, logUserAction } from "./telemetry.server";
async function recordAll() {
  await logAppOpen({ source: "app" });
  await logUserAction({ action: "run" });
  await logAiCall({ provider: "custom", model: "model", success: true });
}
export async function run() { recordAll(); }
`,
    "app.py": `
import asyncio
from fastapi import FastAPI
app = FastAPI()
async def record_all():
    await telemetry.log_app_open(source="app")
    await telemetry.log_user_action(action="run")
    await telemetry.log_ai_call(provider="custom", model="model", success=True)
@app.post("/run")
async def run():
    asyncio.create_task(record_all())
`,
    "main.go": `
package main
import "net/http"
func recordAll() {
  client.LogAppOpen(ctx, "app")
  client.LogUserAction(ctx, "run")
  client.LogAICall(ctx, "custom", "model", true)
}
func handler(w http.ResponseWriter, r *http.Request) { go recordAll() }
`,
  });

  const floating = findCheck(await verifyProject(root), "no-floating-telemetry");
  assert.equal(floating.passed, false);
  assert.deepEqual(floating.files.sort(), ["app.py", "main.go", "src/actions.ts"]);
});

test("rejects forbidden payload fields hidden behind an alias chain", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": `
"use server";
import { logAiCall, logAppOpen, logUserAction } from "./telemetry.server";
export async function run(raw: string) {
  await logAppOpen({ source: "app" });
  await logUserAction({ action: "run" });
  const privateFields = { prompt: raw };
  const payload = privateFields;
  await logAiCall(payload);
}
`,
  });
  assert.equal(findCheck(await verifyProject(root), "no-sensitive-ai-payload").passed, false);
});

test("rejects a no-AI declaration for a boto3 Bedrock call", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": `
"use server";
import { logAppOpen, logUserAction } from "./telemetry.server";
export async function bootstrap() { await logAppOpen({ source: "app" }); }
export async function run() { await logUserAction({ action: "run" }); }
`,
    "worker.py": `
import boto3
client = boto3.client("bedrock-runtime")
def generate(body): return client.invoke_model(body=body)
`,
    ".student-telemetry.json": JSON.stringify({
      schema_version: 1,
      ai_call: "not_applicable",
      reason: "no_runtime_ai",
    }),
  });
  const applicability = findCheck(await verifyProject(root), "ai-applicability");
  assert.equal(applicability.passed, false);
  assert.ok(applicability.files.includes("worker.py"));
});

test("rejects Node telemetry from a Next Edge Route Handler", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": "export {};",
    "app/api/run/route.ts": `
export const runtime = "edge";
import { logAiCall, logAppOpen, logUserAction } from "../../../src/telemetry.server";
export async function POST() {
  await logAppOpen({ source: "app" });
  await logUserAction({ action: "run" });
  await logAiCall({ provider: "custom", model: "model", success: true });
  return Response.json({ ok: true });
}
`,
  });
  const result = await verifyProject(root);
  assert.equal(findCheck(result, "event-app_open").passed, false);
  assert.equal(findCheck(result, "cohesive-transport").passed, false);
  assert.ok(findCheck(result, "server-boundary").files.includes("app/api/run/route.ts"));
});

test("rejects no-op loggers and disconnected transport markers", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": "export {};",
    "src/telemetry.server.ts": `
const token = process.env.TEAM_TELEMETRY_TOKEN;
const endpoint = "https://telemetry.example/v1/records";
const headers = { Authorization: "Bearer " + token };
const idempotency_key = crypto.randomUUID();
const MAX_ATTEMPTS = 3;
const retryable = [408, 425, 429];
const serverError = status >= 500;
`,
    "app/api/run/route.ts": `
async function logAppOpen() {}
async function logUserAction() {}
async function logAiCall() {}
export async function POST() {
  await logAppOpen();
  await logUserAction();
  await logAiCall();
  return Response.json({ ok: true });
}
`,
  });
  const result = await verifyProject(root);
  assert.equal(findCheck(result, "event-app_open").passed, false);
  assert.equal(findCheck(result, "event-user_action").passed, false);
  assert.equal(findCheck(result, "event-ai_call").passed, false);
  assert.equal(findCheck(result, "cohesive-transport").passed, false);
});

test("does not credit no-op loggers imported from a telemetry-like module name", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": "export {};",
    "app/api/run/fake-telemetry.ts": `
export async function logAppOpen() {}
export async function logUserAction() {}
export async function logAiCall() {}
`,
    "app/api/run/route.ts": `
import { logAiCall, logAppOpen, logUserAction } from "./fake-telemetry";
export async function POST() {
  await logAppOpen();
  await logUserAction();
  await logAiCall();
  return Response.json({ ok: true });
}
`,
  });

  const result = await verifyProject(root);
  assert.equal(result.passed, false);
  assert.equal(findCheck(result, "event-app_open").passed, false);
  assert.equal(findCheck(result, "event-user_action").passed, false);
  assert.equal(findCheck(result, "event-ai_call").passed, false);
  assert.equal(findCheck(result, "cohesive-transport").passed, true);
});

test("fails when an imported telemetry.server duplicate is not a cohesive adapter", async (t) => {
  const root = await makeProject(t, {
    "src/actions.ts": "export {};",
    "app/api/run/telemetry.server.ts": `
export async function logAppOpen() {}
export async function logUserAction() {}
export async function logAiCall() {}
`,
    "app/api/run/route.ts": `
import { logAiCall, logAppOpen, logUserAction } from "./telemetry.server";
export async function POST() {
  await logAppOpen();
  await logUserAction();
  await logAiCall();
  return Response.json({ ok: true });
}
`,
  });

  const result = await verifyProject(root);
  assert.equal(result.passed, false);
  assert.equal(findCheck(result, "cohesive-transport").passed, false);
  assert.ok(findCheck(result, "cohesive-transport").files.includes("app/api/run/telemetry.server.ts"));
});
