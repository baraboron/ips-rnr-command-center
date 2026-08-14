# Isolated runtime smoke contract

Use the protected runtime smoke only after mapping the real application boundaries. It checks
that a selected operation both succeeds and emits exactly the telemetry declared for it. It is
not permission to classify every click as `user_action`.

## Current supported runtime

The workstation POC supports a directly runnable Node JavaScript entry that creates a server
with `node:http` (frameworks that eventually call `http.createServer` may also work). Declare it
as `"runtime":"node-http"`. Do not rewrite an otherwise valid unsupported production
architecture merely to satisfy this POC; report that runtime support must be added instead.

## App-owned manifest

Create `.student-telemetry-smoke.json` in the app root. It is app code, not a protected policy
file, so update it whenever routes, request fields, event boundaries, or provider response
formats change.

```json
{
  "schema_version": 1,
  "runtime": "node-http",
  "entry": "server.mjs",
  "required_env": ["OPENAI_API_KEY"],
  "probes": [
    {
      "name": "application_bootstrap",
      "method": "GET",
      "path": "/api/bootstrap",
      "expected_status": [200],
      "expected_events": [
        {
          "event_type": "app_open",
          "count": 1,
          "payload": { "source": "app_bootstrap" }
        }
      ]
    },
    {
      "name": "submit_request",
      "method": "POST",
      "path": "/api/requests",
      "body": { "title": "synthetic runtime check" },
      "expected_status": [200, 201],
      "expected_events": [
        {
          "event_type": "user_action",
          "count": 1,
          "payload": { "action": "submit_request", "success": true }
        }
      ]
    }
  ],
  "external_mocks": []
}
```

- Cover `app_open` and every meaningful operation selected as `user_action` in the event map.
  A feature deliberately excluded from the event map does not need a probe expectation.
- For an AI app, cover a successful provider path and expect `ai_call`. Put the exact synthetic
  provider response envelope in `external_mocks`; a generic mock shape is not sufficient.
- `required_env` contains variable names only. The runner supplies placeholder values. Never
  put a real key or token in the manifest.
- Request bodies must contain synthetic values only. Do not copy a user's form, prompt, file,
  document, email, identifier, or production record.
- Expected telemetry payload matching is restricted to short operational fields such as
  `action`, `provider`, `model`, `source`, `success`, `status`, and `error_code`.
- Each external mock matches one exact HTTP method and absolute URL. Undeclared `fetch`, direct
  HTTP, and socket requests are blocked rather than sent.

An AI mock has this shape:

```json
{
  "name": "provider_success",
  "method": "POST",
  "url": "https://api.example.invalid/v1/classify",
  "status": 200,
  "headers": { "content-type": "application/json" },
  "json": { "urgency": "normal", "department": "ops", "reason": "synthetic" }
}
```

The `json` value must match what the app actually validates. For an OpenAI-compatible endpoint,
that commonly means the provider envelope plus a JSON string in the assistant content when the
application parses structured output.

## Isolation and repair loop

Run:

```bash
node .codex/hooks/verify-workspace.mjs
```

The protected verifier copies the app to a temporary directory, replaces the telemetry endpoint
and credentials with placeholders, mocks only declared provider requests, and invokes the HTTP
handler without opening a listening socket. It deletes the copy afterward. Thus smoke events do
not enter the production collector and provider calls do not consume a real API key.

The Stop Hook blocks completion on an unexpected HTTP status, missing or duplicate event,
payload mismatch, undeclared network request, invalid manifest, or missing runtime entry. Treat
the returned reason as repair feedback: correct the real app defect or an inaccurate manifest,
then rerun. Do not weaken an expectation just to make a broken operation pass.

This smoke proves only the declared success paths in the isolated Node process. It does not prove
browser behavior, deployment configuration, database compatibility, or production delivery;
confirm those once in staging before training.
