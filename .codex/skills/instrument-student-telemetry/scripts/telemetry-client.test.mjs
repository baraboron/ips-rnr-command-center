import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const assetPath = path.join(scriptDirectory, "..", "assets", "telemetry.server.ts");
const environmentNames = [
  "TEAM_TELEMETRY_API_URL",
  "TEAM_TELEMETRY_TOKEN",
  "TEAM_TELEMETRY_APP_KEY",
  "TEAM_TELEMETRY_APP_NAME",
];

async function loadClient(t) {
  const source = `${(await readFile(assetPath, "utf8")).replace('import "server-only";', "")}
export {
  resolveEndpoint as __testResolveEndpoint,
  assertJsonAndSafePayload as __testAssertJsonAndSafePayload,
};`;
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "telemetry.server.ts",
    reportDiagnostics: true,
  });
  assert.deepEqual(output.diagnostics ?? [], []);

  const directory = await mkdtemp(path.join(tmpdir(), "telemetry-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modulePath = path.join(directory, "telemetry.server.mjs");
  await writeFile(modulePath, output.outputText);
  return import(`${pathToFileURL(modulePath).href}?test=${Date.now()}-${Math.random()}`);
}

function configureEnvironment(t) {
  const previous = new Map(environmentNames.map((name) => [name, process.env[name]]));
  process.env.TEAM_TELEMETRY_API_URL = "https://telemetry.invalid/api";
  process.env.TEAM_TELEMETRY_TOKEN = `wk_${"x".repeat(40)}`;
  process.env.TEAM_TELEMETRY_APP_KEY = "training-app";
  process.env.TEAM_TELEMETRY_APP_NAME = "Training app";
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test("client sends the three required metadata-only events", async (t) => {
  configureEnvironment(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 200 });
  };
  const client = await loadClient(t);

  await client.logAppOpen({ sessionRef: "session-01", source: "app_bootstrap" });
  await client.logUserAction({ action: "complete_primary_action", success: true });
  await client.logAiCall({
    provider: "openai",
    model: "luna",
    success: true,
    latencyMs: 25,
    inputTokens: 10,
    outputTokens: 4,
  });

  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.url === "https://telemetry.invalid/api/v1/records"));
  assert.ok(requests.every((request) => request.init.headers.Authorization === `Bearer ${process.env.TEAM_TELEMETRY_TOKEN}`));
  assert.ok(requests.every((request) => request.init.redirect === "error"));
  const events = requests.map((request) => JSON.parse(request.init.body).records[0]);
  assert.deepEqual(events.map((record) => record.event_type), ["app_open", "user_action", "ai_call"]);
  assert.equal(events[2].payload.input_tokens, 10);
  assert.equal(events[2].payload.output_tokens, 4);
  assert.equal(JSON.stringify(events).includes("prompt"), false);
  assert.equal(JSON.stringify(events).includes("response"), false);
});

test("client retries a transient failure with the same idempotency key", async (t) => {
  configureEnvironment(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(init.body);
    return new Response(null, {
      status: bodies.length === 1 ? 503 : 200,
      headers: { "Retry-After": "0" },
    });
  };
  const client = await loadClient(t);

  const result = await client.logUserAction({ action: "retry_test" });

  assert.equal(result.delivered, true);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  const firstRecord = JSON.parse(bodies[0]).records[0];
  const secondRecord = JSON.parse(bodies[1]).records[0];
  assert.equal(firstRecord.idempotency_key, secondRecord.idempotency_key);
});

test("client retries every 5xx status, including 501", async (t) => {
  configureEnvironment(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response(null, {
      status: attempts === 1 ? 501 : 200,
      headers: { "Retry-After": "0" },
    });
  };
  const client = await loadClient(t);

  const result = await client.logUserAction({ action: "retry_unlisted_5xx" });

  assert.equal(result.delivered, true);
  assert.equal(attempts, 2);
});

test("client drops a permanently rejected poison batch so later events can proceed", async (t) => {
  configureEnvironment(t);
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  });
  console.warn = () => {};
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(null, { status: bodies.length === 1 ? 422 : 200 });
  };
  const client = await loadClient(t);

  const rejected = await client.logUserAction({ action: "permanently_rejected" });
  assert.equal(rejected.delivered, false);
  assert.equal(rejected.queued, false);
  assert.equal(client.pendingTelemetryCount(), 0);

  const later = await client.logUserAction({ action: "later_valid_event" });
  assert.equal(later.delivered, true);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].records.length, 1);
  assert.equal(bodies[1].records.length, 1);
  assert.equal(bodies[0].records[0].payload.action, "permanently_rejected");
  assert.equal(bodies[1].records[0].payload.action, "later_valid_event");
  assert.notEqual(bodies[0].records[0].idempotency_key, bodies[1].records[0].idempotency_key);
});

test("client only accepts explicitly opaque pseudonymous user references", async (t) => {
  configureEnvironment(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response(null, { status: 200 });
  };
  const client = await loadClient(t);

  for (const unsafeUserRef of [
    "person@example.com",
    "JohnSmith",
    "01012345678",
    "홍길동",
    "usr_too-short",
  ]) {
    await assert.rejects(
      client.logAppOpen({ userRef: unsafeUserRef }),
      /pseudonymous/,
    );
  }
  assert.equal(called, false);

  await client.logAppOpen({ userRef: `anon_${"x".repeat(32)}` });
  assert.equal(called, true);
});

test("packaged ESM and CommonJS clients enforce the same user reference rule", async (t) => {
  configureEnvironment(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  };

  const directory = await mkdtemp(path.join(tmpdir(), "telemetry-packaged-clients-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  for (const extension of ["mjs", "cjs"]) {
    const source = await readFile(path.join(scriptDirectory, "..", "assets", `telemetry.server.${extension}`), "utf8");
    const modulePath = path.join(directory, `telemetry-${extension}.${extension}`);
    await writeFile(modulePath, source);
    const imported = await import(pathToFileURL(modulePath).href);
    const client = imported.logAppOpen ? imported : imported.default;

    await assert.rejects(
      client.logAppOpen({ userRef: "JohnSmith" }),
      /pseudonymous/,
    );
    await client.logAppOpen({ userRef: `usr_${"y".repeat(24)}` });
  }

  assert.equal(calls, 2);
});

test("client rejects unsafe endpoint URLs before sending a bearer credential", async (t) => {
  configureEnvironment(t);
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  });
  console.warn = () => {};
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  };

  const unsafeURLs = [
    "http://telemetry.example/api",
    "https://user:password@telemetry.example/api",
    "https://@telemetry.example/api",
    "https://telemetry.example/api?team=secret",
    "https://telemetry.example/api?",
    "https://telemetry.example/api#fragment",
    "https://telemetry.example/api#",
  ];
  for (const unsafeURL of unsafeURLs) {
    process.env.TEAM_TELEMETRY_API_URL = unsafeURL;
    const client = await loadClient(t);
    assert.throws(() => client.__testResolveEndpoint(unsafeURL), /TEAM_TELEMETRY_API_URL/);
    const result = await client.logAppOpen({ source: "url_security_test" });
    assert.equal(result.delivered, false);
  }
  assert.equal(calls, 0);
});

test("client permits plain HTTP only for localhost and loopback IPs", async (t) => {
  configureEnvironment(t);
  const client = await loadClient(t);
  assert.equal(
    client.__testResolveEndpoint("http://localhost:7071/api"),
    "http://localhost:7071/api/v1/records",
  );
  assert.equal(
    client.__testResolveEndpoint("http://127.0.0.1:7071/api"),
    "http://127.0.0.1:7071/api/v1/records",
  );
  assert.equal(
    client.__testResolveEndpoint("http://[::1]:7071/api"),
    "http://[::1]:7071/api/v1/records",
  );
  assert.throws(
    () => client.__testResolveEndpoint("http://localhost.example:7071/api"),
    /HTTPS/,
  );
  assert.throws(
    () => client.__testResolveEndpoint("http://127.0.0.999:7071/api"),
    /valid absolute URL|HTTPS/,
  );
});

test("payload guard normalizes and rejects camelCase sensitive keys", async (t) => {
  configureEnvironment(t);
  const client = await loadClient(t);
  for (const key of ["systemPrompt", "fullName", "userName", "firstName", "lastName", "accessToken", "errorMessage", "stackTrace"]) {
    assert.throws(
      () => client.__testAssertJsonAndSafePayload({ safe: { [key]: "secret" } }),
      new RegExp(key),
    );
  }
  assert.doesNotThrow(() => client.__testAssertJsonAndSafePayload({
    inputTokens: 12,
    output_tokens: 4,
    errorCode: "timeout",
    traceId: "trace-01",
  }));
});
