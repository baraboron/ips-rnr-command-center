#!/usr/bin/env node

import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const assetDirectory = path.join(scriptDirectory, "..", "assets");
const assetPaths = {
  ".ts": path.join(assetDirectory, "telemetry.server.ts"),
  ".mjs": path.join(assetDirectory, "telemetry.server.mjs"),
  ".cjs": path.join(assetDirectory, "telemetry.server.cjs"),
};
const SERVER_ONLY_IMPORT = 'import "server-only";';

function usage() {
  return "Usage: install-client.mjs --runtime <nextjs|node> --target <path/to/telemetry.server.ts|mjs|cjs> [--force]";
}

function parseArguments(args) {
  const result = { force: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--force") {
      result.force = true;
      continue;
    }
    if (argument === "--runtime" || argument === "--target") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.\n${usage()}`);
      result[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}\n${usage()}`);
  }

  if (!result.runtime || !result.target) throw new Error(usage());
  if (!new Set(["nextjs", "node"]).has(result.runtime)) {
    throw new Error(`Unsupported runtime: ${result.runtime}. Choose nextjs or node.`);
  }
  const extension = path.extname(result.target).toLowerCase();
  if (!/\.server\.(?:ts|mjs|cjs)$/i.test(result.target)) {
    throw new Error("The target filename must end with .server.ts, .server.mjs, or .server.cjs to preserve the server boundary.");
  }
  if (result.runtime === "nextjs" && extension !== ".ts") {
    throw new Error("The bundled Next.js client target must end with .server.ts.");
  }
  return result;
}

function hasErrorCode(error, code) {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === code;
}

async function assertNoSymlinkComponents(filename) {
  const resolvedPath = path.resolve(filename);
  const { root } = path.parse(resolvedPath);
  const components = resolvedPath.slice(root.length).split(path.sep).filter(Boolean);
  let currentPath = root;

  for (const component of components) {
    currentPath = path.join(currentPath, component);
    try {
      const fileStat = await lstat(currentPath);
      if (fileStat.isSymbolicLink()) {
        throw new Error(`Refusing installer path containing a symbolic link: ${currentPath}`);
      }
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return;
      throw error;
    }
  }
}

function overwriteRefusal(targetPath) {
  return new Error(`Refusing to overwrite existing file: ${targetPath}. Review it or pass --force explicitly.`);
}

async function writeExclusive(targetPath, source) {
  let fileHandle;
  let completed = false;
  try {
    fileHandle = await open(targetPath, "wx", 0o644);
    await fileHandle.writeFile(source, "utf8");
    await fileHandle.sync();
    completed = true;
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) throw overwriteRefusal(targetPath);
    throw error;
  } finally {
    if (fileHandle) await fileHandle.close();
    if (fileHandle && !completed) {
      await unlink(targetPath).catch(() => {});
    }
  }
}

async function writeAtomicReplacement(targetPath, source) {
  const targetDirectory = path.dirname(targetPath);
  const temporaryPath = path.join(
    targetDirectory,
    `.telemetry-installer-${process.pid}-${randomUUID()}.tmp`,
  );
  let fileHandle;
  let renamed = false;

  try {
    fileHandle = await open(temporaryPath, "wx", 0o644);
    await fileHandle.writeFile(source, "utf8");
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = undefined;

    await assertNoSymlinkComponents(targetPath);
    await rename(temporaryPath, targetPath);
    renamed = true;
  } finally {
    if (fileHandle) await fileHandle.close().catch(() => {});
    if (!renamed) await unlink(temporaryPath).catch(() => {});
  }
}

export async function installClient({ runtime, target, force = false }) {
  const targetPath = path.resolve(target);
  const extension = path.extname(targetPath).toLowerCase();
  if (!new Set(["nextjs", "node"]).has(runtime)) {
    throw new Error(`Unsupported runtime: ${runtime}. Choose nextjs or node.`);
  }
  if (!assetPaths[extension] || !/\.server\.(?:ts|mjs|cjs)$/i.test(targetPath)) {
    throw new Error("The target filename must end with .server.ts, .server.mjs, or .server.cjs to preserve the server boundary.");
  }
  if (runtime === "nextjs" && extension !== ".ts") {
    throw new Error("The bundled Next.js client target must end with .server.ts.");
  }

  await assertNoSymlinkComponents(targetPath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await assertNoSymlinkComponents(targetPath);

  let source = await readFile(assetPaths[extension], "utf8");
  if (runtime === "node" && extension === ".ts") {
    if (!source.includes(SERVER_ONLY_IMPORT)) {
      throw new Error("Bundled client no longer contains the expected Next.js server-only marker.");
    }
    source = source.replace(
      SERVER_ONLY_IMPORT,
      "// Generic Node server module. Never import this file from a browser bundle.",
    );
  }

  if (force) await writeAtomicReplacement(targetPath, source);
  else await writeExclusive(targetPath, source);
  return targetPath;
}

// Backward-compatible export for the first training draft.
export const installTypescriptClient = installClient;

export async function runInstallerCli(args = process.argv.slice(2)) {
  try {
    const options = parseArguments(args);
    const installedPath = await installClient(options);
    console.log(`Installed ${options.runtime} telemetry client: ${installedPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runInstallerCli();
}
