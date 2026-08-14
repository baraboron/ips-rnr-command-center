#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".go",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".py",
  ".ts",
  ".tsx",
]);
const MANIFEST_FILENAMES = new Set([
  "go.mod",
  "package.json",
  "Pipfile",
  "pyproject.toml",
  "requirements.txt",
]);
const CONFIG_PATTERNS = [
  /^next\.config\.[cm]?[jt]s$/,
  /^vite\.config\.[cm]?[jt]s$/,
];
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
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 10_000;
const NEXT_STATIC_EXPORT_PATTERN = /\boutput\s*:\s*["'`]export["'`]/;
const NEXT_EDGE_RUNTIME_PATTERN = /\bexport\s+const\s+runtime(?:\s*:\s*[^=;\n]+)?\s*=\s*["'`]edge["'`]/;

function stripSourceComments(text, extension) {
  const output = text.split("");
  const python = extension === ".py";
  const slashComments = SOURCE_EXTENSIONS.has(extension) && !python;
  let state = "code";
  let quote = "";
  let triple = false;
  const blank = (index) => {
    if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
  };

  for (let index = 0; index < text.length;) {
    const character = text[index];
    const next = text[index + 1];
    if (state === "line-comment") {
      if (character === "\n" || character === "\r") state = "code";
      else blank(index);
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
        index += 2;
        continue;
      }
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
    const startsPythonTriple = python
      && (character === "\"" || character === "'")
      && text.slice(index, index + 3) === character.repeat(3);
    if (startsPythonTriple || character === "\"" || character === "'" || (!python && character === "`")) {
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

const FRAMEWORKS = {
  nextjs: { label: "Next.js", runtime: "node" },
  vite: { label: "Vite", runtime: "node" },
  express: { label: "Express", runtime: "node" },
  fastify: { label: "Fastify", runtime: "node" },
  koa: { label: "Koa", runtime: "node" },
  hapi: { label: "Hapi", runtime: "node" },
  nestjs: { label: "NestJS", runtime: "node" },
  hono: { label: "Hono", runtime: "node" },
  fastapi: { label: "FastAPI", runtime: "python" },
  flask: { label: "Flask", runtime: "python" },
  "go-http": { label: "Go HTTP", runtime: "go" },
  "go-gin": { label: "Gin", runtime: "go" },
  "go-echo": { label: "Echo", runtime: "go" },
  "go-fiber": { label: "Fiber", runtime: "go" },
  "go-chi": { label: "Chi", runtime: "go" },
};

const NODE_FRAMEWORK_PACKAGES = new Map([
  ["next", "nextjs"],
  ["vite", "vite"],
  ["express", "express"],
  ["fastify", "fastify"],
  ["koa", "koa"],
  ["@hapi/hapi", "hapi"],
  ["@nestjs/core", "nestjs"],
  ["hono", "hono"],
]);

const NODE_FRAMEWORK_PATTERNS = [
  ["nextjs", /(?:\bfrom\s+["']next\/server["']|\brequire\(\s*["']next["']\s*\)|\bNextResponse\b)/],
  ["express", /(?:\bfrom\s+["']express["']|\brequire\(\s*["']express["']\s*\)|\bexpress\s*\(\s*\))/],
  ["fastify", /(?:\bfrom\s+["']fastify["']|\brequire\(\s*["']fastify["']\s*\)|\bfastify\s*\(\s*\))/i],
  ["koa", /(?:\bfrom\s+["']koa["']|\brequire\(\s*["']koa["']\s*\)|\bnew\s+Koa\s*\()/],
  ["hapi", /(?:\bfrom\s+["']@hapi\/hapi["']|\brequire\(\s*["']@hapi\/hapi["']\s*\)|\bHapi\.server\s*\()/],
  ["nestjs", /(?:\bfrom\s+["']@nestjs\/core["']|\bNestFactory\.create\s*\()/],
  ["hono", /(?:\bfrom\s+["']hono["']|\brequire\(\s*["']hono["']\s*\)|\bnew\s+Hono\s*\()/],
];

const PYTHON_FRAMEWORK_PATTERNS = [
  ["fastapi", /(?:\bfrom\s+fastapi\s+import\b|\bimport\s+fastapi\b|\bFastAPI\s*\()/],
  ["flask", /(?:\bfrom\s+flask\s+import\b|\bimport\s+flask\b|\bFlask\s*\()/],
];

const GO_FRAMEWORK_PATTERNS = [
  ["go-gin", /(?:github\.com\/gin-gonic\/gin|\bgin\.(?:Default|New)\s*\()/],
  ["go-echo", /(?:github\.com\/labstack\/echo|\becho\.New\s*\()/],
  ["go-fiber", /(?:github\.com\/gofiber\/fiber|\bfiber\.New\s*\()/],
  ["go-chi", /(?:github\.com\/go-chi\/chi|\bchi\.NewRouter\s*\()/],
  ["go-http", /(?:["']net\/http["']|\bhttp\.(?:Handle|HandleFunc|ListenAndServe|Server)\b)/],
];

const AI_SDKS = {
  openai: { label: "OpenAI", packages: ["openai", "@ai-sdk/openai"] },
  anthropic: { label: "Anthropic", packages: ["@anthropic-ai/sdk", "@ai-sdk/anthropic"] },
  gemini: { label: "Google Gemini", packages: ["@google/generative-ai", "@google/genai", "@ai-sdk/google"] },
  "vercel-ai": { label: "Vercel AI SDK", packages: ["ai"] },
  langchain: { label: "LangChain", packagePrefixes: ["@langchain/"], packages: ["langchain"] },
  litellm: { label: "LiteLLM", packages: ["litellm"] },
  ollama: { label: "Ollama", packages: ["ollama"] },
  groq: { label: "Groq", packages: ["groq-sdk", "@ai-sdk/groq"] },
  mistral: { label: "Mistral", packages: ["@mistralai/mistralai", "@ai-sdk/mistral"] },
  cohere: { label: "Cohere", packages: ["cohere-ai", "@ai-sdk/cohere"] },
  bedrock: { label: "Amazon Bedrock", packages: ["@aws-sdk/client-bedrock-runtime"] },
  "azure-openai": { label: "Azure OpenAI", packages: ["@azure/openai"] },
  deepseek: { label: "DeepSeek", packages: ["@ai-sdk/deepseek", "deepseek"] },
  xai: { label: "xAI", packages: ["@ai-sdk/xai", "xai-sdk"] },
  vertex: { label: "Google Vertex AI", packages: ["@google-cloud/vertexai", "@ai-sdk/google-vertex"] },
  together: { label: "Together AI", packages: ["together-ai", "@ai-sdk/togetherai"] },
  huggingface: { label: "Hugging Face Inference", packages: ["@huggingface/inference"] },
  replicate: { label: "Replicate", packages: ["replicate"] },
  perplexity: { label: "Perplexity", packages: ["@ai-sdk/perplexity"] },
  openrouter: { label: "OpenRouter", packages: ["@openrouter/ai-sdk-provider"] },
};

const AI_SOURCE_PATTERNS = [
  ["openai", /(?:\bfrom\s+["']openai["']|\brequire\(\s*["']openai["']\s*\)|\bfrom\s+openai\s+import\b|github\.com\/openai\/openai-go)/],
  ["anthropic", /(?:@anthropic-ai\/sdk|\bfrom\s+anthropic\s+import\b|\bimport\s+anthropic\b|anthropic-sdk-go)/],
  ["gemini", /(?:@google\/(?:generative-ai|genai)|\bgoogle\.(?:generativeai|genai)\b|google\.golang\.org\/genai|generative-ai-go)/],
  ["vercel-ai", /(?:\bfrom\s+["']ai["']|\brequire\(\s*["']ai["']\s*\))/],
  ["langchain", /(?:@langchain\/|\bfrom\s+langchain\b|\bimport\s+langchain\b|tmc\/langchaingo)/],
  ["litellm", /(?:\bfrom\s+litellm\b|\bimport\s+litellm\b)/],
  ["ollama", /(?:\bfrom\s+["']ollama["']|\bfrom\s+ollama\b|\bimport\s+ollama\b|ollama\/ollama\/api)/],
  ["groq", /(?:groq-sdk|\bfrom\s+groq\s+import\b|\bimport\s+groq\b)/],
  ["mistral", /(?:@mistralai\/mistralai|\bfrom\s+mistralai\b|\bimport\s+mistralai\b)/],
  ["cohere", /(?:cohere-ai|\bfrom\s+cohere\b|\bimport\s+cohere\b)/],
  ["bedrock", /(?:@aws-sdk\/client-bedrock-runtime|\bBedrockRuntimeClient\b|aws-sdk-go-v2\/service\/bedrockruntime|["']bedrock-runtime["'])/],
  ["azure-openai", /(?:@azure\/openai|\bAzureOpenAI\b)/],
  ["deepseek", /(?:@ai-sdk\/deepseek|\bfrom\s+deepseek\b|\bimport\s+deepseek\b)/],
  ["xai", /(?:@ai-sdk\/xai|\bfrom\s+xai_sdk\b|\bimport\s+xai_sdk\b)/],
  ["vertex", /(?:@google-cloud\/vertexai|@ai-sdk\/google-vertex|\bgoogle\.cloud\.aiplatform\b|\bvertexai\b)/],
  ["together", /(?:together-ai|@ai-sdk\/togetherai|\bfrom\s+together\b|\bimport\s+together\b)/],
  ["huggingface", /(?:@huggingface\/inference|\bhuggingface_hub\b)/],
  ["replicate", /(?:\bfrom\s+["']replicate["']|\brequire\(\s*["']replicate["']|\bfrom\s+replicate\b|\bimport\s+replicate\b)/],
  ["perplexity", /(?:@ai-sdk\/perplexity)/],
  ["openrouter", /(?:@openrouter\/ai-sdk-provider)/],
];

const AI_ENDPOINT_PATTERNS = [
  ["gemini", /\bgenerativelanguage\.googleapis\.com\b/i],
  ["openai", /\bapi\.openai\.com\b/i],
  ["anthropic", /\bapi\.anthropic\.com\b/i],
  ["bedrock", /\bbedrock-runtime(?:\.[a-z0-9-]+)?\.amazonaws\.com\b/i],
  ["azure-openai", /\b[a-z0-9-]+\.openai\.azure\.com\b/i],
  ["ollama", /(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?\/api\/(?:chat|generate)\b/i],
  ["groq", /\bapi\.groq\.com\b/i],
  ["mistral", /\bapi\.mistral\.ai\b/i],
  ["cohere", /\bapi\.cohere\.(?:com|ai)\b/i],
  ["deepseek", /\bapi\.deepseek\.com\b/i],
  ["xai", /\bapi\.x\.ai\b/i],
  ["vertex", /\baiplatform\.googleapis\.com\b/i],
  ["together", /\bapi\.together\.xyz\b/i],
  ["huggingface", /\b(?:api-inference|router|inference)\.huggingface\.co\b/i],
  ["replicate", /\bapi\.replicate\.com\b/i],
  ["perplexity", /\bapi\.perplexity\.ai\b/i],
  ["openrouter", /\bopenrouter\.ai\/api\b/i],
];

function normalizeRelativePath(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function shouldInspectFile(filename) {
  return SOURCE_EXTENSIONS.has(path.extname(filename).toLowerCase())
    || MANIFEST_FILENAMES.has(filename)
    || /^requirements(?:[-_.][A-Za-z0-9_.-]+)?\.txt$/i.test(filename)
    || CONFIG_PATTERNS.some((pattern) => pattern.test(filename));
}

async function collectInspectableFiles(root, directory = root, files = [], skippedFiles = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
        await collectInspectableFiles(root, absolutePath, files, skippedFiles);
      }
      continue;
    }
    if (!entry.isFile() || !shouldInspectFile(entry.name)) continue;
    if (files.length + skippedFiles.length >= MAX_FILES) {
      throw new Error(`Inspection file limit exceeded under: ${root}`);
    }

    const fileStat = await stat(absolutePath);
    if (fileStat.size > MAX_FILE_BYTES) {
      skippedFiles.push(normalizeRelativePath(root, absolutePath));
      continue;
    }
    files.push({
      absolutePath,
      relativePath: normalizeRelativePath(root, absolutePath),
      extension: path.extname(entry.name).toLowerCase(),
      basename: entry.name,
    });
  }
  return { files, skippedFiles };
}

function addEvidence(map, id, relativePath, confidence = "medium") {
  const confidenceRank = { low: 1, medium: 2, high: 3 };
  const current = map.get(id) ?? { confidence: "low", evidenceFiles: new Set() };
  if (confidenceRank[confidence] > confidenceRank[current.confidence]) current.confidence = confidence;
  current.evidenceFiles.add(relativePath);
  map.set(id, current);
}

function addAiEvidence(map, id, relativePath, evidenceType) {
  const current = map.get(id) ?? new Map();
  const types = current.get(relativePath) ?? new Set();
  types.add(evidenceType);
  current.set(relativePath, types);
  map.set(id, current);
}

function packageDependencies(packageText) {
  try {
    const manifest = JSON.parse(packageText);
    return new Set(Object.keys({
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
    }));
  } catch {
    return new Set();
  }
}

function containsDependency(manifestText, dependency) {
  const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s"'])${escaped}(?:$|[\\s"'@<>=~^])`, "m").test(manifestText);
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
      if (before === remaining) break;
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

function isNextServerPath(relativePath) {
  return /(?:^|\/)app(?:\/.*)?\/route\.[cm]?[jt]s$/.test(relativePath)
    || /(?:^|\/)pages\/api\/.+\.[cm]?[jt]s$/.test(relativePath);
}

function isServerNamedPath(relativePath) {
  const basename = path.posix.basename(relativePath);
  return /\.server\.[cm]?[jt]sx?$/.test(basename)
    || /(?:^|\/)(?:server|functions|workers)\//.test(relativePath)
    || /^(?:app|application|main|server|index)\.[cm]?[jt]s$/.test(basename);
}

function runtimeSet(frameworks) {
  return new Set(frameworks.map((framework) => framework.runtime));
}

function primaryRuntimeFor(frameworks) {
  const runtimes = runtimeSet(frameworks);
  if (runtimes.size === 0) return "unknown";
  if (runtimes.size > 1) return "mixed";
  return [...runtimes][0];
}

function applicationTypeFor(frameworks, serverEntryCandidates, isNextStaticExport) {
  const ids = new Set(frameworks.map((framework) => framework.id));
  const hasVite = ids.has("vite");
  const hasNext = ids.has("nextjs");
  if (serverEntryCandidates.length > 0) {
    return hasNext || hasVite ? "fullstack" : "server";
  }
  if (isNextStaticExport || hasVite) return "client-only";
  return "unknown";
}

function frameworkOutput(frameworkEvidence) {
  return [...frameworkEvidence.entries()]
    .map(([id, evidence]) => ({
      id,
      label: FRAMEWORKS[id].label,
      runtime: FRAMEWORKS[id].runtime,
      confidence: evidence.confidence,
      evidenceFiles: [...evidence.evidenceFiles].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function aiIntegrationOutput(aiEvidence) {
  return [...aiEvidence.entries()]
    .map(([id, evidenceByFile]) => {
      const evidence = ["endpoint", "package", "source"]
        .map((type) => ({
          type,
          files: [...evidenceByFile.entries()]
            .filter(([, types]) => types.has(type))
            .map(([relativePath]) => relativePath)
            .sort(),
        }))
        .filter((item) => item.files.length > 0);
      return {
        id,
        label: AI_SDKS[id].label,
        evidenceTypes: evidence.map((item) => item.type),
        evidenceFiles: [...evidenceByFile.keys()].sort(),
        evidence,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function inspectProject(projectRoot) {
  const root = path.resolve(projectRoot);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error(`Not a directory: ${root}`);

  const { files, skippedFiles } = await collectInspectableFiles(root);
  const inspectedFiles = await Promise.all(files.map(async (file) => ({
    ...file,
    text: await readFile(file.absolutePath, "utf8"),
  })));

  const frameworkEvidence = new Map();
  const aiEvidence = new Map();
  const serverEntryCandidates = new Set();
  const nextServerEntryCandidates = new Set();
  const nonNextServerEntryCandidates = new Set();
  const nextStaticExportFiles = new Set();
  const nextEdgeRuntimeFiles = new Set();

  for (const file of inspectedFiles) {
    const { basename, extension, relativePath, text } = file;
    const detectionText = SOURCE_EXTENSIONS.has(extension)
      ? stripSourceComments(text, extension)
      : text;

    if (basename === "package.json") {
      const dependencies = packageDependencies(text);
      for (const [dependency, frameworkId] of NODE_FRAMEWORK_PACKAGES) {
        if (dependencies.has(dependency)) addEvidence(frameworkEvidence, frameworkId, relativePath, "high");
      }
      for (const [sdkId, sdk] of Object.entries(AI_SDKS)) {
        const found = sdk.packages?.some((dependency) => dependencies.has(dependency))
          || sdk.packagePrefixes?.some((prefix) => [...dependencies].some((dependency) => dependency.startsWith(prefix)));
        if (found) addAiEvidence(aiEvidence, sdkId, relativePath, "package");
      }
    }

    if (/^next\.config\.[cm]?[jt]s$/.test(basename)) {
      addEvidence(frameworkEvidence, "nextjs", relativePath, "high");
      if (NEXT_STATIC_EXPORT_PATTERN.test(detectionText)) nextStaticExportFiles.add(relativePath);
    }
    if (/^vite\.config\.[cm]?[jt]s$/.test(basename)) {
      addEvidence(frameworkEvidence, "vite", relativePath, "high");
    }

    if (/^requirements(?:[-_.][A-Za-z0-9_.-]+)?\.txt$/i.test(basename) || ["pyproject.toml", "Pipfile"].includes(basename)) {
      if (containsDependency(text, "fastapi")) addEvidence(frameworkEvidence, "fastapi", relativePath, "high");
      if (containsDependency(text, "flask")) addEvidence(frameworkEvidence, "flask", relativePath, "high");
      for (const sdkId of ["openai", "anthropic", "langchain", "litellm", "ollama", "groq", "mistral", "cohere"]) {
        if (containsDependency(text, sdkId === "mistral" ? "mistralai" : sdkId)) {
          addAiEvidence(aiEvidence, sdkId, relativePath, "package");
        }
      }
      if (/google-(?:generativeai|genai)/i.test(text)) {
        addAiEvidence(aiEvidence, "gemini", relativePath, "package");
      }
      const pythonAiPackages = [
        ["deepseek", /\bdeepseek\b/i],
        ["xai", /\bxai-sdk\b/i],
        ["vertex", /\bgoogle-cloud-aiplatform\b|\bvertexai\b/i],
        ["together", /\btogether\b/i],
        ["huggingface", /\bhuggingface[_-]hub\b|\btransformers\b/i],
        ["replicate", /\breplicate\b/i],
      ];
      for (const [sdkId, pattern] of pythonAiPackages) {
        if (pattern.test(text)) addAiEvidence(aiEvidence, sdkId, relativePath, "package");
      }
    }

    if (basename === "go.mod") {
      for (const [frameworkId, pattern] of GO_FRAMEWORK_PATTERNS.slice(0, 4)) {
        if (pattern.test(text)) addEvidence(frameworkEvidence, frameworkId, relativePath, "high");
      }
    }

    if ([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"].includes(extension)) {
      for (const [frameworkId, pattern] of NODE_FRAMEWORK_PATTERNS) {
        if (pattern.test(detectionText)) {
          addEvidence(frameworkEvidence, frameworkId, relativePath, "medium");
          if (frameworkId !== "nextjs" && (isServerNamedPath(relativePath) || /\.(?:listen|route|get|post|put|patch|delete)\s*\(/.test(detectionText))) {
            serverEntryCandidates.add(relativePath);
            nonNextServerEntryCandidates.add(relativePath);
          }
        }
      }
      if (isNextServerPath(relativePath)) {
        addEvidence(frameworkEvidence, "nextjs", relativePath, "high");
        serverEntryCandidates.add(relativePath);
        nextServerEntryCandidates.add(relativePath);
      } else if (leadingDirectives(text).has("use server")) {
        serverEntryCandidates.add(relativePath);
        nextServerEntryCandidates.add(relativePath);
      }
      if (NEXT_EDGE_RUNTIME_PATTERN.test(detectionText)) nextEdgeRuntimeFiles.add(relativePath);
    }

    if (extension === ".py") {
      for (const [frameworkId, pattern] of PYTHON_FRAMEWORK_PATTERNS) {
        if (pattern.test(detectionText)) {
          addEvidence(frameworkEvidence, frameworkId, relativePath, "medium");
          serverEntryCandidates.add(relativePath);
          nonNextServerEntryCandidates.add(relativePath);
        }
      }
    }

    if (extension === ".go") {
      let goServerSource = false;
      for (const [frameworkId, pattern] of GO_FRAMEWORK_PATTERNS) {
        if (pattern.test(detectionText)) {
          addEvidence(frameworkEvidence, frameworkId, relativePath, "medium");
          goServerSource = true;
        }
      }
      if (goServerSource) {
        serverEntryCandidates.add(relativePath);
        nonNextServerEntryCandidates.add(relativePath);
      }
    }

    if (SOURCE_EXTENSIONS.has(extension)) {
      for (const [sdkId, pattern] of AI_SOURCE_PATTERNS) {
        if (pattern.test(detectionText)) {
          addAiEvidence(aiEvidence, sdkId, relativePath, "source");
        }
      }
      for (const [providerId, pattern] of AI_ENDPOINT_PATTERNS) {
        if (pattern.test(detectionText)) addAiEvidence(aiEvidence, providerId, relativePath, "endpoint");
      }
    }
  }

  const frameworks = frameworkOutput(frameworkEvidence);
  const hasNextFramework = frameworks.some((framework) => framework.id === "nextjs");
  const isNextStaticExport = nextStaticExportFiles.size > 0;
  const sortedServerCandidates = [...serverEntryCandidates]
    .filter((relativePath) => (
      nonNextServerEntryCandidates.has(relativePath)
      || (
        hasNextFramework
        && !isNextStaticExport
        && nextServerEntryCandidates.has(relativePath)
      )
    ))
    .sort();
  const sortedNextEdgeRuntimeFiles = hasNextFramework ? [...nextEdgeRuntimeFiles].sort() : [];
  const applicationType = applicationTypeFor(frameworks, sortedServerCandidates, isNextStaticExport);
  const warnings = [];
  if (applicationType === "client-only") warnings.push("client-only-no-trustworthy-server-boundary");
  if (frameworks.length === 0) warnings.push("framework-not-detected");
  if (isNextStaticExport) warnings.push("next-static-export-no-runtime-server-boundary");
  if (sortedNextEdgeRuntimeFiles.length > 0) warnings.push("next-edge-runtime-incompatible-with-bundled-client");
  if (
    sortedServerCandidates.length === 0
    && frameworks.some((framework) => framework.id !== "vite")
  ) {
    warnings.push("server-entry-not-detected");
  }
  if (aiEvidence.size === 0) warnings.push("ai-integration-not-detected-inspect-runtime-call-sites-before-declaring-not-applicable");

  return {
    schemaVersion: 1,
    root,
    readOnly: true,
    applicationType,
    primaryRuntime: primaryRuntimeFor(frameworks),
    serverBoundary: sortedServerCandidates.length > 0
      ? "available"
      : (applicationType === "client-only" ? "missing" : "unknown"),
    frameworks,
    aiIntegrationHints: aiIntegrationOutput(aiEvidence),
    serverEntryCandidates: sortedServerCandidates,
    nextStaticExportFiles: [...nextStaticExportFiles].sort(),
    nextEdgeRuntimeFiles: sortedNextEdgeRuntimeFiles,
    skippedFiles: skippedFiles.sort(),
    warnings,
  };
}

function formatEvidence(files) {
  return files.length > 0 ? files.join(", ") : "(none)";
}

export function formatHumanResult(result) {
  const lines = [
    "Application inspection (read-only)",
    `root: ${result.root}`,
    `application type: ${result.applicationType}`,
    `primary runtime: ${result.primaryRuntime}`,
    `server boundary: ${result.serverBoundary}`,
    "frameworks:",
  ];
  if (result.frameworks.length === 0) lines.push("- (none detected)");
  for (const framework of result.frameworks) {
    lines.push(`- ${framework.label} [${framework.confidence}]: ${formatEvidence(framework.evidenceFiles)}`);
  }
  lines.push("AI integration hints:");
  if (result.aiIntegrationHints.length === 0) {
    lines.push("- not detected; inspect runtime call sites before declaring N/A");
  }
  for (const integration of result.aiIntegrationHints) {
    lines.push(`- ${integration.label} [${integration.evidenceTypes.join(", ")}]: ${formatEvidence(integration.evidenceFiles)}`);
  }
  if (result.nextStaticExportFiles.length > 0) {
    lines.push(`Next.js static export config: ${formatEvidence(result.nextStaticExportFiles)}`);
  }
  if (result.nextEdgeRuntimeFiles.length > 0) {
    lines.push(`Next.js Edge runtime files: ${formatEvidence(result.nextEdgeRuntimeFiles)}`);
  }
  lines.push("candidate server files:");
  if (result.serverEntryCandidates.length === 0) lines.push("- (none detected)");
  for (const relativePath of result.serverEntryCandidates) lines.push(`- ${relativePath}`);
  if (result.skippedFiles.length > 0) {
    lines.push("skipped oversized files:");
    for (const relativePath of result.skippedFiles) lines.push(`- ${relativePath}`);
  }
  if (result.warnings.length > 0) {
    lines.push("warnings:");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }
  return lines.join("\n");
}

function parseArguments(arguments_) {
  let json = false;
  let help = false;
  let projectRoot;
  for (const argument of arguments_) {
    if (argument === "--json") json = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    else if (projectRoot) throw new Error("Only one project directory may be inspected.");
    else projectRoot = argument;
  }
  return { json, help, projectRoot: projectRoot ?? process.cwd() };
}

function usage() {
  return "Usage: node inspect-app.mjs [--json] [project-directory]";
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await inspectProject(options.projectRoot);
  console.log(options.json ? JSON.stringify(result, null, 2) : formatHumanResult(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`inspect-app failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
