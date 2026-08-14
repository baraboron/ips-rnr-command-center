import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { formatHumanResult, inspectProject } from "./inspect-app.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(scriptDirectory, "inspect-app.mjs");

async function makeProject(t, files) {
  const root = await mkdtemp(path.join(tmpdir(), "telemetry-inspector-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents);
  }
  return root;
}

function framework(result, id) {
  const item = result.frameworks.find((candidate) => candidate.id === id);
  assert.ok(item, `framework was not detected: ${id}`);
  return item;
}

function aiIntegration(result, id) {
  const item = result.aiIntegrationHints.find((candidate) => candidate.id === id);
  assert.ok(item, `AI integration was not detected: ${id}`);
  return item;
}

async function fileSnapshot(root) {
  const snapshot = new Map();
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) snapshot.set(relativePath, await readFile(absolutePath, "utf8"));
      else snapshot.set(relativePath, `<${entry.isSymbolicLink() ? "symlink" : "other"}>`);
    }
  }
  await visit(root);
  return snapshot;
}

test("detects a Next.js server route and AI integration without returning source or secret values", async (t) => {
  const secretMarker = "CANARY_SECRET_MUST_NEVER_APPEAR_IN_OUTPUT_123456789";
  const root = await makeProject(t, {
    "package.json": JSON.stringify({
      dependencies: { next: "16.2.10", openai: "latest" },
      scripts: { private_note: secretMarker },
    }),
    "next.config.ts": "export default {};",
    "app/api/chat/route.ts": `import OpenAI from "openai";\nconst internal = "${secretMarker}";\nexport async function POST() { return Response.json({ ok: true }); }`,
    "app/page.tsx": `'use client';\nexport default function Page() { return <main>${secretMarker}</main>; }`,
    ".env.local": `TEAM_TELEMETRY_TOKEN=${secretMarker}\n`,
  });

  const before = await fileSnapshot(root);
  const result = await inspectProject(root);
  const after = await fileSnapshot(root);

  assert.deepEqual(after, before, "inspection must not modify the target project");
  assert.equal(result.readOnly, true);
  assert.equal(result.applicationType, "fullstack");
  assert.equal(result.primaryRuntime, "node");
  assert.equal(result.serverBoundary, "available");
  assert.deepEqual(result.serverEntryCandidates, ["app/api/chat/route.ts"]);
  assert.deepEqual(framework(result, "nextjs").evidenceFiles, ["app/api/chat/route.ts", "next.config.ts", "package.json"]);
  const openAiHint = aiIntegration(result, "openai");
  assert.deepEqual(openAiHint.evidenceFiles, ["app/api/chat/route.ts", "package.json"]);
  assert.deepEqual(openAiHint.evidenceTypes, ["package", "source"]);
  assert.equal(JSON.stringify(result).includes(secretMarker), false);
  assert.equal(JSON.stringify(result).includes(".env.local"), false);
});

test("does not treat a Next.js static export route as a runtime server boundary", async (t) => {
  const root = await makeProject(t, {
    "package.json": JSON.stringify({ dependencies: { next: "16.2.10" } }),
    "next.config.mjs": `export default { output: "export" };`,
    "app/data.json/route.ts": `export async function GET() { return Response.json({ ready: true }); }`,
  });

  const result = await inspectProject(root);
  framework(result, "nextjs");
  assert.equal(result.applicationType, "client-only");
  assert.equal(result.serverBoundary, "missing");
  assert.deepEqual(result.serverEntryCandidates, []);
  assert.deepEqual(result.nextStaticExportFiles, ["next.config.mjs"]);
  assert.ok(result.warnings.includes("next-static-export-no-runtime-server-boundary"));
  assert.match(formatHumanResult(result), /Next\.js static export config: next\.config\.mjs/);
});

test("does not infer a Vite server boundary from an unused Express dependency", async (t) => {
  const root = await makeProject(t, {
    "package.json": JSON.stringify({
      devDependencies: { vite: "latest", express: "latest" },
      dependencies: { react: "latest" },
    }),
    "vite.config.ts": `import { defineConfig } from "vite"; export default defineConfig({});`,
    "src/main.tsx": `export const App = () => <main>Hello</main>;`,
  });

  const result = await inspectProject(root);
  framework(result, "vite");
  framework(result, "express");
  assert.equal(result.applicationType, "client-only");
  assert.equal(result.serverBoundary, "missing");
  assert.deepEqual(result.serverEntryCandidates, []);
  assert.ok(result.warnings.includes("client-only-no-trustworthy-server-boundary"));
  assert.ok(result.warnings.includes("server-entry-not-detected"));
});

test("does not infer a server boundary from a client helper named api", async (t) => {
  const root = await makeProject(t, {
    "package.json": JSON.stringify({
      devDependencies: { vite: "latest" },
      dependencies: { react: "latest", express: "latest" },
    }),
    "vite.config.ts": `import { defineConfig } from "vite"; export default defineConfig({});`,
    "src/api/client.ts": `import type { Express } from "express"; export type ApiShape = Express;`,
    "src/main.tsx": `export const App = () => <main>Hello</main>;`,
  });

  const result = await inspectProject(root);
  assert.equal(result.applicationType, "client-only");
  assert.equal(result.serverBoundary, "missing");
  assert.deepEqual(result.serverEntryCandidates, []);
});

test("does not treat comment-only framework and provider examples as runtime evidence", async (t) => {
  const root = await makeProject(t, {
    "package.json": JSON.stringify({ devDependencies: { vite: "latest" } }),
    "vite.config.ts": `import { defineConfig } from "vite"; export default defineConfig({});`,
    "server.ts": `
// import express from "express"; express().listen(3000);
/* fetch("https://api.openai.com/v1/responses"); */
export const documentationOnly = true;
`,
  });

  const result = await inspectProject(root);
  assert.equal(result.serverBoundary, "missing");
  assert.deepEqual(result.serverEntryCandidates, []);
  assert.deepEqual(result.aiIntegrationHints, []);
});

test("warns that the bundled client is incompatible with a Next.js Edge route", async (t) => {
  const root = await makeProject(t, {
    "package.json": JSON.stringify({ dependencies: { next: "16.2.10" } }),
    "next.config.ts": `export default {};`,
    "app/api/run/route.ts": `
export const runtime: "edge" = "edge";
export async function POST() { return Response.json({ ready: true }); }
`,
  });

  const result = await inspectProject(root);
  assert.equal(result.applicationType, "fullstack");
  assert.equal(result.serverBoundary, "available");
  assert.deepEqual(result.serverEntryCandidates, ["app/api/run/route.ts"]);
  assert.deepEqual(result.nextEdgeRuntimeFiles, ["app/api/run/route.ts"]);
  assert.ok(result.warnings.includes("next-edge-runtime-incompatible-with-bundled-client"));
  assert.match(formatHumanResult(result), /Next\.js Edge runtime files: app\/api\/run\/route\.ts/);
});

test("detects common Node server frameworks and candidate entry files", async (t) => {
  const root = await makeProject(t, {
    "package.json": JSON.stringify({
      dependencies: {
        express: "latest",
        fastify: "latest",
        koa: "latest",
        "@hapi/hapi": "latest",
        "@nestjs/core": "latest",
        hono: "latest",
      },
    }),
    "src/express.ts": `import express from "express"; const app = express(); app.get("/", () => {});`,
    "src/server.ts": `import Fastify from "fastify"; const app = Fastify(); app.listen({ port: 3000 });`,
    "src/koa.ts": `import Koa from "koa"; const app = new Koa(); app.listen(3000);`,
    "src/hapi.ts": `import Hapi from "@hapi/hapi"; Hapi.server({ port: 3000 });`,
    "src/main.ts": `import { NestFactory } from "@nestjs/core"; NestFactory.create(class App {});`,
    "src/hono.ts": `import { Hono } from "hono"; const app = new Hono(); app.get("/", () => new Response());`,
  });

  const result = await inspectProject(root);
  for (const id of ["express", "fastify", "koa", "hapi", "nestjs", "hono"]) framework(result, id);
  assert.equal(result.applicationType, "server");
  assert.deepEqual(result.serverEntryCandidates, [
    "src/express.ts",
    "src/hono.ts",
    "src/koa.ts",
    "src/main.ts",
    "src/server.ts",
  ]);
});

test("classifies Vite without a backend as client-only and does not assume AI is absent", async (t) => {
  const root = await makeProject(t, {
    "package.json": JSON.stringify({ devDependencies: { vite: "latest" }, dependencies: { react: "latest" } }),
    "vite.config.ts": `import { defineConfig } from "vite"; export default defineConfig({});`,
    "src/main.tsx": `import React from "react"; export const App = () => <main>Hello</main>;`,
  });

  const result = await inspectProject(root);
  framework(result, "vite");
  assert.equal(result.applicationType, "client-only");
  assert.equal(result.serverBoundary, "missing");
  assert.deepEqual(result.serverEntryCandidates, []);
  assert.deepEqual(result.aiIntegrationHints, []);
  assert.ok(result.warnings.includes("client-only-no-trustworthy-server-boundary"));
  assert.ok(result.warnings.includes("ai-integration-not-detected-inspect-runtime-call-sites-before-declaring-not-applicable"));
  assert.match(formatHumanResult(result), /not detected; inspect runtime call sites before declaring N\/A/);
});

test("detects FastAPI and Flask entry points plus Python AI packages", async (t) => {
  const root = await makeProject(t, {
    "requirements.txt": "fastapi==0.116.0\nflask>=3.1\nopenai==2.0\ngoogle-genai>=1.0\n",
    "api/main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
    "legacy/app.py": "from flask import Flask\napp = Flask(__name__)\n",
  });

  const result = await inspectProject(root);
  framework(result, "fastapi");
  framework(result, "flask");
  aiIntegration(result, "openai");
  aiIntegration(result, "gemini");
  assert.equal(result.applicationType, "server");
  assert.equal(result.primaryRuntime, "python");
  assert.deepEqual(result.serverEntryCandidates, ["api/main.py", "legacy/app.py"]);
});

test("detects direct provider HTTP endpoints and labels endpoint evidence", async (t) => {
  const root = await makeProject(t, {
    "package.json": JSON.stringify({ dependencies: { express: "latest" } }),
    "src/providers.server.ts": `
const endpoints = [
  "https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent",
  "https://api.openai.com/v1/responses",
  "https://api.anthropic.com/v1/messages",
  "https://bedrock-runtime.us-east-1.amazonaws.com/model/example/invoke",
  "https://training-resource.openai.azure.com/openai/deployments/demo/chat/completions",
  "http://localhost:11434/api/chat",
  "https://api.mistral.ai/v1/chat/completions",
  "https://api.groq.com/openai/v1/chat/completions",
  "https://api.x.ai/v1/chat/completions",
  "https://us-central1-aiplatform.googleapis.com/v1/projects/example",
  "https://api.together.xyz/v1/chat/completions",
  "https://router.huggingface.co/v1/chat/completions",
];
export async function invoke() { return Promise.all(endpoints.map((url) => fetch(url))); }
`,
  });

  const result = await inspectProject(root);
  for (const id of [
    "gemini", "openai", "anthropic", "bedrock", "azure-openai", "ollama",
    "mistral", "groq", "xai", "vertex", "together", "huggingface",
  ]) {
    const hint = aiIntegration(result, id);
    assert.ok(hint.evidenceTypes.includes("endpoint"));
    assert.deepEqual(hint.evidence.find((item) => item.type === "endpoint")?.files, ["src/providers.server.ts"]);
  }
  assert.equal(result.warnings.some((warning) => warning.startsWith("ai-integration-not-detected")), false);
});

test("detects AI packages in variant Python requirements files", async (t) => {
  const root = await makeProject(t, {
    "requirements-dev.txt": "google-cloud-aiplatform==1.95.0\nhuggingface-hub>=0.32\n",
    "main.py": "print('worker')\n",
  });

  const result = await inspectProject(root);
  assert.ok(aiIntegration(result, "vertex").evidenceFiles.includes("requirements-dev.txt"));
  assert.ok(aiIntegration(result, "huggingface").evidenceFiles.includes("requirements-dev.txt"));
});

test("detects Go net/http and common Go routers", async (t) => {
  const root = await makeProject(t, {
    "go.mod": "module example.test/app\n\ngo 1.24\n\nrequire (\n github.com/gin-gonic/gin v1.10.0\n github.com/go-chi/chi/v5 v5.2.0\n)\n",
    "cmd/server/main.go": `package main\nimport "net/http"\nfunc main() { http.HandleFunc("/", func(http.ResponseWriter, *http.Request) {}); http.ListenAndServe(":8080", nil) }`,
    "internal/gin/server.go": `package ginserver\nimport "github.com/gin-gonic/gin"\nfunc server() { _ = gin.Default() }`,
    "internal/chi/server.go": `package chiserver\nimport "github.com/go-chi/chi/v5"\nfunc server() { _ = chi.NewRouter() }`,
    "internal/ai/client.go": `package ai\nimport "github.com/openai/openai-go"\n`,
  });

  const result = await inspectProject(root);
  framework(result, "go-http");
  framework(result, "go-gin");
  framework(result, "go-chi");
  aiIntegration(result, "openai");
  assert.equal(result.primaryRuntime, "go");
  assert.deepEqual(result.serverEntryCandidates, [
    "cmd/server/main.go",
    "internal/chi/server.go",
    "internal/gin/server.go",
  ]);
});

test("does not follow symlinks while inspecting", async (t) => {
  const outside = await mkdtemp(path.join(tmpdir(), "telemetry-inspector-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "server.ts"), `import express from "express"; express().listen(3000);`);
  const root = await makeProject(t, {
    "package.json": JSON.stringify({ devDependencies: { vite: "latest" } }),
    "src/main.ts": "document.body.textContent = 'safe';",
  });
  await symlink(outside, path.join(root, "linked-server"));

  const result = await inspectProject(root);
  assert.equal(result.applicationType, "client-only");
  assert.equal(result.frameworks.some((item) => item.id === "express"), false);
  assert.equal(JSON.stringify(result).includes("linked-server"), false);
});

test("CLI emits machine-readable JSON without source contents", async (t) => {
  const secretMarker = "PRIVATE_MODEL_PROMPT_DO_NOT_PRINT";
  const root = await makeProject(t, {
    "package.json": JSON.stringify({ dependencies: { express: "latest", "@anthropic-ai/sdk": "latest" } }),
    "server.ts": `import express from "express"; const prompt = "${secretMarker}"; express().listen(3000);`,
  });

  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, "--json", root]);
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  assert.equal(result.readOnly, true);
  framework(result, "express");
  aiIntegration(result, "anthropic");
  assert.deepEqual(result.serverEntryCandidates, ["server.ts"]);
  assert.equal(stdout.includes(secretMarker), false);
});

test("CLI human output contains classifications and paths, never file contents", async (t) => {
  const secretMarker = "SENSITIVE_SOURCE_TEXT_MUST_STAY_PRIVATE";
  const root = await makeProject(t, {
    "requirements.txt": "fastapi\n",
    "main.py": `from fastapi import FastAPI\nsecret = "${secretMarker}"\napp = FastAPI()\n`,
  });

  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, root]);
  assert.equal(stderr, "");
  assert.match(stdout, /Application inspection \(read-only\)/);
  assert.match(stdout, /FastAPI/);
  assert.match(stdout, /main\.py/);
  assert.match(stdout, /inspect runtime call sites before declaring N\/A/);
  assert.equal(stdout.includes(secretMarker), false);
});
