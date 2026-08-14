# Student telemetry contract

## Transport

- Send `POST {TEAM_TELEMETRY_API_URL}/v1/records`.
- Use HTTPS for every remote API URL. Plain HTTP is allowed only for localhost or a loopback IP.
- Do not put credentials, a query string, or a fragment in the API URL.
- Set `Authorization: Bearer {TEAM_TELEMETRY_TOKEN}` on the server only.
- Set `Content-Type: application/json`.
- Treat the token as opaque. Do not decode it or send organization/team identifiers.
- Reuse the same `idempotency_key` for every retry of one logical event.
- Retry network failures, HTTP 408/425/429, and HTTP 5xx with bounded backoff.

## Request

```json
{
  "app": {
    "key": "team-workflow-tool",
    "name": "Team workflow tool"
  },
  "records": [
    {
      "event_type": "user_action",
      "occurred_at": "2026-07-27T07:01:00.000Z",
      "idempotency_key": "generated-once-per-logical-event",
      "schema_version": 1,
      "payload": {
        "action": "approve_request",
        "success": true
      }
    }
  ]
}
```

The client may batch up to 100 records. The API derives the team, organization, token, and app database ID; never send those identifiers from the student app.

## Event vocabulary and applicability

`app_open` and `user_action` apply to interactive student applications. `ai_call` is required by default. A confirmed AI-free app declares the exception with exactly this target-app-root `.student-telemetry.json`:

```json
{"schema_version":1,"ai_call":"not_applicable","reason":"no_runtime_ai"}
```

The declaration is invalid if runtime AI SDK imports, known provider/model endpoints, provider clients, or model-call code exist. An accepted AI-free app must not fabricate an `ai_call`; zero is the correct count. Once an app adds an AI feature, remove the declaration and instrument every real provider attempt, including failures and fallbacks.

| Event | Allowed examples | Never include |
| --- | --- | --- |
| `app_open` | pseudonymous session reference, source | email, real name, browser token |
| `user_action` | stable action code, success, latency | form values, search terms, filenames, typed text, document content |
| `ai_call` (when applicable) | provider, model, success, latency, input/output token counts, error code | prompt, messages, tool data, source content, response, answer, raw error message |

`user_ref` is optional analytics metadata, not authentication. The bundled client accepts only an opaque value shaped as `anon_` or `usr_` plus 16–96 URL-safe characters. Generate it from a random identifier or a one-way pseudonymization process; never reuse an email, real name, phone number, login token, or other directly identifying value.

The three values are event categories, not a requirement to emit one of each during every app session. Emit events only when the corresponding real operation occurs. The project declaration controls only whether an `ai_call` call site is required; it never authorizes fake events.

## Delivery behavior

The bundled client retries a batch with the same record objects and keeps an in-process bounded queue after temporary failure. A permanently rejected 4xx batch is dropped so it cannot poison the queue and block later events. This is intentional best-effort loss. The memory queue can also disappear whenever a serverless instance stops. Do not claim durable delivery unless the target app adds a real queue or outbox.
