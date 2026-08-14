import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { installClient, installTypescriptClient } from "./install-typescript-client.mjs";

const execFileAsync = promisify(execFile);
const installerCliPath = fileURLToPath(new URL("./install-client.mjs", import.meta.url));

async function temporaryDirectory(t) {
  const canonicalTemporaryRoot = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(canonicalTemporaryRoot, "telemetry-installer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("keeps the original installer export as a compatibility alias", () => {
  assert.equal(installTypescriptClient, installClient);
});

test("installs a Next.js client with the React server-only marker", async (t) => {
  const directory = await temporaryDirectory(t);
  const target = path.join(directory, "lib", "telemetry.server.ts");
  await installTypescriptClient({ runtime: "nextjs", target });
  const source = await readFile(target, "utf8");
  assert.match(source, /import "server-only";/);
  assert.match(source, /export async function logAppOpen/);
});

test("installs a generic Node client without a Next.js-only dependency", async (t) => {
  const directory = await temporaryDirectory(t);
  const target = path.join(directory, "server", "telemetry.server.ts");
  await installTypescriptClient({ runtime: "node", target });
  const source = await readFile(target, "utf8");
  assert.doesNotMatch(source, /import "server-only";/);
  assert.match(source, /Never import this file from a browser bundle/);
  assert.match(source, /export async function logAiCall/);
});

test("installs ready-to-run ESM and CommonJS clients for JavaScript servers", async (t) => {
  const directory = await temporaryDirectory(t);
  const esmTarget = path.join(directory, "server", "telemetry.server.mjs");
  const commonTarget = path.join(directory, "server", "telemetry.server.cjs");
  await installTypescriptClient({ runtime: "node", target: esmTarget });
  await installTypescriptClient({ runtime: "node", target: commonTarget });
  const esm = await readFile(esmTarget, "utf8");
  const common = await readFile(commonTarget, "utf8");
  assert.match(esm, /export async function logAppOpen/);
  assert.doesNotMatch(esm, /server-only/);
  assert.match(common, /exports\.logAppOpen/);
  assert.doesNotMatch(common, /server-only/);
});

test("does not install a JavaScript variant into Next.js", async (t) => {
  const directory = await temporaryDirectory(t);
  await assert.rejects(
    installTypescriptClient({ runtime: "nextjs", target: path.join(directory, "telemetry.server.mjs") }),
    /Next\.js client target/,
  );
});

test("installed ESM and CommonJS clients execute and send a metadata event", async (t) => {
  const directory = await temporaryDirectory(t);
  const esmTarget = path.join(directory, "telemetry.server.mjs");
  const commonTarget = path.join(directory, "telemetry.server.cjs");
  await installTypescriptClient({ runtime: "node", target: esmTarget });
  await installTypescriptClient({ runtime: "node", target: commonTarget });

  const environmentNames = [
    "TEAM_TELEMETRY_API_URL",
    "TEAM_TELEMETRY_TOKEN",
    "TEAM_TELEMETRY_APP_KEY",
    "TEAM_TELEMETRY_APP_NAME",
  ];
  const previousEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.TEAM_TELEMETRY_API_URL = "https://telemetry.invalid/api";
  process.env.TEAM_TELEMETRY_TOKEN = `wk_${"x".repeat(40)}`;
  process.env.TEAM_TELEMETRY_APP_KEY = "generic-app";
  process.env.TEAM_TELEMETRY_APP_NAME = "Generic app";
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 200 });
  };

  const esmClient = await import(`${pathToFileURL(esmTarget).href}?test=${Date.now()}`);
  const commonClient = createRequire(import.meta.url)(commonTarget);
  await esmClient.logUserAction({ action: "save_record" });
  await commonClient.logUserAction({ action: "save_record" });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.url === "https://telemetry.invalid/api/v1/records"));
});

test("does not overwrite an existing implementation without explicit force", async (t) => {
  const directory = await temporaryDirectory(t);
  const target = path.join(directory, "telemetry.server.ts");
  await writeFile(target, "keep me", "utf8");
  await assert.rejects(
    installTypescriptClient({ runtime: "node", target }),
    /Refusing to overwrite/,
  );
  assert.equal(await readFile(target, "utf8"), "keep me");
});

test("allows one concurrent non-force install and refuses the other", async (t) => {
  const directory = await temporaryDirectory(t);
  const target = path.join(directory, "telemetry.server.mjs");
  const results = await Promise.allSettled([
    installClient({ runtime: "node", target }),
    installClient({ runtime: "node", target }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.match(String(rejected?.reason), /Refusing to overwrite/);
  assert.match(await readFile(target, "utf8"), /export async function logAppOpen/);
});

test("rejects a dangling target symlink without creating its destination", async (t) => {
  const directory = await temporaryDirectory(t);
  const destination = path.join(directory, "outside.server.ts");
  const target = path.join(directory, "telemetry.server.ts");
  await symlink(destination, target);

  await assert.rejects(
    installClient({ runtime: "node", target }),
    /symbolic link/,
  );
  await assert.rejects(readFile(destination, "utf8"), { code: "ENOENT" });
});

test("rejects a symlink in a parent path component even with force", async (t) => {
  const directory = await temporaryDirectory(t);
  const actualDirectory = path.join(directory, "actual");
  const linkedDirectory = path.join(directory, "linked");
  await mkdir(actualDirectory);
  await symlink(actualDirectory, linkedDirectory);

  await assert.rejects(
    installClient({
      runtime: "node",
      target: path.join(linkedDirectory, "telemetry.server.cjs"),
      force: true,
    }),
    /symbolic link/,
  );
  assert.deepEqual(await readdir(actualDirectory), []);
});

test("force atomically replaces a regular target and removes its staging file", async (t) => {
  const directory = await temporaryDirectory(t);
  const target = path.join(directory, "telemetry.server.cjs");
  await writeFile(target, "old implementation", "utf8");

  await installClient({ runtime: "node", target, force: true });

  assert.match(await readFile(target, "utf8"), /exports\.logAppOpen/);
  assert.equal((await readdir(directory)).some((name) => name.startsWith(".telemetry-installer-")), false);
});

test("public install-client CLI installs the selected client", async (t) => {
  const directory = await temporaryDirectory(t);
  const target = path.join(directory, "telemetry.server.mjs");

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    installerCliPath,
    "--runtime",
    "node",
    "--target",
    target,
  ]);

  assert.equal(stderr, "");
  assert.match(stdout, /Installed node telemetry client:/);
  assert.match(await readFile(target, "utf8"), /export async function logAppOpen/);
});
