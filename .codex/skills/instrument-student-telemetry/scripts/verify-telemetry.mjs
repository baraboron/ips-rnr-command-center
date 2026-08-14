#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const JAVASCRIPT_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const SOURCE_EXTENSIONS = new Set([...JAVASCRIPT_EXTENSIONS, ".go", ".py"]);
const SECURITY_TEXT_EXTENSIONS = new Set([".json", ".md", ".mdx", ".toml", ".yaml", ".yml"]);
const DEPENDENCY_MANIFESTS = new Set([
  "bun.lock",
  "bun.lockb",
  "deno.json",
  "deno.lock",
  "go.mod",
  "go.sum",
  "package.json",
  "package-lock.json",
  "Pipfile",
  "Pipfile.lock",
  "poetry.lock",
  "pnpm-lock.yaml",
  "pyproject.toml",
  "requirements.txt",
  "uv.lock",
  "yarn.lock",
]);
const EXCLUDED_DIRECTORIES = new Set([
  ".codex",
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".pytest_cache",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
  "venv",
]);
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

function isEnvStyleFile(filename) {
  const lower = filename.toLowerCase();
  return lower === ".env" || lower === ".envrc" || lower.startsWith(".env.") || lower.endsWith(".env");
}

function isDependencyManifest(filename) {
  return DEPENDENCY_MANIFESTS.has(filename)
    || /^requirements(?:[-_.][A-Za-z0-9_.-]+)?\.txt$/i.test(filename);
}

const JAVASCRIPT_REGEX_PREFIX_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

function canStartJavaScriptRegex(text, slashIndex) {
  let cursor = slashIndex - 1;
  while (cursor >= 0 && /\s/.test(text[cursor])) cursor -= 1;
  if (cursor < 0) return true;

  const previous = text[cursor];
  if ("([{:;,=!?&|+-*%^~<>".includes(previous)) return true;

  if (/[A-Za-z0-9_$]/.test(previous)) {
    const end = cursor + 1;
    while (cursor >= 0 && /[A-Za-z0-9_$]/.test(text[cursor])) cursor -= 1;
    return JAVASCRIPT_REGEX_PREFIX_KEYWORDS.has(text.slice(cursor + 1, end));
  }
  return false;
}

function maskSource(text, extension, maskStrings) {
  const output = text.split("");
  const python = extension === ".py";
  const javascript = JAVASCRIPT_EXTENSIONS.has(extension);
  const slashComments = JAVASCRIPT_EXTENSIONS.has(extension) || extension === ".go";
  let state = "code";
  let quote = "";
  let triple = false;
  let regexCharacterClass = false;

  const blank = (index) => {
    if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
  };

  for (let index = 0; index < text.length;) {
    const character = text[index];
    const next = text[index + 1];

    if (state === "line-comment") {
      if (character === "\n" || character === "\r") {
        state = "code";
      } else {
        blank(index);
      }
      index += 1;
      continue;
    }

    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        blank(index);
        blank(index + 1);
        index += 2;
        state = "code";
      } else {
        blank(index);
        index += 1;
      }
      continue;
    }

    if (state === "string") {
      if (triple && text.slice(index, index + 3) === quote.repeat(3)) {
        index += 3;
        state = "code";
        triple = false;
        quote = "";
        continue;
      }
      if (!triple && character === quote) {
        index += 1;
        state = "code";
        quote = "";
        continue;
      }
      if (!triple && character === "\\" && !(extension === ".go" && quote === "`")) {
        if (maskStrings) {
          blank(index);
          if (index + 1 < text.length) blank(index + 1);
        }
        index += 2;
        continue;
      }
      if (maskStrings) blank(index);
      index += 1;
      continue;
    }

    if (state === "regex") {
      if (character === "\n" || character === "\r") {
        state = "code";
        regexCharacterClass = false;
        index += 1;
        continue;
      }
      if (character === "\\") {
        if (maskStrings) {
          blank(index);
          if (index + 1 < text.length) blank(index + 1);
        }
        index += 2;
        continue;
      }
      if (character === "[") {
        regexCharacterClass = true;
        if (maskStrings) blank(index);
        index += 1;
        continue;
      }
      if (character === "]" && regexCharacterClass) {
        regexCharacterClass = false;
        if (maskStrings) blank(index);
        index += 1;
        continue;
      }
      if (character === "/" && !regexCharacterClass) {
        if (maskStrings) blank(index);
        index += 1;
        while (index < text.length && /[dgimsuvy]/.test(text[index])) {
          if (maskStrings) blank(index);
          index += 1;
        }
        state = "code";
        continue;
      }
      if (maskStrings) blank(index);
      index += 1;
      continue;
    }

    if (python && character === "#") {
      blank(index);
      index += 1;
      state = "line-comment";
      continue;
    }
    if (slashComments && character === "/" && next === "/") {
      blank(index);
      blank(index + 1);
      index += 2;
      state = "line-comment";
      continue;
    }
    if (slashComments && character === "/" && next === "*") {
      blank(index);
      blank(index + 1);
      index += 2;
      state = "block-comment";
      continue;
    }
    if (javascript && character === "/" && canStartJavaScriptRegex(text, index)) {
      state = "regex";
      regexCharacterClass = false;
      if (maskStrings) blank(index);
      index += 1;
      continue;
    }

    const startsPythonTriple = python
      && (character === "\"" || character === "'")
      && text.slice(index, index + 3) === character.repeat(3);
    const startsString = startsPythonTriple
      || character === "\""
      || character === "'"
      || (!python && character === "`");
    if (startsString) {
      state = "string";
      quote = character;
      triple = startsPythonTriple;
      index += startsPythonTriple ? 3 : 1;
      continue;
    }

    index += 1;
  }

  return output.join("");
}

function sourceViews(text, extension) {
  return {
    commentsStripped: maskSource(text, extension, false),
    code: maskSource(text, extension, true),
  };
}

function executablePatternTest(file, pattern, executablePattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  let match;
  while ((match = matcher.exec(file.commentsStripped)) !== null) {
    const codeSlice = file.code.slice(match.index, match.index + match[0].length);
    if (executablePattern.test(codeSlice)) return true;
    if (match[0].length === 0) matcher.lastIndex += 1;
  }
  return false;
}

function patternHasCodeContext(file, pattern, radius = 160) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  let match;
  while ((match = matcher.exec(file.commentsStripped)) !== null) {
    const start = Math.max(0, match.index - radius);
    const end = Math.min(file.code.length, match.index + match[0].length + radius);
    if (/[A-Za-z_$][\w$]*/.test(file.code.slice(start, end))) return true;
    if (match[0].length === 0) matcher.lastIndex += 1;
  }
  return false;
}

function hasIngestionEndpointUsage(file) {
  const patterns = [
    /\b(?:fetch|endsWith|resolveEndpoint|NewRequest|Post)\s*\([^;\n]{0,320}\/v1\/records\b/i,
    /\b(?:endpoint|url|pathname|api[_A-Za-z]*url)\b\s*(?::=|=|:)\s*[^;\n]{0,320}\/v1\/records\b/i,
  ];
  return patterns.some((pattern) => executablePatternTest(
    file,
    pattern,
    /\b(?:fetch|endsWith|resolveEndpoint|NewRequest|Post|endpoint|url|pathname|api[_A-Za-z]*url)\b/i,
  ));
}

function hasBearerAuthorization(file) {
  const patterns = [
    /["']?Authorization["']?\s*:\s*[^,\n}]{0,200}Bearer\s/i,
    /\.set\s*\(\s*["']Authorization["']\s*,[^)\n]{0,200}Bearer\s/i,
  ];
  return patterns.some((pattern) => executablePatternTest(file, pattern, /[:,]/));
}

function hasIdempotencyImplementation(file) {
  return /(?:idempotency_key|idempotencyKey|IdempotencyKey)\b/.test(file.code)
    && /(?:randomUUID|crypto\.randomUUID|uuid|crypto\/rand)/i.test(file.code);
}

function hasRetryImplementation(file) {
  return /(?:MAX_ATTEMPTS|retryable|backoff|retryDelay)/i.test(file.code)
    && /408/.test(file.code)
    && /425/.test(file.code)
    && /429/.test(file.code)
    && /(?:status\s*>=\s*500|5\d\d)/.test(file.code);
}

function hasCohesiveEventConstruction(file) {
  if (JAVASCRIPT_EXTENSIONS.has(file.extension)) {
    return [
      ["logAppOpen", "app_open"],
      ["logUserAction", "user_action"],
      ["logAiCall", "ai_call"],
    ].every(([logger, eventType]) => {
      const pattern = new RegExp(
        `\\bfunction\\s+${logger}\\b[\\s\\S]{0,1800}?enqueueAndFlush\\s*\\(\\s*makeRecord\\s*\\(\\s*[\"']${eventType}[\"']`,
      );
      return executablePatternTest(
        file,
        pattern,
        new RegExp(`\\bfunction\\s+${logger}\\b[\\s\\S]*?enqueueAndFlush\\s*\\(\\s*makeRecord\\s*\\(`),
      );
    });
  }
  if (file.extension === ".py") {
    return ["log_app_open", "log_user_action", "log_ai_call"].every(
      (name) => new RegExp(`\\b(?:async\\s+)?def\\s+${name}\\s*\\(`).test(file.code),
    ) && ["app_open", "user_action", "ai_call"].every(
      (eventType) => new RegExp(`[\"']${eventType}[\"']`).test(file.commentsStripped),
    );
  }
  if (file.extension === ".go") {
    return ["LogAppOpen", "LogUserAction", "LogAICall"].every(
      (name) => new RegExp(`\\bfunc\\s+(?:\\([^)]*\\)\\s*)?${name}\\s*\\(`).test(file.code),
    ) && ["app_open", "user_action", "ai_call"].every(
      (eventType) => new RegExp(`[\"']${eventType}[\"']`).test(file.commentsStripped),
    );
  }
  return false;
}

async function collectRelevantFiles(root, directory = root, files = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) await collectRelevantFiles(root, absolutePath, files);
      continue;
    }
    const extension = path.extname(entry.name);
    const relevant = SOURCE_EXTENSIONS.has(extension)
      || SECURITY_TEXT_EXTENSIONS.has(extension)
      || isDependencyManifest(entry.name)
      || isEnvStyleFile(entry.name);
    if (!entry.isFile() || !relevant) continue;
    const fileStat = await stat(absolutePath);
    if (isEnvStyleFile(entry.name) && fileStat.size > MAX_SOURCE_BYTES) {
      throw new Error(`Env-style file exceeds the verifier scan limit: ${path.relative(root, absolutePath)}`);
    }
    if (fileStat.size <= MAX_SOURCE_BYTES) files.push(absolutePath);
  }
  return files;
}

function isTelemetryClient(relativePath) {
  const basename = path.basename(relativePath).toLowerCase();
  return basename === "telemetry.server.ts"
    || basename === "telemetry.server.js"
    || basename === "telemetry.server.mjs"
    || basename === "telemetry.server.cjs"
    || basename === "telemetry.server.mts"
    || basename === "telemetry.server.cts"
    || basename === "telemetry.py"
    || basename === "telemetry.go";
}

function isTestSource(relativePath) {
  const normalized = relativePath.replaceAll(path.sep, "/").toLowerCase();
  const basename = path.posix.basename(normalized);
  return /(?:^|\/)(?:__tests__|test|tests|fixtures)(?:\/|$)/.test(normalized)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(basename)
    || /_(?:test|spec)\.(?:py|go)$/.test(basename);
}

function eventConvenienceName(eventType) {
  return {
    app_open: "logAppOpen",
    user_action: "logUserAction",
    ai_call: "logAiCall",
  }[eventType];
}

function eventNamesForFile(file, eventType) {
  if (file.extension === ".py") {
    return new Set([{
      app_open: "log_app_open",
      user_action: "log_user_action",
      ai_call: "log_ai_call",
    }[eventType]]);
  }
  if (file.extension === ".go") {
    return new Set([{
      app_open: "LogAppOpen",
      user_action: "LogUserAction",
      ai_call: "LogAICall",
    }[eventType]]);
  }
  const convenienceName = eventConvenienceName(eventType);
  return new Set([convenienceName, ...importedLocalNames(file.code, convenienceName)]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function importedLocalNames(text, exportedName) {
  const names = new Set();
  const importPattern = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'][^"']*["']/g;
  let importMatch;
  while ((importMatch = importPattern.exec(text)) !== null) {
    const specifiers = importMatch[1]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .split(",");
    for (const specifier of specifiers) {
      const match = specifier.trim().match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (match?.[1] === exportedName) names.add(match[2] ?? exportedName);
    }
  }
  return names;
}

function telemetryImportedLocalNames(file, exportedName) {
  const names = new Set();
  const sourcePattern = "(?:[^\"']*/)?telemetry\\.server(?:\\.[cm]?[jt]sx?)?";
  const namedImportPattern = new RegExp(
    `\\bimport\\s+(?:type\\s+)?\\{([^}]*)\\}\\s+from\\s+[\"']${sourcePattern}[\"']`,
    "gi",
  );
  let match;
  while ((match = namedImportPattern.exec(file.commentsStripped)) !== null) {
    for (const specifier of match[1].split(",")) {
      const binding = specifier.trim().match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (binding?.[1] === exportedName) names.add(binding[2] ?? exportedName);
    }
  }

  const namespaceImportPattern = new RegExp(
    `\\bimport\\s+\\*\\s+as\\s+[A-Za-z_$][\\w$]*\\s+from\\s+[\"']${sourcePattern}[\"']`,
    "i",
  );
  if (namespaceImportPattern.test(file.commentsStripped)) names.add(exportedName);

  const requirePattern = new RegExp(
    `\\b(?:const|let|var)\\s+\\{([^}]*)\\}\\s*=\\s*require\\(\\s*[\"']${sourcePattern}[\"']\\s*\\)`,
    "gi",
  );
  while ((match = requirePattern.exec(file.commentsStripped)) !== null) {
    for (const specifier of match[1].split(",")) {
      const binding = specifier.trim().match(/^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/);
      if (binding?.[1] === exportedName) names.add(binding[2] ?? exportedName);
    }
  }
  return names;
}

function eventCallNames(file, eventType) {
  return eventNamesForFile(file, eventType);
}

function hasAwaitedEventCall(file, eventType) {
  if (file.extension === ".py") {
    const name = [...eventCallNames(file, eventType)][0];
    const callPattern = new RegExp(`\\bawait\\s+(?:[A-Za-z_]\\w*\\.)?${name}\\s*\\(`);
    return callPattern.test(file.code);
  }
  if (file.extension === ".go") {
    const name = [...eventCallNames(file, eventType)][0];
    const callPattern = new RegExp(`\\b(?:[A-Za-z_]\\w*\\.)?${name}\\s*\\(`);
    const definitionPattern = new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${name}\\s*\\(`);
    return file.code.split(/\r?\n/).some((line) => !definitionPattern.test(line) && callPattern.test(line));
  }
  const exportedName = eventConvenienceName(eventType);
  for (const localName of telemetryImportedLocalNames(file, exportedName)) {
    const callPattern = new RegExp(
      `(?:await|return(?:\\s+await)?)\\s+(?:[A-Za-z_$][\\w$]*\\.)?${escapeRegExp(localName)}\\s*\\(`,
    );
    if (callPattern.test(file.code)) return true;
  }
  return false;
}

function leadingDirectives(text) {
  let remaining = text.replace(/^\uFEFF/, "");
  const directives = new Set();
  const stripTrivia = () => {
    while (true) {
      const before = remaining;
      remaining = remaining.replace(/^[\s;]+/, "");
      remaining = remaining.replace(/^\/\/[^\n]*(?:\n|$)/, "");
      remaining = remaining.replace(/^\/\*[\s\S]*?\*\//, "");
      if (remaining === before) break;
    }
  };
  stripTrivia();
  while (true) {
    const match = remaining.match(/^(?:"([^"\n]*)"|'([^'\n]*)')\s*;?/);
    if (!match) break;
    directives.add(match[1] ?? match[2]);
    remaining = remaining.slice(match[0].length);
    stripTrivia();
  }
  return directives;
}

function relativePathForMatch(file) {
  return file.relativePath.replaceAll(path.sep, "/");
}

function hasPythonServerEvidence(file) {
  return /(?:\b(?:FastAPI|Flask|APIRouter|Blueprint|Sanic|Falcon|HTTPServer|BaseHTTPRequestHandler)\s*\(|@\s*[A-Za-z_]\w*\.(?:get|post|put|patch|delete|route|websocket)\s*\(|\b(?:uvicorn\.run|web\.run_app|make_server)\s*\(|\bdef\s+(?:lambda_handler|wsgi_app|asgi_app)\s*\()/m.test(file.code);
}

function hasGoServerEvidence(file) {
  return /(?:\bhttp\.(?:Handle|HandleFunc|ListenAndServe|ListenAndServeTLS|Server)\b|\b(?:gin|echo|fiber)\.New\s*\(|\b(?:mux|chi)\.NewRouter\s*\(|\blambda\.Start\s*\(|\bfunc\s+(?:\([^)]*\)\s*)?[A-Za-z_]\w*\s*\([^\n{]*(?:http\.ResponseWriter|\*http\.Request|\*gin\.Context|echo\.Context|\*fiber\.Ctx))/m.test(file.code);
}

function isNextEdgeRuntime(file) {
  return JAVASCRIPT_EXTENSIONS.has(file.extension)
    && /\bexport\s+const\s+runtime(?:\s*:\s*[^=;\n]+)?\s*=\s*["'`]edge["'`]/.test(file.commentsStripped);
}

function hasJavascriptServerEntryEvidence(file, projectContext = {}) {
  if (!JAVASCRIPT_EXTENSIONS.has(file.extension)) return false;
  if (isNextEdgeRuntime(file)) return false;

  const relativePath = relativePathForMatch(file);
  const nextRuntimeAvailable = projectContext.hasNext && !projectContext.nextStaticExport;
  if (nextRuntimeAvailable && leadingDirectives(file.text).has("use server")) return true;
  if (nextRuntimeAvailable && /(?:^|\/)app(?:\/.*)?\/route\.[cm]?[jt]s$/.test(relativePath)) return true;
  if (nextRuntimeAvailable && /(?:^|\/)pages\/api\/.+\.[cm]?[jt]s$/.test(relativePath)) return true;
  if (/(?:\bexpress\s*\(|\bfastify\s*\(|\bnew\s+Hono\s*\(|\bnew\s+Koa\s*\(|\bHapi\.server\s*\(|\bNestFactory\.create\s*\(|\b(?:http\.)?createServer\s*\(|\bserve\s*\()/.test(file.code)) return true;
  if (/\b(?:app|router|server)\.(?:get|post|put|patch|delete|use|route|listen)\s*\(/.test(file.code)) return true;
  if (/\b(?:app\.http|functions?\.http|export\s+(?:default\s+)?(?:async\s+)?function\s+(?:handler|fetch)|export\s+const\s+handler\s*=|module\.exports\s*=)\b/.test(file.code)) {
    return /(?:^|\/)(?:api|functions|server|workers)(?:\/|$)/.test(relativePath);
  }
  return false;
}

function hasExplicitJavascriptServerEvidence(file, projectContext = {}) {
  if (!JAVASCRIPT_EXTENSIONS.has(file.extension) || isNextEdgeRuntime(file)) return false;
  if (hasJavascriptServerEntryEvidence(file, projectContext)) return true;
  if (!projectContext.hasJavascriptServerEntry) return false;
  if (executablePatternTest(
    file,
    /\bimport\s+(?:["']server-only["']|[\s\S]*?\bfrom\s+["']server-only["'])/,
    /\b(?:import|from)\b/,
  )) return true;

  const relativePath = relativePathForMatch(file);
  const basename = path.basename(relativePath);
  if (/\.server\.[cm]?[jt]sx?$/.test(basename)) return true;
  return false;
}

function isViteBrowserApiModule(file, projectContext) {
  if (!projectContext.hasVite || !JAVASCRIPT_EXTENSIONS.has(file.extension)) return false;
  return /(?:^|\/)src\/api(?:\/|$)/.test(relativePathForMatch(file))
    && !hasJavascriptServerEntryEvidence(file, projectContext);
}

function isClientModule(file, projectContext = { hasVite: false }) {
  if (file.extension === ".go") {
    const relativePath = relativePathForMatch(file).toLowerCase();
    const buildConstraint = file.text.match(/^\s*\/\/go:build([^\n]*)/m)?.[1] ?? "";
    const legacyConstraint = file.text.match(/^\s*\/\/\s*\+build([^\n]*)/m)?.[1] ?? "";
    return /["']syscall\/js["']/.test(file.commentsStripped)
      || (/\bjs\b/.test(buildConstraint) && /\bwasm\b/.test(buildConstraint))
      || (/\bjs\b/.test(legacyConstraint) && /\bwasm\b/.test(legacyConstraint))
      || /(?:^|\/)[^/]*_(?:js_wasm|wasm_js)\.go$/.test(relativePath);
  }
  if (file.extension === ".py") {
    return /\b(?:import|from)\s+(?:pyodide|js|pyscript|brython)\b/.test(file.code);
  }
  if (!JAVASCRIPT_EXTENSIONS.has(file.extension)) return false;
  return leadingDirectives(file.text).has("use client") || isViteBrowserApiModule(file, projectContext);
}

function isProvenServerModule(file, projectContext = { hasVite: false }) {
  if (isClientModule(file, projectContext)) return false;
  if (file.extension === ".py") return hasPythonServerEvidence(file);
  if (file.extension === ".go") return hasGoServerEvidence(file);
  return hasExplicitJavascriptServerEvidence(file, projectContext);
}

function isEventBoundary(file, projectContext) {
  if (file.extension === ".py") return hasPythonServerEvidence(file);
  if (file.extension === ".go") return hasGoServerEvidence(file);
  return hasJavascriptServerEntryEvidence(file, projectContext);
}

function matchingFiles(files, predicate) {
  return files.filter(predicate).map((file) => file.relativePath);
}

function check(id, passed, message, files = []) {
  return { id, passed, message, files };
}

function balancedCallEnd(code, openingParenthesis) {
  let depth = 0;
  for (let index = openingParenthesis; index < code.length; index += 1) {
    if (code[index] === "(") depth += 1;
    if (code[index] !== ")") continue;
    depth -= 1;
    if (depth === 0) return index + 1;
  }
  return Math.min(code.length, openingParenthesis + 4_000);
}

function resolveReferencedDefinitions(beforeCall, seedIdentifiers) {
  const reserved = new Set([
    "async", "await", "const", "false", "function", "let", "new", "null", "return", "true", "undefined", "var",
  ]);
  const queue = [...new Set(seedIdentifiers)];
  const visited = new Set();
  const snippets = [];

  while (queue.length > 0 && visited.size < 16) {
    const identifier = queue.shift();
    if (!identifier || visited.has(identifier) || reserved.has(identifier)) continue;
    visited.add(identifier);
    const escaped = escapeRegExp(identifier);
    const assignmentPattern = new RegExp(`(?:\\b(?:const|let|var)\\s+)?\\b${escaped}\\s*=`, "g");
    let assignment;
    let lastAssignment;
    while ((assignment = assignmentPattern.exec(beforeCall)) !== null) lastAssignment = assignment;

    let snippet = "";
    if (lastAssignment) {
      const endCandidates = [
        beforeCall.indexOf(";", lastAssignment.index),
        beforeCall.indexOf("\n", lastAssignment.index),
      ].filter((index) => index >= 0);
      const end = endCandidates.length > 0
        ? Math.min(...endCandidates) + 1
        : Math.min(beforeCall.length, lastAssignment.index + 2_000);
      snippet = beforeCall.slice(lastAssignment.index, end);
    } else {
      const functionPattern = new RegExp(`\\b(?:async\\s+)?function\\s+${escaped}\\s*\\(|\\bdef\\s+${escaped}\\s*\\(`, "g");
      let functionMatch;
      let lastFunction;
      while ((functionMatch = functionPattern.exec(beforeCall)) !== null) lastFunction = functionMatch;
      if (lastFunction) snippet = beforeCall.slice(lastFunction.index, Math.min(beforeCall.length, lastFunction.index + 2_000));
    }
    if (!snippet) continue;
    snippets.push(snippet);
    for (const match of snippet.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
      if (!visited.has(match[0]) && !reserved.has(match[0])) queue.push(match[0]);
    }
  }
  return snippets.join("\n");
}

function inspectTelemetryPayloads(files) {
  const forbiddenName = "(?:authorization|api[_-]?key|team[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|auth[_-]?token|bearer[_-]?token|prompt|system[_-]?prompt|question|messages?|response|answer|content|input|output|text|query|search[_-]?term|filter[_-]?value|form[_-]?value|comments?|file[_-]?name|filename|document|tool[_-]?(?:data|result|arguments?)|email|phone|address|employee[_-]?id|full[_-]?name|real[_-]?name|user[_-]?name|username|first[_-]?name|last[_-]?name|error[_-]?message|stack[_-]?trace)";
  const forbiddenProperty = new RegExp(
    "(?:\\[\\s*[\"'`]\\s*" + forbiddenName + "\\s*[\"'`]\\s*\\]|[\"'`]\\s*"
      + forbiddenName + "\\s*[\"'`]|\\b" + forbiddenName + "\\b)\\s*(?::|=)",
    "i",
  );
  const forbiddenShorthand = new RegExp(`(?:[,{]\\s*)${forbiddenName}(?=\\s*[,}])`, "i");
  const findings = [];
  for (const file of files) {
    const callIndexes = [];
    const callPatterns = ["app_open", "user_action", "ai_call"]
      .flatMap((eventType) => [...eventCallNames(file, eventType)])
      .map((name) => new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, "g"));
    for (const callPattern of callPatterns) {
      let match;
      while ((match = callPattern.exec(file.code)) !== null) callIndexes.push(match.index);
    }
    const genericPattern = /\b(?:record|emit|send|log)Telemetry\s*\(\s*["'](?:app_open|user_action|ai_call)["']/g;
    let genericMatch;
    while ((genericMatch = genericPattern.exec(file.commentsStripped)) !== null) {
      const codeSlice = file.code.slice(genericMatch.index, genericMatch.index + genericMatch[0].length);
      if (/\b(?:record|emit|send|log)Telemetry\b/.test(codeSlice)) callIndexes.push(genericMatch.index);
    }

    let unsafe = false;
    for (const callIndex of callIndexes) {
      const openingParenthesis = file.code.indexOf("(", callIndex);
      const callEnd = balancedCallEnd(file.code, openingParenthesis);
      const callText = file.commentsStripped.slice(callIndex, callEnd);
      const beforeCall = file.commentsStripped.slice(Math.max(0, callIndex - 12_000), callIndex);
      const argumentText = callText.slice(callText.indexOf("(") + 1, -1).trim();
      const identifierArgument = argumentText.match(/^([A-Za-z_$][\w$]*)$/)?.[1];
      const spreadIdentifiers = [...argumentText.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)]
        .map((match) => match[1]);
      const referencedIdentifiers = identifierArgument ? [identifierArgument] : spreadIdentifiers;
      const referencedDefinitions = resolveReferencedDefinitions(beforeCall, referencedIdentifiers);
      const relevantText = referencedDefinitions ? `${referencedDefinitions}\n${callText}` : callText;
      if (forbiddenProperty.test(relevantText) || forbiddenShorthand.test(relevantText)) {
        unsafe = true;
        break;
      }
    }
    if (unsafe) findings.push(file.relativePath);
  }
  return findings;
}

function javascriptTelemetryWrapperNames(files) {
  const names = new Set();
  const eventNames = ["logAppOpen", "logUserAction", "logAiCall"];
  for (const file of files) {
    if (!JAVASCRIPT_EXTENSIONS.has(file.extension)) continue;
    const patterns = [
      /\basync\s+function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^\{]+)?\{([\s\S]*?)\n\}/g,
      /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*async\s*\([^)]*\)\s*(?::\s*[^=]+)?=>\s*\{([\s\S]*?)\n\}/g,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(file.code)) !== null) {
        if (eventNames.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(match[2]))) {
          names.add(match[1]);
        }
      }
    }
  }
  return names;
}

function hasUnawaitedJavascriptTelemetry(file, wrapperNames) {
  const importedNames = ["app_open", "user_action", "ai_call"]
    .flatMap((eventType) => [...telemetryImportedLocalNames(file, eventConvenienceName(eventType))]);
  const names = [...new Set([...importedNames, ...wrapperNames])];
  for (const name of names) {
    const callPattern = new RegExp(`(?:[A-Za-z_$][\\w$]*\\.)?${escapeRegExp(name)}\\s*\\(`, "g");
    let match;
    while ((match = callPattern.exec(file.code)) !== null) {
      const prefix = file.code.slice(Math.max(0, match.index - 240), match.index);
      if (/\b(?:async\s+)?function\s*$/.test(prefix)) continue;
      if (/(?:\bawait|\breturn(?:\s+await)?)\s*$/.test(prefix)) continue;
      return true;
    }
  }
  return false;
}

function pythonTelemetryWrapperNames(file) {
  const names = new Set();
  const lines = file.code.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)async\s+def\s+([A-Za-z_]\w*)\s*\(/);
    if (!match) continue;
    const indentation = match[1].length;
    const body = [];
    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      const line = lines[bodyIndex];
      if (line.trim() && (line.match(/^\s*/)?.[0].length ?? 0) <= indentation) break;
      body.push(line);
    }
    if (/\b(?:[A-Za-z_]\w*\.)?log_(?:app_open|user_action|ai_call)\s*\(/.test(body.join("\n"))) {
      names.add(match[2]);
    }
  }
  return names;
}

function balancedBraceEnd(code, openingBrace) {
  let depth = 0;
  for (let index = openingBrace; index < code.length; index += 1) {
    if (code[index] === "{") depth += 1;
    if (code[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return index + 1;
  }
  return code.length;
}

function goTelemetryWrapperNames(file) {
  const names = new Set();
  const definitionPattern = /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\([^)]*\)[^{]*\{/g;
  let match;
  while ((match = definitionPattern.exec(file.code)) !== null) {
    const openingBrace = file.code.indexOf("{", match.index);
    const body = file.code.slice(openingBrace, balancedBraceEnd(file.code, openingBrace));
    if (/\b(?:[A-Za-z_]\w*\.)?Log(?:AppOpen|UserAction|AICall)\s*\(/.test(body)) names.add(match[1]);
  }
  return names;
}

function floatingTelemetryFiles(files) {
  const wrapperNames = javascriptTelemetryWrapperNames(files);
  const goWrapperPattern = /\bgo\s+func\s*\([^)]*\)\s*\{[\s\S]{0,4000}?\b(?:[A-Za-z_]\w*\.)?Log(?:AppOpen|UserAction|AICall)\s*\(/;
  return matchingFiles(files, (file) => {
    if (JAVASCRIPT_EXTENSIONS.has(file.extension)) {
      return hasUnawaitedJavascriptTelemetry(file, wrapperNames);
    }
    if (file.extension === ".py") {
      const callable = ["log_app_open", "log_user_action", "log_ai_call", ...pythonTelemetryWrapperNames(file)];
      const schedulerPattern = new RegExp(
        `\\b(?:asyncio\\.)?(?:create_task|ensure_future)\\s*\\(\\s*(?:[A-Za-z_]\\w*\\.)?(?:${callable.map(escapeRegExp).join("|")})\\s*\\(`,
      );
      if (schedulerPattern.test(file.code)) return true;
      return file.code.split(/\r?\n/).some((line) => callable.some((name) => {
        const call = new RegExp(`\\b(?:[A-Za-z_]\\w*\\.)?${escapeRegExp(name)}\\s*\\(`);
        return call.test(line)
          && !new RegExp(`\\bawait\\s+(?:[A-Za-z_]\\w*\\.)?${escapeRegExp(name)}\\s*\\(`).test(line)
          && !new RegExp(`^\\s*(?:async\\s+)?def\\s+${escapeRegExp(name)}\\s*\\(`).test(line);
      }));
    }
    if (file.extension === ".go") {
      const callable = ["LogAppOpen", "LogUserAction", "LogAICall", ...goTelemetryWrapperNames(file)];
      const detachedPattern = new RegExp(
        `(?:^|[;{}\\n])\\s*go\\s+(?:[A-Za-z_]\\w*\\.)?(?:${callable.map(escapeRegExp).join("|")})\\s*\\(`,
      );
      return detachedPattern.test(file.code) || goWrapperPattern.test(file.code);
    }
    return false;
  });
}

const AI_SOURCE_PATTERN = /(?:\b(?:openai|anthropic|langchain|litellm|ollama|bedrockruntime|generativeai|genai|mistralai|groq|cohere|deepseek|replicate|vertexai|together|huggingface|xai)\b|["']bedrock-runtime["']|\bboto3\s*\.\s*client\s*\(\s*["']bedrock-runtime["']|@ai-sdk\/|@anthropic-ai\/sdk|@aws-sdk\/client-bedrock-runtime|@google\/(?:generative-ai|genai)|@google-cloud\/vertexai|@huggingface\/inference|@mistralai\/mistralai|(?:from\s+|require\s*\(|import\s*\()["']ai["']|api\.(?:openai\.com|anthropic\.com|mistral\.ai|groq\.com|cohere\.(?:com|ai)|x\.ai|deepseek\.com|perplexity\.ai|together\.xyz|replicate\.com)|openrouter\.ai\/api|(?:api-inference|router|inference)\.huggingface\.co|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|bedrock-runtime(?:\.[a-z0-9-]+)?\.amazonaws\.com|[a-z0-9-]+\.openai\.azure\.com|\/openai\/deployments\/|(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?\/(?:api\/(?:chat|generate)|v1\/chat\/completions)\b|\b(?:generateContent|chat\.completions\.create|messages\.create|invoke_model|InvokeModel|Converse)\s*\()/i;
const AI_DEPENDENCY_PATTERN = /(?:@ai-sdk\/|@anthropic-ai\/sdk|@aws-sdk\/client-bedrock-runtime|@google\/(?:generative-ai|genai)|@google-cloud\/vertexai|@huggingface\/inference|@mistralai\/mistralai|@openrouter\/ai-sdk-provider|\b(?:openai|anthropic|langchain|litellm|ollama|mistralai|mistral-ai|groq|groq-sdk|cohere|cohere-ai|deepseek|xai-sdk|together|together-ai|google-generativeai|google-genai|google-cloud-aiplatform|huggingface-hub|replicate|transformers|vertexai|llama-index|semantic-kernel)\b|["']ai["']\s*:)/i;

function aiEvidenceFiles(files) {
  return matchingFiles(files, (file) => (
    file.isDependencyManifest
      ? AI_DEPENDENCY_PATTERN.test(file.text)
      : patternHasCodeContext(file, AI_SOURCE_PATTERN)
  ));
}

function parseApplicabilityManifest(files) {
  const manifest = files.find((file) => file.relativePath === ".student-telemetry.json");
  if (!manifest) return { present: false, valid: false };
  try {
    const value = JSON.parse(manifest.text);
    const keys = value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value).sort()
      : [];
    const valid = keys.join(",") === "ai_call,reason,schema_version"
      && value.schema_version === 1
      && value.ai_call === "not_applicable"
      && value.reason === "no_runtime_ai";
    return { present: true, valid, relativePath: manifest.relativePath };
  } catch {
    return { present: true, valid: false, relativePath: manifest.relativePath };
  }
}

function hasTokenLikeEnvAssignment(text) {
  const assignmentPattern = /^\s*(?:export\s+)?TEAM_TELEMETRY_TOKEN\s*=\s*(.*?)\s*$/gm;
  let match;
  while ((match = assignmentPattern.exec(text)) !== null) {
    let value = match[1].replace(/\s+#.*$/, "").trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim();
    }
    if (!value || value.startsWith("$") || /^(?:replace|example|your|placeholder|changeme)/i.test(value)) continue;
    if (/^wk_[A-Za-z0-9_-]{32,125}$/.test(value) || /^[A-Za-z0-9._~-]{32,}$/.test(value)) return true;
  }
  return false;
}

export async function verifyProject(projectRoot) {
  const root = path.resolve(projectRoot);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error(`Not a directory: ${root}`);

  const relevantPaths = await collectRelevantFiles(root);
  const files = await Promise.all(relevantPaths.map(async (absolutePath) => {
    const extension = path.extname(absolutePath).toLowerCase();
    const text = await readFile(absolutePath, "utf8");
    return {
      absolutePath,
      relativePath: path.relative(root, absolutePath),
      isSource: SOURCE_EXTENSIONS.has(extension),
      isDependencyManifest: isDependencyManifest(path.basename(absolutePath)),
      isEnvStyle: isEnvStyleFile(path.basename(absolutePath)),
      extension,
      text,
      ...sourceViews(text, extension),
    };
  }));
  const sourceFiles = files.filter((file) => file.isSource);
  const runtimeSourceFiles = sourceFiles.filter((file) => !isTestSource(file.relativePath));
  const projectContext = {
    hasVite: files.some((file) => (
      /(?:^|\/)vite\.config\.[cm]?[jt]s$/.test(relativePathForMatch(file))
      || (file.isDependencyManifest && /["']vite["']\s*:/i.test(file.text))
    )),
    hasNext: files.some((file) => (
      /(?:^|\/)next\.config\.[cm]?[jt]s$/.test(relativePathForMatch(file))
      || (file.isDependencyManifest && /["']next["']\s*:/i.test(file.text))
    )),
    nextStaticExport: files.some((file) => (
      /(?:^|\/)next\.config\.[cm]?[jt]s$/.test(relativePathForMatch(file))
      && /\boutput\s*:\s*["'`]export["'`]/.test(file.commentsStripped)
    )),
    hasJavascriptServerEntry: false,
  };
  projectContext.hasJavascriptServerEntry = runtimeSourceFiles.some(
    (file) => hasJavascriptServerEntryEvidence(file, projectContext),
  );
  const implementationFiles = runtimeSourceFiles.filter((file) => !isTelemetryClient(file.relativePath));
  const provenServerSourceFiles = runtimeSourceFiles.filter((file) => isProvenServerModule(file, projectContext));
  const provenServerFiles = implementationFiles.filter((file) => isProvenServerModule(file, projectContext));
  const hasPythonServer = provenServerSourceFiles.some((file) => file.extension === ".py");
  const hasGoServer = provenServerSourceFiles.some((file) => file.extension === ".go");
  const trustedTransportFiles = runtimeSourceFiles.filter((file) => (
    isProvenServerModule(file, projectContext)
    || (isTelemetryClient(file.relativePath) && file.extension === ".py" && hasPythonServer)
    || (isTelemetryClient(file.relativePath) && file.extension === ".go" && hasGoServer)
  ));
  const checks = [];

  const applicability = parseApplicabilityManifest(files);
  const aiEvidence = aiEvidenceFiles([
    ...runtimeSourceFiles,
    ...files.filter((file) => file.isDependencyManifest),
  ]);

  for (const eventType of ["app_open", "user_action", "ai_call"]) {
    const callSites = matchingFiles(
      provenServerFiles,
      (file) => isEventBoundary(file, projectContext) && hasAwaitedEventCall(file, eventType),
    );
    const aiNotApplicable = eventType === "ai_call"
      && applicability.present
      && applicability.valid
      && aiEvidence.length === 0;
    const passed = callSites.length > 0 || aiNotApplicable;
    checks.push(check(
      `event-${eventType}`,
      passed,
      callSites.length > 0
        ? `${eventType} has a call in a proven server module.`
        : aiNotApplicable
          ? "ai_call is explicitly not applicable because the app declares no runtime AI and no contradictory evidence was found."
        : `${eventType} is missing a call in a proven server module.`,
      aiNotApplicable ? [applicability.relativePath] : callSites,
    ));
  }

  checks.push(check(
    "ai-applicability",
    !applicability.present || (applicability.valid && aiEvidence.length === 0),
    !applicability.present
      ? "No ai_call applicability exception is declared."
      : !applicability.valid
        ? "The .student-telemetry.json applicability declaration is invalid."
        : aiEvidence.length > 0
          ? "The app declares ai_call not applicable but runtime AI evidence exists."
          : "The exact no-runtime-AI declaration has no contradictory source evidence.",
    !applicability.present
      ? []
      : !applicability.valid
        ? [applicability.relativePath]
        : aiEvidence.length > 0
          ? [applicability.relativePath, ...aiEvidence]
          : [applicability.relativePath],
  ));

  const tokenEnvPattern = /process\.env\.TEAM_TELEMETRY_TOKEN\b|process\.env\[\s*["']TEAM_TELEMETRY_TOKEN["']\s*\]|(?:requiredEnvironment|readEnv|getEnv)\(\s*["']TEAM_TELEMETRY_TOKEN["']\s*\)|os\.(?:getenv|environ\.get)\(\s*["']TEAM_TELEMETRY_TOKEN["']|os\.environ\[\s*["']TEAM_TELEMETRY_TOKEN["']\s*\]|os\.Getenv\(\s*["']TEAM_TELEMETRY_TOKEN["']\s*\)/;
  const tokenEnvFiles = matchingFiles(
    trustedTransportFiles,
    (file) => executablePatternTest(file, tokenEnvPattern, /\b(?:process|requiredEnvironment|readEnv|getEnv|os)\b/),
  );
  checks.push(check(
    "server-token-env",
    tokenEnvFiles.length > 0,
    tokenEnvFiles.length > 0
      ? "The team token is read from the server environment."
      : "No process.env.TEAM_TELEMETRY_TOKEN server read was found.",
    tokenEnvFiles,
  ));

  const endpointFiles = matchingFiles(
    trustedTransportFiles,
    hasIngestionEndpointUsage,
  );
  checks.push(check(
    "ingest-endpoint",
    endpointFiles.length > 0,
    endpointFiles.length > 0 ? "The v1 records ingestion endpoint is present." : "No /v1/records endpoint usage was found.",
    endpointFiles,
  ));

  const bearerFiles = matchingFiles(trustedTransportFiles, hasBearerAuthorization);
  checks.push(check(
    "bearer-auth",
    bearerFiles.length > 0,
    bearerFiles.length > 0 ? "A Bearer authorization header is constructed server-side." : "No Bearer authorization header was found.",
    bearerFiles,
  ));

  const idempotencyFiles = matchingFiles(trustedTransportFiles, (file) => (
    hasIdempotencyImplementation(file)
  ));
  checks.push(check(
    "idempotency",
    idempotencyFiles.length > 0,
    idempotencyFiles.length > 0
      ? "Idempotency keys are generated for logical events."
      : "No generated idempotency_key implementation was found.",
    idempotencyFiles,
  ));

  const retryFiles = matchingFiles(trustedTransportFiles, (file) => (
    hasRetryImplementation(file)
  ));
  checks.push(check(
    "bounded-retry",
    retryFiles.length > 0,
    retryFiles.length > 0
      ? "Bounded retry handling for transient failures is present."
      : "No bounded transient-failure retry implementation was found.",
    retryFiles,
  ));

  const cohesiveTransportFiles = matchingFiles(trustedTransportFiles, (file) => (
    executablePatternTest(file, tokenEnvPattern, /\b(?:process|requiredEnvironment|readEnv|getEnv|os)\b/)
    && hasIngestionEndpointUsage(file)
    && hasBearerAuthorization(file)
    && hasIdempotencyImplementation(file)
    && hasRetryImplementation(file)
    && hasCohesiveEventConstruction(file)
  ));
  const telemetryAdapterFiles = runtimeSourceFiles
    .filter((file) => isTelemetryClient(file.relativePath))
    .map((file) => file.relativePath);
  const allAdaptersCohesive = telemetryAdapterFiles.length > 0
    && telemetryAdapterFiles.every((relativePath) => cohesiveTransportFiles.includes(relativePath));
  checks.push(check(
    "cohesive-transport",
    allAdaptersCohesive,
    allAdaptersCohesive
      ? "Every runtime telemetry adapter connects event construction to a complete authenticated, idempotent, retrying transport."
      : "A runtime telemetry adapter is missing or does not contain the complete event-to-transport flow.",
    allAdaptersCohesive
      ? cohesiveTransportFiles
      : [...new Set([...telemetryAdapterFiles, ...cohesiveTransportFiles])],
  ));

  const publicSecretPattern = /\b(?:NEXT_PUBLIC|VITE|PUBLIC|EXPO_PUBLIC|NUXT_PUBLIC)[A-Z0-9_]*TEAM_TELEMETRY_TOKEN\b|\bTEAM_TELEMETRY_TOKEN_(?:PUBLIC|CLIENT)\b/;
  const publicSecretFiles = matchingFiles(files, (file) => publicSecretPattern.test(file.text));
  checks.push(check(
    "no-public-secret",
    publicSecretFiles.length === 0,
    publicSecretFiles.length === 0
      ? "No public-prefixed team token variable was found."
      : "A public-prefixed team token variable exposes the credential to browser code.",
    publicSecretFiles,
  ));

  const literalBearerPattern = /Bearer\s+[A-Za-z0-9._~-]{24,}/;
  const literalAssignmentPattern = /TEAM_TELEMETRY_TOKEN\s*[:=]\s*["'`][A-Za-z0-9._~-]{20,}["'`]/;
  const hardcodedSecretFiles = matchingFiles(files, (file) => literalBearerPattern.test(file.text) || literalAssignmentPattern.test(file.text));
  checks.push(check(
    "no-hardcoded-secret",
    hardcodedSecretFiles.length === 0,
    hardcodedSecretFiles.length === 0
      ? "No hardcoded team token or literal Bearer credential was found."
      : "A token-like literal is hardcoded in source.",
    hardcodedSecretFiles,
  ));

  const envSecretFiles = matchingFiles(
    files.filter((file) => file.isEnvStyle),
    (file) => hasTokenLikeEnvAssignment(file.text),
  );
  checks.push(check(
    "no-env-secret",
    envSecretFiles.length === 0,
    envSecretFiles.length === 0
      ? "No token-like TEAM_TELEMETRY_TOKEN assignment was found in an env-style file."
      : "An env-style file contains a token-like TEAM_TELEMETRY_TOKEN assignment.",
    envSecretFiles,
  ));

  const clientBoundaryFiles = matchingFiles(runtimeSourceFiles, (file) => {
    const trustedLanguageAdapter = isTelemetryClient(file.relativePath)
      && ((file.extension === ".py" && hasPythonServer) || (file.extension === ".go" && hasGoServer));
    const unprovenRuntime = !isProvenServerModule(file, projectContext)
      && !trustedLanguageAdapter;
    if (!isClientModule(file, projectContext) && !unprovenRuntime) return false;
    const importsTelemetryFunction = ["app_open", "user_action", "ai_call"].some(
      (eventType) => importedLocalNames(file.code, eventConvenienceName(eventType)).size > 0,
    );
    const callsTelemetryFunction = /\b(?:logAppOpen|logUserAction|logAiCall|log_app_open|log_user_action|log_ai_call|LogAppOpen|LogUserAction|LogAICall)\s*\(/.test(file.code);
    return /(?:TEAM_TELEMETRY_TOKEN|telemetry\.server|\/v1\/records\b)/.test(file.commentsStripped)
      || importsTelemetryFunction
      || callsTelemetryFunction;
  });
  checks.push(check(
    "server-boundary",
    clientBoundaryFiles.length === 0,
    clientBoundaryFiles.length === 0
      ? "No telemetry credential, server module, or direct ingestion call crosses into a client or unproven runtime."
      : "A client or unproven runtime references telemetry credentials, imports/calls a telemetry logger, or uses the collection endpoint.",
    clientBoundaryFiles,
  ));

  const sensitiveAiFiles = inspectTelemetryPayloads(implementationFiles);
  checks.push(check(
    "no-sensitive-ai-payload",
    sensitiveAiFiles.length === 0,
    sensitiveAiFiles.length === 0
      ? "No obvious content, credential, or personal-data field appears in direct telemetry payloads."
      : "A direct telemetry payload contains a forbidden content, credential, or identity field.",
    sensitiveAiFiles,
  ));

  const floatingFiles = floatingTelemetryFiles(implementationFiles);
  checks.push(check(
    "no-floating-telemetry",
    floatingFiles.length === 0,
    floatingFiles.length === 0
      ? "No telemetry event or wrapper is discarded through a detached or unawaited task."
      : "A telemetry event or wrapper is detached or unawaited; complete it at the trusted boundary before returning.",
    floatingFiles,
  ));

  return {
    root,
    sourceFileCount: sourceFiles.length,
    passed: checks.every((item) => item.passed),
    checks,
    note: "Static verification is a guardrail, not proof of runtime delivery. Run an API integration test before training.",
  };
}

function printHuman(result) {
  for (const item of result.checks) {
    const status = item.passed ? "PASS" : "FAIL";
    console.log(`${status}  ${item.id}  ${item.message}`);
    for (const file of item.files) console.log(`      ${file}`);
  }
  const passedCount = result.checks.filter((item) => item.passed).length;
  console.log(`\n${result.passed ? "PASS" : "FAIL"}: ${passedCount}/${result.checks.length} checks passed across ${result.sourceFileCount} source files.`);
  console.log(result.note);
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const projectRoot = args.find((argument) => !argument.startsWith("--"));
  if (!projectRoot) {
    console.error("Usage: verify-telemetry.mjs [--json] <student-app-directory>");
    process.exitCode = 2;
    return;
  }

  try {
    const result = await verifyProject(projectRoot);
    if (json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) await main();
