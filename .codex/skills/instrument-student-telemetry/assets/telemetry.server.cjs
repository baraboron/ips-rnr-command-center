"use strict";
/**
 * Server-runtime telemetry client for student applications.
 *
 * Keep this module behind the application's server boundary. This CommonJS
 * variant uses a Node built-in and must never enter a browser bundle.
 */
// Generic CommonJS Node server module. Never import this file from a browser bundle.
Object.defineProperty(exports, "__esModule", { value: true });
exports.flushTelemetry = flushTelemetry;
exports.pendingTelemetryCount = pendingTelemetryCount;
exports.logAppOpen = logAppOpen;
exports.logUserAction = logUserAction;
exports.logAiCall = logAiCall;
const node_crypto_1 = require("node:crypto");
const MAX_BATCH_SIZE = 100;
const MAX_PENDING_RECORDS = 1_000;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 8_000;
const BASE_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 4_000;
const RETRYABLE_STATUSES = new Set([408, 425, 429]);
const APP_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const EVENT_CODE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/;
const USER_REF_PATTERN = /^(?:anon|usr)_[a-zA-Z0-9_-]{16,96}$/;
const FORBIDDEN_PAYLOAD_KEY = /(?:^|_)(?:authorization|api_key|team_token|access_token|refresh_token|id_token|session_token|auth_token|bearer_token|email|user_name|username|first_name|last_name|full_name|real_name|prompt|question|messages?|response|answer|content|input|output|text|error_message|stack_trace)$/i;
const pendingRecords = new Map();
let activeFlush;
class DeliveryError extends Error {
    retryable;
    constructor(message, retryable) {
        super(message);
        this.retryable = retryable;
        this.name = "TelemetryDeliveryError";
    }
}
function assertServerRuntime() {
    if (typeof window !== "undefined") {
        throw new Error("Telemetry must run on the server; do not import the telemetry server module into client code.");
    }
}
function requiredEnvironment(name) {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Missing server environment variable: ${name}`);
    }
    return value;
}
function resolveEndpoint(apiUrl) {
    let url;
    try {
        url = new URL(apiUrl);
    }
    catch {
        throw new Error("TEAM_TELEMETRY_API_URL must be a valid absolute URL.");
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const ipv4Parts = hostname.split(".");
    const isIPv4Loopback = ipv4Parts.length === 4
        && ipv4Parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
        && Number(ipv4Parts[0]) === 127;
    const isLoopback = hostname === "localhost" || hostname === "::1" || isIPv4Loopback;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
        throw new Error("TEAM_TELEMETRY_API_URL must use HTTPS except for localhost or a loopback IP.");
    }
    const hasUserInfoDelimiter = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*@/.test(apiUrl);
    if (url.username || url.password || hasUserInfoDelimiter) {
        throw new Error("TEAM_TELEMETRY_API_URL must not contain credentials.");
    }
    if (url.href.includes("?") || url.href.includes("#")) {
        throw new Error("TEAM_TELEMETRY_API_URL must not contain a query string or fragment.");
    }
    if (!url.pathname.endsWith("/v1/records")) {
        url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/records`;
    }
    return url.toString();
}
function readRuntimeConfig() {
    assertServerRuntime();
    const appKey = requiredEnvironment("TEAM_TELEMETRY_APP_KEY");
    const appName = requiredEnvironment("TEAM_TELEMETRY_APP_NAME");
    if (!APP_KEY_PATTERN.test(appKey)) {
        throw new Error("TEAM_TELEMETRY_APP_KEY must match ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$.");
    }
    if (appName.length > 120) {
        throw new Error("TEAM_TELEMETRY_APP_NAME must be 120 characters or fewer.");
    }
    return {
        endpoint: resolveEndpoint(requiredEnvironment("TEAM_TELEMETRY_API_URL")),
        teamToken: requiredEnvironment("TEAM_TELEMETRY_TOKEN"),
        app: { key: appKey, name: appName },
    };
}
function assertFiniteNonNegative(value, field) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        throw new Error(`${field} must be a finite non-negative number.`);
    }
}
function assertSafeUserRef(userRef) {
    if (userRef === undefined)
        return;
    if (!USER_REF_PATTERN.test(userRef)) {
        throw new Error("userRef must be an opaque pseudonymous value prefixed with anon_ or usr_ and containing 16-96 URL-safe characters.");
    }
}
function assertJsonAndSafePayload(value, path = "payload", seen = new Set()) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return;
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new Error(`${path} contains a non-finite number.`);
        return;
    }
    if (typeof value !== "object")
        throw new Error(`${path} must contain JSON values only.`);
    if (seen.has(value))
        throw new Error(`${path} contains a circular value.`);
    seen.add(value);
    if (Array.isArray(value)) {
        value.forEach((item, index) => assertJsonAndSafePayload(item, `${path}[${index}]`, seen));
    }
    else {
        for (const [key, item] of Object.entries(value)) {
            const normalizedKey = key
                .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
                .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
                .replace(/[^a-zA-Z0-9]+/g, "_")
                .replace(/^_+|_+$/g, "")
                .toLowerCase();
            if (FORBIDDEN_PAYLOAD_KEY.test(normalizedKey)) {
                throw new Error(`${path}.${key} is forbidden telemetry content; send operational metadata only.`);
            }
            assertJsonAndSafePayload(item, `${path}.${key}`, seen);
        }
    }
    seen.delete(value);
}
function normalizeShortCode(value, field) {
    const normalized = value.trim();
    if (!EVENT_CODE_PATTERN.test(normalized)) {
        throw new Error(`${field} must be a stable code of 1-100 letters, numbers, dot, underscore, colon, or hyphen.`);
    }
    return normalized;
}
function makeRecord(eventType, payload, common) {
    assertSafeUserRef(common.userRef);
    assertJsonAndSafePayload(payload);
    const record = {
        event_type: eventType,
        occurred_at: (common.occurredAt ?? new Date()).toISOString(),
        idempotency_key: common.idempotencyKey ?? (0, node_crypto_1.randomUUID)(),
        schema_version: 1,
        payload,
    };
    if (common.userRef !== undefined)
        record.user_ref = common.userRef;
    return record;
}
function enqueue(record) {
    if (pendingRecords.has(record.idempotency_key))
        return;
    if (pendingRecords.size >= MAX_PENDING_RECORDS) {
        const oldestKey = pendingRecords.keys().next().value;
        if (oldestKey)
            pendingRecords.delete(oldestKey);
        console.warn("Student telemetry queue reached its in-process limit; the oldest event was dropped.");
    }
    pendingRecords.set(record.idempotency_key, record);
}
function retryDelayMs(attempt, retryAfter) {
    if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS);
        }
        const dateMs = Date.parse(retryAfter);
        if (Number.isFinite(dateMs)) {
            return Math.min(Math.max(dateMs - Date.now(), 0), MAX_RETRY_DELAY_MS);
        }
    }
    const exponential = Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
    return Math.round(exponential * (0.75 + Math.random() * 0.5));
}
function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function postBatch(config, records) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let retryAfter = null;
        try {
            const response = await fetch(config.endpoint, {
                method: "POST",
                redirect: "error",
                headers: {
                    Authorization: `Bearer ${config.teamToken}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ app: config.app, records }),
                cache: "no-store",
                signal: controller.signal,
            });
            retryAfter = response.headers.get("Retry-After");
            if (response.ok)
                return;
            const retryable = RETRYABLE_STATUSES.has(response.status)
                || (response.status >= 500 && response.status <= 599);
            lastError = new DeliveryError(`Telemetry API returned HTTP ${response.status}.`, retryable);
            if (!retryable)
                throw lastError;
        }
        catch (error) {
            if (error instanceof DeliveryError) {
                if (!error.retryable)
                    throw error;
                lastError = error;
            }
            else {
                lastError = new DeliveryError(error instanceof Error && error.name === "AbortError"
                    ? "Telemetry API request timed out."
                    : "Telemetry API request failed.", true);
            }
        }
        finally {
            clearTimeout(timeout);
        }
        if (attempt < MAX_ATTEMPTS)
            await sleep(retryDelayMs(attempt, retryAfter));
    }
    throw lastError ?? new DeliveryError("Telemetry delivery failed.", true);
}
async function flushLoop() {
    const config = readRuntimeConfig();
    let deliveredCount = 0;
    while (pendingRecords.size > 0) {
        const batch = Array.from(pendingRecords.values()).slice(0, MAX_BATCH_SIZE);
        try {
            await postBatch(config, batch);
        }
        catch (error) {
            if (error instanceof DeliveryError && !error.retryable) {
                for (const record of batch)
                    pendingRecords.delete(record.idempotency_key);
                console.warn("Student telemetry batch was permanently rejected and dropped from the best-effort queue.", { eventCount: batch.length });
            }
            throw error;
        }
        for (const record of batch)
            pendingRecords.delete(record.idempotency_key);
        deliveredCount += batch.length;
    }
    return { deliveredCount, queuedCount: pendingRecords.size };
}
/** Retry all queued records. A serverless instance's memory is not durable. */
async function flushTelemetry() {
    if (!activeFlush) {
        activeFlush = flushLoop().finally(() => {
            activeFlush = undefined;
        });
    }
    return activeFlush;
}
async function enqueueAndFlush(record) {
    enqueue(record);
    try {
        await flushTelemetry();
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : "Telemetry delivery failed.";
        console.warn("Student telemetry delivery is queued for a later best-effort retry.", {
            eventType: record.event_type,
            idempotencyKey: record.idempotency_key,
            reason,
        });
        return {
            delivered: false,
            idempotencyKey: record.idempotency_key,
            queued: pendingRecords.has(record.idempotency_key),
            reason,
        };
    }
    return {
        delivered: !pendingRecords.has(record.idempotency_key),
        idempotencyKey: record.idempotency_key,
        queued: pendingRecords.has(record.idempotency_key),
    };
}
function pendingTelemetryCount() {
    return pendingRecords.size;
}
async function logAppOpen(input = {}) {
    const payload = {};
    if (input.sessionRef)
        payload.session_ref = normalizeShortCode(input.sessionRef, "sessionRef");
    if (input.source)
        payload.source = normalizeShortCode(input.source, "source");
    return enqueueAndFlush(makeRecord("app_open", payload, input));
}
async function logUserAction(input) {
    assertFiniteNonNegative(input.latencyMs, "latencyMs");
    const payload = { action: normalizeShortCode(input.action, "action") };
    if (input.success !== undefined)
        payload.success = input.success;
    if (input.latencyMs !== undefined)
        payload.latency_ms = Math.round(input.latencyMs);
    return enqueueAndFlush(makeRecord("user_action", payload, input));
}
async function logAiCall(input) {
    assertFiniteNonNegative(input.latencyMs, "latencyMs");
    assertFiniteNonNegative(input.inputTokens, "inputTokens");
    assertFiniteNonNegative(input.outputTokens, "outputTokens");
    const payload = {
        provider: normalizeShortCode(input.provider, "provider"),
        model: normalizeShortCode(input.model, "model"),
        success: input.success,
    };
    if (input.latencyMs !== undefined)
        payload.latency_ms = Math.round(input.latencyMs);
    if (input.inputTokens !== undefined)
        payload.input_tokens = Math.round(input.inputTokens);
    if (input.outputTokens !== undefined)
        payload.output_tokens = Math.round(input.outputTokens);
    if (input.errorCode)
        payload.error_code = normalizeShortCode(input.errorCode, "errorCode");
    return enqueueAndFlush(makeRecord("ai_call", payload, input));
}
