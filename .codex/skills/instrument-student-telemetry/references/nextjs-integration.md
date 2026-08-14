# Next.js integration patterns

These patterns target the App Router. Read the target repository's installed Next.js documentation before applying them because its version may differ.

## Server boundary

Install the bundled client into a server directory; do not copy it manually:

```bash
node /path/to/instrument-student-telemetry/scripts/install-client.mjs \
  --runtime nextjs \
  --target /path/to/student-app/src/lib/server/telemetry.server.ts
```

The installer refuses an existing target unless `--force` is explicitly authorized and never follows symlinks. The installed Next.js client imports `server-only`, so Next.js reports a build error if a Client Component imports it.

The bundled client also imports `node:crypto`, so it cannot run in Next.js Edge Runtime. Inspect the target route for `export const runtime = "edge"`. Use an existing Node-runtime route or move the complete business operation and telemetry to an authorized Node Route Handler with `export const runtime = "nodejs"`; do not log remotely from Edge and do not silently change the app's production runtime. If no such change is authorized, report telemetry as blocked for that call site.

Do not call the collection API directly from a Client Component. A Client Component may invoke its own Route Handler or Server Action; that server entry point calls the telemetry module.

If the project is currently a fully static export or contains only Client Components, determine from its real deployment configuration whether production supports a Route Handler or serverless function. Create a minimal same-origin boundary only when that deployment change is in scope. Local `next dev` capability alone is not deployment proof. If the target or permission is unknown, stop and report the missing decision; never place `TEAM_TELEMETRY_TOKEN` in the client bundle.

## Initial app open

Add the log to the existing server bootstrap operation. If the app already creates a pseudonymous session through a Server Action, extend it like this:

```ts
'use server'

import { logAppOpen } from '@/lib/server/telemetry.server'

export async function initializeSession(sessionRef: string) {
  // Validate the untrusted action argument before using it.
  if (!/^[a-zA-Z0-9._:-]{1,100}$/.test(sessionRef)) {
    throw new Error('Invalid session reference')
  }

  await logAppOpen({ sessionRef, source: 'app_bootstrap' })
  return { ready: true }
}
```

Do not emit `app_open` directly from a Server Component render; rendering and revalidation can execute more than once. Attach it to the operation that actually establishes the application session.

## User action and optional AI call

The action below is a generic report-generation feature. Keep form fields, filters, uploaded data, and generated output in the business call only. Log stable codes and operational metadata in the action's server implementation:

```ts
'use server'

import { logAiCall, logUserAction } from '@/lib/server/telemetry.server'

export async function generateReport(request: ReportRequest) {
  // Authenticate/authorize and validate the request here. Server Actions are
  // externally reachable POST entry points, not a trusted UI-only function.
  await logUserAction({ action: 'generate_report' })

  const startedAt = performance.now()
  let succeeded = false
  let errorCode: string | undefined
  let inputTokens: number | undefined
  let outputTokens: number | undefined

  try {
    const result = await callConfiguredModel(request)
    succeeded = true
    inputTokens = result.usage?.inputTokens
    outputTokens = result.usage?.outputTokens
    return result.report
  } catch (error) {
    errorCode = classifyModelError(error) // Stable code only; never error.message.
    throw error
  } finally {
    await logAiCall({
      provider: 'configured_provider',
      model: 'configured_model',
      success: succeeded,
      latencyMs: performance.now() - startedAt,
      inputTokens,
      outputTokens,
      errorCode,
    })
  }
}
```

The example names `callConfiguredModel` and `classifyModelError` as integration points; bind them to the app's existing model client. Never copy request fields, result content, exception messages, model messages, prompts, or tool data into telemetry.

If `generateReport` uses only deterministic application code and the repository has no runtime AI evidence, omit the timer and `logAiCall` block, keep the real `user_action`, and add the exact app-root `.student-telemetry.json` declaration from the telemetry contract. Never fabricate `ai_call` to make all categories nonzero.

## Route Handler alternative

For an existing `app/**/route.ts`, import the same server module and `await` the log inside the exported HTTP method. Route Handlers use the standard `Request` and `Response` APIs and are not cached for `POST`. Validate the request and apply the app's authentication rules before the business operation.

For a client-rendered app that needs a bootstrap route, the route should create or validate a pseudonymous session, deduplicate repeated bootstrap requests, and then call `logAppOpen`. For client actions, expose a business-shaped route or a strict allow-list of stable action codes. Do not create a generic public telemetry relay that accepts arbitrary records.
