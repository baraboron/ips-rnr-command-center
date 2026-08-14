# 학생 앱 텔레메트리 설정 템플릿

이 앱은 서버에서 학생 앱 텔레메트리를 전송한다. 고정 팀 토큰은 작업공간의
`.env`에 두고 서버 코드에서만 읽는다.

## 서버 환경변수

```env
TEAM_TELEMETRY_API_URL=https://wonik90-telemetry-api.azurewebsites.net/api/v1/records
TEAM_TELEMETRY_TOKEN=<fixed-token-in-.env>
TEAM_TELEMETRY_APP_KEY=<llm-generated-stable-slug>
TEAM_TELEMETRY_APP_NAME=<llm-generated-display-name>
```

`TEAM_TELEMETRY_APP_KEY`와 `TEAM_TELEMETRY_APP_NAME`은 앱 목적을 읽은 LLM이
정한다. 앱이 수정될 때도 같은 값을 유지한다.

## Codex 작업 규칙

작업공간의 `AGENTS.md`와 `$instrument-student-telemetry` Skill을 사용한다.

1. `.codex/skills/instrument-student-telemetry/scripts/inspect-app.mjs`로 앱 런타임과
   실제 서버 경계를 먼저 확인한다.
2. Skill installer로 TypeScript/JavaScript 서버 앱에 서버 전용
   `telemetry.server.*` 클라이언트를 설치한다.
3. 실제 서버 경계에 이벤트를 연결한다.
   - 앱 bootstrap/session 생성: `logAppOpen`
   - 검증·승인된 기능 처리: `logUserAction`
   - 실제 AI/provider 요청의 `finally`: `logAiCall`
4. API route, Server Action, worker 등 기능을 추가하거나 수정할 때마다 해당
   기능의 서버 경계에 필요한 텔레메트리 호출을 함께 추가한다. 마지막에
   일괄적으로 가짜 이벤트를 추가하지 않는다.
5. payload에는 안정적인 action/provider/model/status/latency/count만 넣는다.
   프롬프트, 질문, 응답, 폼 값, 파일명, 문서 내용, 이메일, 실명, 원문 에러는
   절대 넣지 않는다.
6. 텔레메트리 실패가 본 기능을 실패시키지 않도록 best-effort로 처리하되,
   서버 핸들러가 반환되기 전에 `await`한다. `void`나 detached task는 사용하지
   않는다.
7. 실제 AI가 없는 경우에만 앱 루트에 다음 파일을 추가한다.

```json
{"schema_version":1,"ai_call":"not_applicable","reason":"no_runtime_ai"}
```

8. 앱 루트의 `.student-telemetry-smoke.json`에 실제 Node 서버 entry와 event map에서
   선택한 bootstrap·주요 작업의 route, 합성 요청, 정상 상태, 예상 이벤트를 적는다.
   AI 앱은 실제 provider 호출 대신 사용할 정확한 합성 응답도 `external_mocks`에
   적는다. 앱이 키 존재 여부를 검사할 때는 값 대신 `required_env`에 변수 이름만
   추가한다.
9. 기능 변경 후 `node .codex/hooks/verify-workspace.mjs`를 실행한다. Stop Hook도
   정적 검사와 같은 격리 실행 검사를 수행해 500/502, 요청 형식 불일치, 선택한 로그
   누락·중복이 남은 상태로 작업이 끝나는 것을 막는다.
10. 격리 검사는 앱의 임시 복사본, 가짜 텔레메트리 응답, 가짜 AI 응답만 사용한다.
    운영 로그나 AI 비용을 발생시키지 않으며 선언되지 않은 외부 통신은 차단한다.
    배포 전에는 별도 staging E2E로 실제 전달을 한 번 더 확인한다. 고정 `.env`로 앱을
    직접 띄워 자동 합성 요청을 운영 수집 API에 보내지 않는다.

## 호출 계약

서버 클라이언트는 다음 엔드포인트를 호출한다.

```text
POST https://wonik90-telemetry-api.azurewebsites.net/api/v1/records
Authorization: Bearer <TEAM_TELEMETRY_TOKEN>
```

이벤트별 idempotency key를 생성하고 제한된 재시도를 사용한다. 토큰은 브라우저
번들, Client Component, 프롬프트, `AGENTS.md`, 템플릿에 복사하지 않는다.
