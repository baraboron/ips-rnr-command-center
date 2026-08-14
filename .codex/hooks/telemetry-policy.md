# Protected student telemetry policy

- For every new or changed API route, Server Action, server handler, worker, or AI provider call, use `$instrument-student-telemetry` in the same task.
- Inspect the real runtime and map `app_open`, `user_action`, and applicable `ai_call` events before editing.
- Put telemetry at the real trusted server boundary. Never call the collector from browser or Client Component code.
- Emit `app_open` when the server accepts bootstrap/session creation, `user_action` after a meaningful validated operation is accepted, and `ai_call` from `finally` around every real provider attempt.
- Send operational codes, status, latency, and counts only. Never send prompts, responses, form values, filenames, documents, names, email, raw errors, credentials, or authorization data.
- Keep telemetry best-effort but `await` it before the server operation returns. Never detach it with `void`.
- Read the fixed API URL and team token from `.env`. Never print or copy their values into source. Generate a stable app key/name once with `.codex/hooks/set-app-identity.mjs`; do not edit `.env` directly.
- Team-token rotation is an administrator-only operation. Never run `.codex/hooks/rotate-team-token.mjs` as part of a student app task or change a token to bypass verification.
- Do not modify `AGENTS.md`, `.env*`, `STUDENT_APP_TELEMETRY_TEMPLATE.md`, or anything under `.codex/`.
- Keep the editable app-root `.student-telemetry-smoke.json` aligned with the real Node entry, routes, accepted request fields, and the operations selected in the event map. Use synthetic inputs and exact synthetic provider responses only; never put a real token or user content in it.
- Before finishing, run `node .codex/hooks/verify-workspace.mjs` from the workspace root and fix every failure. It runs static checks and protected isolated runtime probes. A Stop Hook failure is repair feedback: fix the app or an inaccurate smoke manifest and rerun. The runner blocks undeclared network access and never sends test events to production.
- The isolated smoke is not a deployment guarantee. Confirm final delivery once in a staging environment before training.
- Do not launch automated local synthetic requests against the fixed production collector in `.env`; use the protected isolated verifier for local testing.
