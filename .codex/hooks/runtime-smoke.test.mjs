import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runRuntimeSmoke, runtimeFailureSummary } from "./runtime-smoke.mjs";

function manifest({ actionEvents = [
  { event_type: "user_action", count: 1, payload: { action: "complete_action", success: true } },
], externalMocks = [] } = {}) {
  return {
    schema_version: 1,
    runtime: "node-http",
    entry: "server.mjs",
    probes: [
      {
        name: "bootstrap",
        method: "GET",
        path: "/api/bootstrap",
        expected_status: [200],
        expected_events: [{ event_type: "app_open", count: 1, payload: { source: "bootstrap" } }],
      },
      {
        name: "complete_action",
        method: "POST",
        path: "/api/action",
        body: { value: 1 },
        expected_status: [200],
        expected_events: actionEvents,
      },
    ],
    external_mocks: externalMocks,
  };
}

function serverSource(actionSource, failureStatus = 500) {
  return `import http from "node:http";

async function emit(event_type, payload) {
  await fetch(process.env.TEAM_TELEMETRY_API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ records: [{ event_type, payload }] }),
  });
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/api/bootstrap") {
    await emit("app_open", { source: "bootstrap" });
    return send(response, 200, { ok: true });
  }
  if (request.method === "POST" && request.url === "/api/action") {
    try {
      ${actionSource}
    } catch {
      return send(response, ${failureStatus}, { error: "action_failed" });
    }
  }
  return send(response, 404, { error: "not_found" });
}).listen(Number(process.env.PORT || 3000));
`;
}

async function withFixture(source, smokeManifest, callback) {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-smoke-test-"));
  try {
    await writeFile(path.join(root, "package.json"), '{"type":"module"}\n', "utf8");
    await writeFile(path.join(root, "server.mjs"), source, "utf8");
    if (smokeManifest) {
      await writeFile(path.join(root, ".student-telemetry-smoke.json"), `${JSON.stringify(smokeManifest, null, 2)}\n`, "utf8");
    }
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("passes successful function and exact telemetry paths without real network", async () => {
  const source = serverSource(`
      await emit("user_action", { action: "complete_action", success: true });
      return send(response, 200, { ok: true });
  `);
  await withFixture(source, manifest(), async (root) => {
    const result = await runRuntimeSmoke(root);
    assert.equal(result.passed, true);
    assert.deepEqual(result.probes.map((probe) => probe.status), [200, 200]);
    assert.deepEqual(result.blockedExternalRequests, []);
  });
});

test("catches the awaited callback-style fs mkdir defect as HTTP 500", async () => {
  const source = `import { mkdir } from "node:fs";\n${serverSource(`
      await mkdir("data", { recursive: true });
      await emit("user_action", { action: "complete_action", success: true });
      return send(response, 200, { ok: true });
  `)}`;
  await withFixture(source, manifest(), async (root) => {
    const result = await runRuntimeSmoke(root);
    assert.equal(result.passed, false);
    assert.match(runtimeFailureSummary(result), /received HTTP 500/);
  });
});

test("catches the nonexistent Object.has defect as HTTP 502", async () => {
  const source = serverSource(`
      const providerResponse = await fetch("https://ai.runtime-smoke.test/classify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 1 }),
      });
      const providerResult = await providerResponse.json();
      await emit("ai_call", { provider: "synthetic_ai", model: "classifier_v1", success: true });
      if (!Object.has(providerResult, "urgency")) throw new Error("invalid_provider_result");
      await emit("user_action", { action: "complete_action", success: true });
      return send(response, 200, { ok: true });
  `, 502);
  const smokeManifest = manifest({
    actionEvents: [
      { event_type: "ai_call", count: 1, payload: { provider: "synthetic_ai", model: "classifier_v1", success: true } },
      { event_type: "user_action", count: 1, payload: { action: "complete_action", success: true } },
    ],
    externalMocks: [{
      name: "classifier",
      method: "POST",
      url: "https://ai.runtime-smoke.test/classify",
      status: 200,
      json: { urgency: "normal" },
    }],
  });
  await withFixture(source, smokeManifest, async (root) => {
    const result = await runRuntimeSmoke(root, { requireAi: true });
    assert.equal(result.passed, false);
    assert.match(runtimeFailureSummary(result), /received HTTP 502/);
  });
});

test("catches an HTTP 200 action whose user_action event is missing", async () => {
  const source = serverSource(`return send(response, 200, { ok: true });`);
  await withFixture(source, manifest(), async (root) => {
    const result = await runRuntimeSmoke(root);
    assert.equal(result.passed, false);
    assert.match(runtimeFailureSummary(result), /Expected 1 matching user_action/);
  });
});

test("blocks undeclared external provider requests instead of contacting them", async () => {
  const source = serverSource(`
      await fetch("https://undeclared-provider.example/v1/generate", { method: "POST" });
      await emit("user_action", { action: "complete_action", success: true });
      return send(response, 200, { ok: true });
  `);
  await withFixture(source, manifest(), async (root) => {
    const result = await runRuntimeSmoke(root);
    assert.equal(result.passed, false);
    assert.equal(result.blockedExternalRequests.length, 1);
    assert.equal(result.blockedExternalRequests[0].url, "https://undeclared-provider.example/v1/generate");
  });
});

test("fails closed when the app-specific runtime manifest is missing", async () => {
  const source = serverSource(`return send(response, 200, { ok: true });`);
  await withFixture(source, null, async (root) => {
    const result = await runRuntimeSmoke(root);
    assert.equal(result.passed, false);
    assert.match(result.error, /is missing/);
  });
});
