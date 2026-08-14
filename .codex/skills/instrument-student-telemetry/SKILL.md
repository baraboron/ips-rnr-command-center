---
name: instrument-student-telemetry
description: Discover the trustworthy runtime boundaries in any student-built app, map its real behavior to app_open, user_action, and when applicable ai_call, then instrument and verify safe delivery to the Wonik team telemetry API. Use for web, API, workflow, dashboard, form, data, automation, or AI apps; keep the team token server-only, never invent events, and avoid content or personal data.
---

# Instrument Student Telemetry

Read [references/telemetry-contract.md](references/telemetry-contract.md) before editing the target app.
Then use [references/app-boundary-mapping.md](references/app-boundary-mapping.md) to inventory the app and choose event boundaries. Do not assume the app is a chatbot or that it calls an AI model.
Read [references/runtime-smoke.md](references/runtime-smoke.md) before declaring the implementation complete.

## Discover before editing

1. Read the target repository's instructions and installed framework documentation.
2. Run the bundled read-only inspector, then verify its hints against the source rather than treating detection as proof:

   ```bash
   node .codex/skills/instrument-student-telemetry/scripts/inspect-app.mjs /path/to/student-app
   ```

   Use `--json` only when machine-readable output is useful. The inspector reports paths and classifications, never source contents or secret values.
3. Identify the runtime architecture: server-rendered web app, browser SPA with an API, API-only service, worker/automation, native client with a backend, or truly client-only/static app.
4. Trace the real entry points for:
   - application session/bootstrap;
   - accepted, meaningful user operations;
   - every actual external AI/model request, if any.
5. Write an event map before changing code. For each event, record the real business operation, the trustworthy server call site, a stable code, and whether the category is applicable.
6. Treat `ai_call` as required by default. Only after confirming that the runtime has no AI SDK, model endpoint, provider adapter, or model request may you declare it not applicable by adding this exact project-root `.student-telemetry.json` file:

   ```json
   {"schema_version":1,"ai_call":"not_applicable","reason":"no_runtime_ai"}
   ```

   Do not generate a fake call. The verifier rejects the declaration when it finds AI-call evidence. If a category is applicable but has no trustworthy boundary, fix or create the boundary before instrumentation.

For Next.js, read its installed guides and then follow [references/nextjs-integration.md](references/nextjs-integration.md).

## Establish the server boundary

- Keep the team credential and collection request in a trusted server, serverless function, worker secret store, or app backend.
- For a browser/client-only UI on a deployment platform proven to support server functions, add a minimal same-origin server endpoint using that platform's existing convention. A Node package manager or local development server alone is not proof that production has a trusted server runtime. The browser may send an allow-listed action code or bootstrap signal to the endpoint; it must never receive the team token or send arbitrary telemetry records to the collector.
- If the deployment truly has no trusted server runtime or secret store, stop and report the instrumentation as blocked. Never work around this by embedding the token or calling the collection API from browser, desktop, or mobile client code.
- If the deployment target or permission to introduce a backend is unknown, do not silently replace the app's hosting architecture. Report the exact missing decision and request it before editing.
- If AI is currently called from a public client, move the provider call and its provider credential behind the trusted boundary before adding `ai_call`. If that architecture change is not authorized, report it as blocked.

## Implement

1. Initialize the app identity exactly once from the workspace root. Choose a stable slug and display name from the app's purpose, then run:

   ```bash
   node .codex/hooks/set-app-identity.mjs \
     --app-root /path/to/student-app \
     --app-key <stable-slug> \
     --app-name <display-name>
   ```

   The protected script copies the fixed API URL/token into the app's ignored `.env`, fills the app identity, and refuses later identity changes. Never edit `.env` directly or print its secret values.
2. For a compatible TypeScript/JavaScript server runtime, install the bundled client with the installer instead of manually copying it:

   ```bash
   node .codex/skills/instrument-student-telemetry/scripts/install-client.mjs \
     --runtime nextjs \
     --target /path/to/student-app/src/lib/server/telemetry.server.ts
   ```

   The installer refuses an existing target unless replacement is explicitly requested with `--force`; it never follows a target or parent-directory symlink. Review existing code before authorizing replacement. Next.js uses `--runtime nextjs` with `.server.ts`. Express, Fastify, Hono, and other Node servers use `--runtime node`: choose `.server.ts` for TypeScript, `.server.mjs` for ESM JavaScript, or `.server.cjs` for CommonJS. For Python or Go, no complete bundled client is currently provided: implement and test a server adapter named `telemetry.py` or `telemetry.go` inside the app using the transport, validation, idempotency, retry, and secret rules from the contract.
3. Read all configuration from these server environment variables:
   - `TEAM_TELEMETRY_API_URL`
   - `TEAM_TELEMETRY_TOKEN`
   - `TEAM_TELEMETRY_APP_KEY`
   - `TEAM_TELEMETRY_APP_NAME`
4. Add every applicable event at the mapped trustworthy boundary:
   - Call `logAppOpen` once when the server establishes an application session or accepts the initial application bootstrap.
   - Call `logUserAction` after a meaningful operation is authenticated as needed, validated, and accepted. Use a stable action code such as `create_report`, `submit_form`, `run_calculation`, or `change_workflow_status`, never user-entered text.
   - If the app makes AI/model requests, call `logAiCall` in a `finally` path around every request, including failed requests. If it makes none, leave this event absent and commit the exact `.student-telemetry.json` declaration above.
   Put each call in the actual Server Action, Route Handler, API/framework handler, worker entry,
   or equivalent accepted-operation boundary. A `.server.*` filename is appropriate for the
   installed transport client but is not proof that an event call is reachable. A call in a
   `use client` module never satisfies the requirement.
5. Pass operational metadata only. Never pass form values, search terms, filenames, document content, prompts, questions, responses, answers, message bodies, email, real name, exception messages, or authorization values.
6. Keep telemetry best-effort. Do not fail the user's primary operation when delivery is temporarily unavailable. Preserve the generated idempotency key when retrying.
   Await the telemetry call or an awaiting wrapper before the trusted server operation returns. Do not use `void`, an unobserved promise, or a detached task for delivery; serverless runtimes may terminate it immediately. Catch only the telemetry failure when the adapter can throw.
7. Create or update the app-root `.student-telemetry-smoke.json` from the event map. Cover the real bootstrap and every operation selected as a meaningful `user_action`. For AI apps, declare an exact synthetic provider success response and verify the successful `ai_call`; for non-AI apps, do not invent one. Follow the isolated runtime contract linked above. Never put real credentials or user content in the manifest.
8. Run the protected workspace verifier yourself and fix every applicable failure. No hook runs it for you; if you skip this step nothing is checked:

```bash
node .codex/hooks/verify-workspace.mjs
```

Report the work as complete only when every line reads PASS and the exit code is 0. The verifier combines static checks with protected isolated runtime probes. It must observe the declared successful HTTP response and exact event counts without contacting the production collector or a real provider. Treat every FAIL line as repair feedback and rerun after fixing either the real defect or an inaccurate manifest. A failed provider request remains a real `ai_call` and must be recorded with `success: false`; an app with the accepted `no_runtime_ai` declaration must not emit one. Before training, separately confirm deployment and final delivery once in staging.

The bundled Node client imports `node:crypto`. It is not compatible with Next.js Edge Runtime. If an inspected call site declares `runtime = "edge"`, use an existing Node-runtime boundary or move the whole business operation to an authorized Node Route Handler/serverless function; otherwise report the integration as blocked. Do not silently change a deployed runtime.

## Enforce the secret boundary

- For this workstation POC, use only the fixed ignored `.env` provisioned by the protected identity script. In production, move the token to the deployment platform's protected secret settings.
- Never place the token value in this Skill, `AGENTS.md`, source code, a prompt, a committed env file, a screenshot, or test output.
- Never use a public-prefixed variable such as `NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`, `EXPO_PUBLIC_`, or `NUXT_PUBLIC_` for the token.
- Never import the telemetry server module into a browser/client component. Route browser activity through the app's own server boundary.

## Report

Report the discovered app type and event map, each applicable call site, whether the exact `no_runtime_ai` declaration was used, the environment variable names, the isolated probe result, the verifier result, and any remaining staging limitation. Do not print secret values, user content, or raw payload contents.
