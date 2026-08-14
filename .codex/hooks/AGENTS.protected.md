<!-- BEGIN:student-telemetry-protected-policy -->
# 수강생 앱 작업공간 규칙

이 작업공간에서 앱을 만들거나 기능을 수정할 때 `$instrument-student-telemetry`
Skill을 반드시 사용한다. 특히 API route, Server Action, 서버 handler, worker,
AI/provider 호출을 추가·수정하는 작업은 기능 구현과 같은 변경에서 계측한다.

## 보호 파일

- `AGENTS.md`, `.env*`, `STUDENT_APP_TELEMETRY_TEMPLATE.md`, `.codex/**`는 관리자가
  제공하는 정책·비밀값·검증 도구다. 수정, 삭제, 이동하거나 우회하지 않는다.
- 이 보호를 강제하는 자동 장치는 없다. 지키는 주체가 너다. 특히 `.env`를 지우면
  이 앱의 사용 기록이 그때부터 전송되지 않고 오류도 뜨지 않는다. 되돌릴 수 없다.
- 팀 토큰 재발급은 수강생 작업이 아니다. 관리자만 작업공간 루트에서
  `node .codex/hooks/rotate-team-token.mjs`를 실행해 보호 해시와 관리되는 앱
  `.env`를 함께 갱신한다. Luna/Codex는 임의로 이 명령을 실행하지 않는다.
- 앱 키와 이름을 처음 정할 때만 작업공간 루트에서 다음 보호 스크립트를 사용한다.
  기존 값이 있으면 그대로 유지한다.

  ```bash
  node .codex/hooks/set-app-identity.mjs \
    --app-root /path/to/student-app \
    --app-key <llm-generated-stable-slug> \
    --app-name <llm-generated-display-name>
  ```

## 계측 절차

1. 앱 목적과 소스를 읽고 실제 서버 경계를 확인한다. Next.js라면 코드 작성 전에
   해당 앱의 `node_modules/next/dist/docs/`에서 관련 가이드를 읽는다.
2. 다음 inspector를 실행하고 결과를 실제 소스와 대조한다.

   ```bash
   node .codex/skills/instrument-student-telemetry/scripts/inspect-app.mjs /path/to/student-app
   ```

3. TypeScript/JavaScript 서버에는 Skill installer로 서버 전용
   `telemetry.server.*`를 설치한다. Next.js는 `telemetry.server.ts`를 사용하고
   Client Component에서 import하지 않는다.
4. 실제 서버 경계에 이벤트를 연결한다.
   - bootstrap/session 생성: `await logAppOpen(...)`
   - 검증·승인된 주요 기능: `await logUserAction(...)`
   - 실제 AI/provider 시도: `finally`에서 `await logAiCall(...)`
5. payload에는 안정적인 action/provider/model/status/latency/count만 넣는다.
   프롬프트, 질문, 응답, 폼 값, 파일명, 문서 내용, 이메일, 실명, 원문 오류,
   인증 정보는 절대 넣지 않는다.
6. 텔레메트리는 best-effort로 처리하되 서버 응답 전에 `await`한다. `void` 또는
   detached task를 사용하지 않는다.
7. AI가 없는 앱은 AI SDK/provider/model endpoint가 없음을 확인한 뒤 앱 루트에
   정확히 `{"schema_version":1,"ai_call":"not_applicable","reason":"no_runtime_ai"}`를
   `.student-telemetry.json`으로 추가한다. 가짜 AI 이벤트를 만들지 않는다.
8. 앱 루트의 `.student-telemetry-smoke.json`을 실제 서버 entry, route, 요청 필드와
   일치시킨다. event map에서 계측 대상으로 선택한 bootstrap과 주요 작업은 각각
   정상 HTTP 상태와 정확한 이벤트를 검증해야 한다. AI 앱은 정상 provider 응답을
   합성 mock으로 정의하고 성공 `ai_call` 경로까지 검증한다. 실제 토큰, 사용자 입력,
   운영 데이터는 smoke 명세에 넣지 않는다.
9. CSV 내보내기처럼 event map에서 주요 작업으로 선택하지 않은 기능은 억지로
   `user_action`에 포함하지 않는다. 반대로 선택한 작업은 해당 smoke probe에서
   실제 성공과 이벤트를 함께 검사한다.

## 완료 조건

작업이 끝났다고 보고하기 전에, 작업공간 루트에서 다음 검증기를 **직접 실행한다.**

```bash
node .codex/hooks/verify-workspace.mjs
```

모든 줄이 PASS이고 종료 코드가 0일 때만 완료로 보고한다. FAIL이 하나라도 있으면
완료가 아니다. 이 실행을 대신해 주는 자동 장치는 없다. 네가 부르지 않으면 아무도
검사하지 않는다.

검증기는 정적 계측 검사 후 앱을 임시 디렉터리에 복사해 smoke probe를 실행한다.
운영 수집 API와 실제 AI provider는 호출하지 않으며, 선언되지 않은 외부 요청은
차단한다. 500/502, 요청 형식 불일치, 선택한 이벤트 누락, 중복 이벤트는 FAIL로
출력되므로 앱과 smoke 명세를 고친 뒤 다시 검증한다.
이 검사는 운영 로그를 오염시키지 않는다. 실제 배포 전에는 별도 staging E2E로
최종 전달도 확인하되 토큰이나 payload 원문은 출력하지 않는다. 자동화된 로컬 합성
테스트를 고정 `.env`로 직접 기동해 운영 수집 API에 보내지 않는다.
<!-- END:student-telemetry-protected-policy -->
