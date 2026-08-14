#!/usr/bin/env node

import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MANIFEST_NAME = ".student-telemetry-smoke.json";
const EVENT_TYPES = new Set(["app_open", "user_action", "ai_call"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const COPY_EXCLUDED = new Set([
  ".codex",
  ".git",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "vendor",
]);
const SAFE_PAYLOAD_FIELDS = new Set([
  "action",
  "provider",
  "model",
  "source",
  "success",
  "error_code",
  "status",
]);
const COMMON_TEST_ENV = {
  NODE_ENV: "test",
  PORT: "0",
  TEAM_TELEMETRY_API_URL: "https://telemetry.runtime-smoke.invalid/api/v1/records",
  TEAM_TELEMETRY_TOKEN: "runtime-smoke-team-token",
  TEAM_TELEMETRY_APP_KEY: "runtime-smoke-app",
  TEAM_TELEMETRY_APP_NAME: "Runtime Smoke App",
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, location) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${location} contains unsupported field(s): ${unknown.join(", ")}.`);
}

function assertString(value, location, pattern = null, maximum = 200) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || (pattern && !pattern.test(value))) {
    throw new Error(`${location} is invalid.`);
  }
  return value;
}

function assertJsonSize(value, location, maximum = 100_000) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${location} must be JSON serializable.`);
  }
  if (encoded === undefined || Buffer.byteLength(encoded) > maximum) throw new Error(`${location} is too large.`);
}

function normalizeExpectedEvent(value, location) {
  if (!isObject(value)) throw new Error(`${location} must be an object.`);
  exactKeys(value, new Set(["event_type", "count", "payload"]), location);
  if (!EVENT_TYPES.has(value.event_type)) throw new Error(`${location}.event_type is invalid.`);
  const count = value.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error(`${location}.count must be an integer from 1 to 10.`);
  const payload = value.payload ?? {};
  if (!isObject(payload)) throw new Error(`${location}.payload must be an object.`);
  for (const [key, item] of Object.entries(payload)) {
    if (!SAFE_PAYLOAD_FIELDS.has(key)) throw new Error(`${location}.payload.${key} is not an allowed operational field.`);
    if (!["string", "number", "boolean"].includes(typeof item) || (typeof item === "string" && item.length > 100)) {
      throw new Error(`${location}.payload.${key} must be a short JSON primitive.`);
    }
  }
  return { event_type: value.event_type, count, payload };
}

function normalizeProbe(value, index) {
  const location = `probes[${index}]`;
  if (!isObject(value)) throw new Error(`${location} must be an object.`);
  exactKeys(value, new Set(["name", "method", "path", "headers", "body", "expected_status", "expected_events"]), location);
  const name = assertString(value.name, `${location}.name`, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
  const method = assertString(value.method, `${location}.method`).toUpperCase();
  if (!METHODS.has(method)) throw new Error(`${location}.method is unsupported.`);
  const requestPath = assertString(value.path, `${location}.path`, /^\//, 500);
  const parsedPath = new URL(requestPath, "http://runtime-smoke.local");
  if (parsedPath.origin !== "http://runtime-smoke.local" || parsedPath.hash) throw new Error(`${location}.path must be a same-origin path without a fragment.`);

  const headers = value.headers ?? {};
  if (!isObject(headers)) throw new Error(`${location}.headers must be an object.`);
  const normalizedHeaders = {};
  for (const [key, item] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (!/^[a-z0-9-]{1,80}$/.test(normalizedKey) || /authorization|cookie|token|secret|api-key/.test(normalizedKey)) {
      throw new Error(`${location}.headers contains a credential-like or invalid header name.`);
    }
    normalizedHeaders[normalizedKey] = assertString(item, `${location}.headers.${key}`, null, 300);
  }

  const body = value.body;
  if (body !== undefined) assertJsonSize(body, `${location}.body`);
  if (!Array.isArray(value.expected_status) || value.expected_status.length === 0 || value.expected_status.length > 10
    || value.expected_status.some((status) => !Number.isInteger(status) || status < 100 || status > 599)) {
    throw new Error(`${location}.expected_status must contain one to ten HTTP status codes.`);
  }
  if (!Array.isArray(value.expected_events) || value.expected_events.length === 0 || value.expected_events.length > 10) {
    throw new Error(`${location}.expected_events must contain one to ten event expectations.`);
  }
  return {
    name,
    method,
    path: `${parsedPath.pathname}${parsedPath.search}`,
    displayPath: parsedPath.pathname,
    headers: normalizedHeaders,
    body,
    expectedStatus: [...new Set(value.expected_status)],
    expectedEvents: value.expected_events.map((item, eventIndex) => normalizeExpectedEvent(item, `${location}.expected_events[${eventIndex}]`)),
  };
}

function normalizeExternalMock(value, index) {
  const location = `external_mocks[${index}]`;
  if (!isObject(value)) throw new Error(`${location} must be an object.`);
  exactKeys(value, new Set(["name", "method", "url", "status", "headers", "json"]), location);
  const name = assertString(value.name, `${location}.name`, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
  const method = assertString(value.method ?? "POST", `${location}.method`).toUpperCase();
  if (!METHODS.has(method)) throw new Error(`${location}.method is unsupported.`);
  const rawUrl = assertString(value.url, `${location}.url`, null, 1_000);
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${location}.url must be an absolute URL.`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.hash) {
    throw new Error(`${location}.url must be an HTTP(S) URL without credentials or a fragment.`);
  }
  const status = value.status ?? 200;
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error(`${location}.status is invalid.`);
  const headers = value.headers ?? { "content-type": "application/json" };
  if (!isObject(headers)) throw new Error(`${location}.headers must be an object.`);
  const normalizedHeaders = {};
  for (const [key, item] of Object.entries(headers)) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(key)) throw new Error(`${location}.headers contains an invalid name.`);
    normalizedHeaders[key] = assertString(item, `${location}.headers.${key}`, null, 300);
  }
  assertJsonSize(value.json, `${location}.json`);
  return { name, method, url: url.toString(), status, headers: normalizedHeaders, json: value.json };
}

export function validateManifest(value, { requireAi = false } = {}) {
  if (!isObject(value)) throw new Error("Runtime smoke manifest must be a JSON object.");
  exactKeys(value, new Set(["schema_version", "runtime", "entry", "required_env", "probes", "external_mocks"]), "manifest");
  if (value.schema_version !== 1) throw new Error("manifest.schema_version must equal 1.");
  if (value.runtime !== "node-http") throw new Error("manifest.runtime must equal node-http for this protected POC runner.");
  const entry = assertString(value.entry, "manifest.entry", /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,299}$/i, 300);
  if (path.isAbsolute(entry) || entry.split("/").includes("..") || !/\.(?:cjs|mjs|js)$/i.test(entry)) {
    throw new Error("manifest.entry must be a relative Node JavaScript entry path inside the app.");
  }
  if (!Array.isArray(value.probes) || value.probes.length === 0 || value.probes.length > 30) {
    throw new Error("manifest.probes must contain one to thirty probes.");
  }
  const requiredEnv = value.required_env ?? [];
  if (!Array.isArray(requiredEnv) || requiredEnv.length > 20
    || requiredEnv.some((name) => typeof name !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(name)
      || name.startsWith("TEAM_TELEMETRY_") || new Set(["PATH", "HOME", "TMPDIR", "NODE_OPTIONS"]).has(name))) {
    throw new Error("manifest.required_env must contain only safe application variable names; telemetry and process variables are managed by the runner.");
  }
  const probes = value.probes.map(normalizeProbe);
  if (new Set(probes.map((probe) => probe.name)).size !== probes.length) throw new Error("Probe names must be unique.");
  const declaredMocks = value.external_mocks ?? [];
  if (!Array.isArray(declaredMocks)) throw new Error("manifest.external_mocks must be an array.");
  const externalMocks = declaredMocks.map(normalizeExternalMock);
  if (externalMocks.length > 20) throw new Error("manifest.external_mocks may contain at most twenty mocks.");
  if (new Set(externalMocks.map((mock) => `${mock.method} ${mock.url}`)).size !== externalMocks.length) {
    throw new Error("External mock method and URL pairs must be unique.");
  }
  const coveredTypes = new Set(probes.flatMap((probe) => probe.expectedEvents.map((event) => event.event_type)));
  const requiredTypes = requireAi ? ["app_open", "user_action", "ai_call"] : ["app_open", "user_action"];
  const missingTypes = requiredTypes.filter((eventType) => !coveredTypes.has(eventType));
  if (missingTypes.length > 0) throw new Error(`Runtime probes do not cover required event type(s): ${missingTypes.join(", ")}.`);
  return { schemaVersion: 1, runtime: value.runtime, entry, requiredEnv: [...new Set(requiredEnv)], probes, externalMocks };
}

async function exists(filename) {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

async function copyApp(sourceRoot, targetRoot) {
  await cp(sourceRoot, targetRoot, {
    recursive: true,
    async filter(source) {
      const relative = path.relative(sourceRoot, source);
      if (!relative) return true;
      const parts = relative.split(path.sep);
      const basename = parts.at(-1);
      if (COPY_EXCLUDED.has(parts[0])) return false;
      if (basename === ".env" || basename?.startsWith(".env.")) return false;
      if ((await lstat(source)).isSymbolicLink()) return false;
      return true;
    },
  });
  const sourceModules = path.join(sourceRoot, "node_modules");
  if (await exists(sourceModules)) await symlink(sourceModules, path.join(targetRoot, "node_modules"), "dir");
}

function safeEnvironment(temporaryRoot, requiredEnv = []) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    TMPDIR: temporaryRoot,
    HOME: temporaryRoot,
    ...COMMON_TEST_ENV,
    ...Object.fromEntries(requiredEnv.map((name) => [name, "runtime-smoke-placeholder"])),
  };
}

function sanitizedEnvText(requiredEnv) {
  const values = {
    ...COMMON_TEST_ENV,
    ...Object.fromEntries(requiredEnv.map((name) => [name, "runtime-smoke-placeholder"])),
  };
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

function sanitizedUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid-url";
  }
}

async function bodyText(input, init) {
  if (init?.body !== undefined) {
    if (typeof init.body === "string") return init.body;
    if (Buffer.isBuffer(init.body)) return init.body.toString("utf8");
    if (ArrayBuffer.isView(init.body)) return Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength).toString("utf8");
    if (init.body instanceof ArrayBuffer) return Buffer.from(init.body).toString("utf8");
  }
  if (typeof Request !== "undefined" && input instanceof Request) return input.clone().text();
  return "";
}

function requestUrl(input) {
  if (typeof input === "string" || input instanceof URL) return new URL(input).toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  throw new Error("Runtime smoke received an unsupported fetch input.");
}

function requestMethod(input, init) {
  const method = init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET");
  return String(method).toUpperCase();
}

function telemetryResponse(rawBody, capturedEvents) {
  let value;
  try {
    value = JSON.parse(rawBody || "{}");
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  if (!Array.isArray(value.records)) {
    return new Response(JSON.stringify({ error: "records_required" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  for (const record of value.records) {
    if (!isObject(record) || !EVENT_TYPES.has(record.event_type) || !isObject(record.payload)) {
      return new Response(JSON.stringify({ error: "invalid_record" }), { status: 422, headers: { "content-type": "application/json" } });
    }
  }
  capturedEvents.push(...value.records.map((record) => ({ event_type: record.event_type, payload: record.payload })));
  return new Response(JSON.stringify({ accepted: value.records.length }), { status: 202, headers: { "content-type": "application/json" } });
}

function installFetchMock(externalMocks, capturedEvents, blockedRequests) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = requestUrl(input);
    const parsed = new URL(url);
    const method = requestMethod(input, init);
    if (parsed.pathname.endsWith("/v1/records")) {
      return telemetryResponse(await bodyText(input, init), capturedEvents);
    }
    const mock = externalMocks.find((candidate) => candidate.method === method && candidate.url === parsed.toString());
    if (mock) {
      return new Response(JSON.stringify(mock.json), { status: mock.status, headers: mock.headers });
    }
    const safeUrl = sanitizedUrl(url);
    blockedRequests.push({ method, url: safeUrl });
    throw new Error(`Runtime smoke blocked undeclared external request: ${method} ${safeUrl}. Add an exact synthetic external_mocks entry.`);
  };
  return () => { globalThis.fetch = originalFetch; };
}

function blockedNetworkFunction(label) {
  return function blockedNetwork() {
    throw new Error(`Runtime smoke blocked direct network access through ${label}; use fetch with an exact external_mocks entry.`);
  };
}

function installNetworkBlock() {
  const originals = {
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    netConnect: net.connect,
    netCreateConnection: net.createConnection,
    tlsConnect: tls.connect,
  };
  http.request = blockedNetworkFunction("http.request");
  http.get = blockedNetworkFunction("http.get");
  https.request = blockedNetworkFunction("https.request");
  https.get = blockedNetworkFunction("https.get");
  net.connect = blockedNetworkFunction("net.connect");
  net.createConnection = blockedNetworkFunction("net.createConnection");
  tls.connect = blockedNetworkFunction("tls.connect");
  syncBuiltinESMExports();
  return () => {
    http.request = originals.httpRequest;
    http.get = originals.httpGet;
    https.request = originals.httpsRequest;
    https.get = originals.httpsGet;
    net.connect = originals.netConnect;
    net.createConnection = originals.netCreateConnection;
    tls.connect = originals.tlsConnect;
    syncBuiltinESMExports();
  };
}

function installServerCapture() {
  const originalCreateServer = http.createServer;
  const servers = [];
  http.createServer = (...args) => {
    const listener = args.findLast((argument) => typeof argument === "function");
    const server = new EventEmitter();
    if (listener) server.on("request", listener);
    server.listening = false;
    server.listen = (...listenArgs) => {
      server.listening = true;
      const callback = listenArgs.findLast((argument) => typeof argument === "function");
      queueMicrotask(() => {
        server.emit("listening");
        callback?.();
      });
      return server;
    };
    server.address = () => ({ address: "127.0.0.1", family: "IPv4", port: 0 });
    server.close = (callback) => {
      server.listening = false;
      queueMicrotask(() => callback?.());
      return server;
    };
    server.ref = () => server;
    server.unref = () => server;
    servers.push(server);
    return server;
  };
  syncBuiltinESMExports();
  return {
    servers,
    restore() {
      http.createServer = originalCreateServer;
      syncBuiltinESMExports();
    },
  };
}

class MemorySocket extends Duplex {
  chunks = [];

  constructor() {
    super();
    this.encrypted = false;
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  setTimeout() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
}

function cookiePair(setCookie) {
  if (!setCookie) return null;
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return typeof first === "string" ? first.split(";", 1)[0] : null;
}

async function invokeServer(server, probe, cookie) {
  const listeners = server.listeners("request");
  if (listeners.length === 0) throw new Error("Captured HTTP server has no request listener.");
  const socket = new MemorySocket();
  Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1" });
  Object.defineProperty(socket, "remotePort", { value: 43000 });
  const request = new http.IncomingMessage(socket);
  const encodedBody = probe.body === undefined ? "" : JSON.stringify(probe.body);
  request.method = probe.method;
  request.url = probe.path;
  request.httpVersion = "1.1";
  request.httpVersionMajor = 1;
  request.httpVersionMinor = 1;
  request.headers = {
    host: "runtime-smoke.local",
    accept: "application/json",
    ...probe.headers,
    ...(encodedBody ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(encodedBody)) } : {}),
    ...(cookie ? { cookie } : {}),
  };
  request.rawHeaders = Object.entries(request.headers).flatMap(([key, value]) => [key, value]);
  const response = new http.ServerResponse(request);
  response.assignSocket(socket);

  const finished = new Promise((resolve, reject) => {
    let settled = false;
    const complete = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    response.once("finish", complete);
    response.once("error", reject);
    const pollEnded = () => {
      if (response.writableEnded || response.finished) complete();
      else if (!settled) setImmediate(pollEnded);
    };
    setImmediate(pollEnded);
  });
  const failures = [];
  for (const listener of listeners) {
    try {
      const returned = listener(request, response);
      if (returned && typeof returned.then === "function") returned.catch((error) => failures.push(error));
    } catch (error) {
      failures.push(error);
    }
  }
  queueMicrotask(() => {
    if (encodedBody) request.push(Buffer.from(encodedBody));
    request.push(null);
  });

  let timer;
  try {
    await Promise.race([
      finished,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("HTTP probe timed out before the response finished.")), 5_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  await new Promise((resolve) => setImmediate(resolve));
  if (failures.length > 0) throw failures[0];
  return {
    status: response.statusCode,
    cookie: cookiePair(response.getHeader("set-cookie")) ?? cookie,
  };
}

function eventMatches(event, expected) {
  return event.event_type === expected.event_type
    && Object.entries(expected.payload).every(([key, value]) => Object.is(event.payload?.[key], value));
}

function summarizeTypes(events) {
  const counts = {};
  for (const event of events) counts[event.event_type] = (counts[event.event_type] ?? 0) + 1;
  return counts;
}

function evaluateProbe(probe, response, events) {
  const failures = [];
  if (!probe.expectedStatus.includes(response.status)) {
    failures.push(`Expected HTTP ${probe.expectedStatus.join("/")} but received HTTP ${response.status}.`);
  }
  for (const expected of probe.expectedEvents) {
    const matching = events.filter((event) => eventMatches(event, expected)).length;
    if (matching !== expected.count) {
      const sameType = events.filter((event) => event.event_type === expected.event_type).length;
      failures.push(`Expected ${expected.count} matching ${expected.event_type} event(s), observed ${matching} matching and ${sameType} total.`);
    }
  }
  const expectedTotal = probe.expectedEvents.reduce((total, expected) => total + expected.count, 0);
  if (events.length !== expectedTotal) {
    failures.push(`Expected ${expectedTotal} total telemetry event(s), observed ${events.length}; unexpected or duplicate events are not allowed.`);
  }
  return failures;
}

function quietConsole() {
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
  console.debug = () => {};
  return () => Object.assign(console, originals);
}

function safeRuntimeError(error) {
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]*Error$/.test(error.name) ? error.name : "Error";
  let message = error instanceof Error ? error.message : String(error);
  message = message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/([?&](?:token|key|secret|authorization)=)[^&#\s]+/gi, "$1[redacted]")
    .replace(/(["'`])[^"'`\r\n]{24,}\1/g, "$1[redacted-long-value]$1")
    .replace(/[A-Za-z0-9_-]{48,}/g, "[redacted-long-value]")
    .slice(0, 400);
  return `${name}: ${message || "Application handler failed."}`;
}

async function readAndValidateManifest(appRoot, requireAi) {
  const manifestPath = path.join(appRoot, MANIFEST_NAME);
  let text;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") throw new Error(`${MANIFEST_NAME} is missing.`);
    throw error;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${MANIFEST_NAME} is not valid JSON.`);
  }
  return validateManifest(value, { requireAi });
}

async function runNodeHttpSmoke(appRoot, manifest) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "wonik-runtime-smoke-"));
  const originalCwd = process.cwd();
  const originalEnvironment = { ...process.env };
  const capturedEvents = [];
  const blockedRequests = [];
  const probes = [];
  let restoreFetch = () => {};
  let restoreNetwork = () => {};
  let serverCapture;
  let restoreConsole = () => {};
  try {
    await copyApp(appRoot, temporaryRoot);
    await writeFile(path.join(temporaryRoot, ".env"), sanitizedEnvText(manifest.requiredEnv), { encoding: "utf8", mode: 0o600 });
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, safeEnvironment(temporaryRoot, manifest.requiredEnv));
    process.chdir(temporaryRoot);

    restoreFetch = installFetchMock(manifest.externalMocks, capturedEvents, blockedRequests);
    restoreNetwork = installNetworkBlock();
    serverCapture = installServerCapture();
    restoreConsole = quietConsole();

    const entryPath = path.resolve(temporaryRoot, manifest.entry);
    const relativeEntry = path.relative(temporaryRoot, entryPath);
    if (relativeEntry.startsWith("..") || path.isAbsolute(relativeEntry) || !(await exists(entryPath))) {
      throw new Error("The declared runtime entry does not exist inside the isolated app copy.");
    }
    await import(`${pathToFileURL(entryPath).href}?runtime_smoke=${Date.now()}_${process.pid}`);
    await new Promise((resolve) => setImmediate(resolve));
    const server = serverCapture.servers.at(-1);
    if (!server) throw new Error("The declared entry did not create a Node HTTP server.");

    let cookie = null;
    for (const probe of manifest.probes) {
      const eventStart = capturedEvents.length;
      let status = null;
      let failures = [];
      try {
        const response = await invokeServer(server, probe, cookie);
        status = response.status;
        cookie = response.cookie;
        const probeEvents = capturedEvents.slice(eventStart);
        failures = evaluateProbe(probe, response, probeEvents);
        probes.push({
          name: probe.name,
          method: probe.method,
          path: probe.displayPath,
          status,
          eventTypes: summarizeTypes(probeEvents),
          passed: failures.length === 0,
          failures,
        });
      } catch (error) {
        failures = [safeRuntimeError(error)];
        probes.push({ name: probe.name, method: probe.method, path: probe.displayPath, status, eventTypes: summarizeTypes(capturedEvents.slice(eventStart)), passed: false, failures });
      }
    }
  } finally {
    restoreConsole();
    serverCapture?.restore();
    restoreNetwork();
    restoreFetch();
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  return {
    passed: probes.every((probe) => probe.passed) && blockedRequests.length === 0,
    runtime: manifest.runtime,
    manifest: MANIFEST_NAME,
    probes,
    blockedExternalRequests: blockedRequests,
  };
}

export async function runRuntimeSmoke(appRoot, { requireAi = false } = {}) {
  const resolvedRoot = path.resolve(appRoot);
  try {
    const manifest = await readAndValidateManifest(resolvedRoot, requireAi);
    return await runNodeHttpSmoke(resolvedRoot, manifest);
  } catch (error) {
    return {
      passed: false,
      runtime: null,
      manifest: MANIFEST_NAME,
      probes: [],
      blockedExternalRequests: [],
      error: safeRuntimeError(error),
    };
  }
}

export function runtimeFailureSummary(result) {
  if (result.error) return result.error;
  const failedProbe = result.probes.find((probe) => !probe.passed);
  if (failedProbe) return `${failedProbe.name} (${failedProbe.method} ${failedProbe.path}): ${failedProbe.failures[0]}`;
  if (result.blockedExternalRequests.length > 0) {
    const blocked = result.blockedExternalRequests[0];
    return `Blocked undeclared external request: ${blocked.method} ${blocked.url}.`;
  }
  return "Runtime smoke verification failed.";
}

export async function runRuntimeSmokeChild(appRoot, { requireAi = false, timeout = 30_000 } = {}) {
  const args = [fileURLToPath(import.meta.url), "--app-root", path.resolve(appRoot), "--json"];
  if (requireAi) args.push("--require-ai");
  const childEnvironment = safeEnvironment(tmpdir());
  try {
    const { stdout } = await execFileAsync(process.execPath, args, {
      cwd: path.resolve(appRoot),
      env: childEnvironment,
      timeout,
      maxBuffer: 1_000_000,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const stdout = error && typeof error === "object" && "stdout" in error ? String(error.stdout ?? "").trim() : "";
    if (stdout) {
      try { return JSON.parse(stdout); } catch { /* use the sanitized fallback below */ }
    }
    return {
      passed: false,
      runtime: null,
      manifest: MANIFEST_NAME,
      probes: [],
      blockedExternalRequests: [],
      error: error instanceof Error && error.killed ? "Runtime smoke child timed out." : "Runtime smoke child could not complete.",
    };
  }
}

function printHuman(result) {
  if (result.error) console.log(`FAIL  runtime-smoke  ${result.error}`);
  for (const probe of result.probes) {
    console.log(`${probe.passed ? "PASS" : "FAIL"}  ${probe.name}  ${probe.method} ${probe.path} -> ${probe.status ?? "no response"}`);
    for (const failure of probe.failures) console.log(`      ${failure}`);
  }
  for (const blocked of result.blockedExternalRequests) console.log(`FAIL  blocked-network  ${blocked.method} ${blocked.url}`);
}

async function main() {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--app-root");
  const appRoot = rootIndex >= 0 ? args[rootIndex + 1] : null;
  const json = args.includes("--json");
  if (!appRoot) {
    const result = { passed: false, error: "Usage: runtime-smoke.mjs --app-root <student-app> [--require-ai] [--json]", probes: [], blockedExternalRequests: [] };
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else printHuman(result);
    process.exit(2);
  }
  const result = await runRuntimeSmoke(appRoot, { requireAi: args.includes("--require-ai") });
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else printHuman(result);
  process.exit(result.passed ? 0 : 1);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) await main();
