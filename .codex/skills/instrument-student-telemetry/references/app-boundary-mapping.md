# App boundary discovery and event mapping

Telemetry follows real application behavior. Do not start by searching for chatbot files or by inserting three arbitrary calls. First trace the target app from an external interaction to the trusted code that accepts or performs it.

Begin with the bundled read-only inspector, then confirm its path-level hints by reading the target code:

```bash
node /path/to/instrument-student-telemetry/scripts/inspect-app.mjs /path/to/student-app
```

Detection is a routing aid, not proof that an operation is safe or that AI is absent.

## 1. Classify the runtime

| App shape | Trustworthy boundary to inspect | Typical examples |
| --- | --- | --- |
| Server-rendered web app | session/bootstrap route, Server Action, API route | portal, dashboard, form app |
| Browser SPA plus API | the app's own API or serverless function | calculator, planner, CRUD tool |
| API-only app | authenticated HTTP/RPC handler | integration service, data API |
| Worker or automation | job dispatcher and provider adapters | scheduled report, document pipeline |
| Native/desktop client plus backend | backend session and command endpoints | field tool, internal utility |
| Static/client-only app | none until a trusted function/backend exists | static site, browser-only prototype |

Repository structure is not proof of runtime trust. Confirm where code executes and where secrets are stored.

### Framework routing

| Framework/runtime | Trusted integration point | Client support status |
| --- | --- | --- |
| Next.js | Route Handler, Server Action, or other documented server-only module | Use the bundled installer with `--runtime nextjs`, then follow `nextjs-integration.md` |
| Express, Fastify, Hono | validated route/middleware handler and server-side provider adapter | Use the bundled installer with `--runtime node` |
| FastAPI, Flask | validated Python route/dependency and server-side provider adapter | No complete bundled Python client yet; implement and test an in-app server adapter from `telemetry-contract.md` |
| Go `net/http` or router | validated HTTP handler/middleware and server-side provider adapter | No complete bundled Go client yet; implement and test an in-app server adapter from `telemetry-contract.md` |

The TypeScript/JavaScript installer command is:

```bash
node /path/to/instrument-student-telemetry/scripts/install-client.mjs \
  --runtime node \
  --target /absolute/path/to/app/src/lib/server/telemetry.server.ts
```

It refuses an existing target unless `--force` is explicitly authorized and never follows a target or parent-directory symlink. Next.js uses `.server.ts`; Node uses `.server.ts`, ESM `.server.mjs`, or CommonJS `.server.cjs` according to the existing app. The bundled client is Node-only, so a Next.js Edge Runtime call site needs an existing or authorized Node boundary instead. Do not claim Python or Go have a drop-in bundled asset; name their adapters `telemetry.py` or `telemetry.go`, implement the same HTTPS, bearer-secret, payload, idempotency, bounded retry, and best-effort behavior, and add language-native tests.

## 2. Build the event map

Create a short map like this before editing:

| Category | Applicable | Real operation | Trusted call site | Stable metadata |
| --- | --- | --- | --- | --- |
| `app_open` | yes | anonymous app session created | `POST /api/session` | `source: app_bootstrap` |
| `user_action` | yes | validated calculation requested | `POST /api/calculate` | `action: run_calculation` |
| `ai_call` | no, declared | app has no runtime AI/model/provider request | `.student-telemetry.json` | `reason: no_runtime_ai` |

The map is evidence for placement, not a new analytics specification. Prefer a few stable codes tied to the app's primary workflows over logging every click. Put calls in the actual handler/action/worker entry; a helper named `.server.*` without a deployed entry does not establish a trustworthy boundary. `ai_call` remains required unless the exact declaration below is present and the repository has no AI evidence:

```json
{"schema_version":1,"ai_call":"not_applicable","reason":"no_runtime_ai"}
```

Place it at the target app root as `.student-telemetry.json`. Do not invent another reason or schema. The verifier must reject this declaration if AI SDK imports, known model endpoints, provider clients, or model-call code exist.

## 3. Map `app_open`

Emit one event per pseudonymous application session, not once per component render, page revalidation, health check, or static asset request.

Good boundaries include:

- creating or restoring an anonymous server session during bootstrap;
- an authenticated application's first accepted bootstrap request;
- a native app backend accepting a new pseudonymous launch/session identifier.

If the UI is client-rendered, it may call a same-origin bootstrap endpoint once. The server validates or creates a pseudonymous session and emits `app_open`. Use a cookie, session record, or idempotency mechanism to avoid render/retry duplicates. Do not send a real name, email, device advertising ID, access token, or raw browser session token as `sessionRef` or `userRef`.

## 4. Map `user_action`

Log a meaningful operation only after the trusted boundary has authenticated/authorized as needed, parsed the request, and accepted it for processing. Use a stable code that describes the operation, never the submitted values.

Examples across app types:

| App type | Good stable action | Content that must stay out |
| --- | --- | --- |
| Form/workflow | `submit_form`, `approve_request`, `change_status` | field values, comments |
| Data/reporting | `run_report`, `export_summary`, `apply_filter` | query text, report contents |
| Calculator/planner | `run_calculation`, `save_plan` | numeric/user-entered inputs when identifying or sensitive |
| File/document | `upload_document`, `start_conversion` | filename, file bytes, extracted text |
| Automation | `start_job`, `retry_job`, `cancel_job` | job payload, external credentials |
| AI feature | `generate_summary`, `classify_item` | prompt, messages, source document |

Do not log incidental UI mechanics such as hover, focus, every keystroke, render, polling, or health checks. Do not place the event before validation merely because a button was clicked.

## 5. Map `ai_call`

This category is required by default. Search provider SDK calls, known model HTTP endpoints, model gateways, provider adapters, background jobs, and retry/fallback paths rather than assuming the main user route is the only call site. It becomes not applicable only through the exact `no_runtime_ai` project declaration and only when that search finds no runtime AI evidence.

For every real provider attempt:

- measure around the provider request at the trusted server boundary;
- record in `finally`, including timeout, rate limit, provider error, and cancellation outcomes;
- include provider/model stable codes, success, latency, token counts when the provider returns them, and a classified error code;
- do not include prompt, messages, tool arguments/results, retrieved text, response, answer, raw exception message, or stack trace.

One logical provider attempt is one `ai_call`. If the app retries the provider, falls back to another model, or calls multiple models, log each actual attempt. Do not emit `ai_call` for deterministic code, ordinary database/search calls, or a feature merely described as “smart.” Never add a dummy model call to satisfy a count. An app with no such attempt commits the exact `.student-telemetry.json` declaration instead.

## 6. Client-only decision

```text
Does a trusted server/runtime secret store exist?
├─ Yes: keep the token there and instrument its accepted operations.
└─ No: is the deployment platform known and is adding its server function/backend authorized?
   ├─ Yes: create the smallest validated boundary, then instrument it.
   └─ No or unknown: block telemetry integration and report the missing decision.
```

Do not infer production server support merely because the repository uses npm, Vite's development server, or a machine with Node installed. Inspect deployment configuration and use the hosting platform's supported function convention; do not replace a static hosting architecture with a custom long-running server unless that change is explicitly in scope.

A client proxy must expose business-shaped endpoints or an allow-list of stable actions. It must not accept a caller-supplied team token, arbitrary `event_type`, arbitrary payload, provider/model success claim, or destination URL. A browser cannot authoritatively assert an `ai_call`; the server that performs or directly observes the provider request must log it.

## 7. Completion evidence

Before reporting completion:

1. Show the event map and call sites without payload content or secret values.
2. Run static verification.
3. Trigger one real bootstrap and one representative meaningful action.
4. If AI is applicable, exercise an actual provider request or controlled provider failure and verify one `ai_call` per attempt.
5. If AI is not applicable, verify the exact `.student-telemetry.json` declaration is accepted, explicitly report `ai_call: not applicable — no runtime AI`, and verify that no fake event was emitted.
6. Confirm received counts through the API/database-backed dashboard when access exists.
