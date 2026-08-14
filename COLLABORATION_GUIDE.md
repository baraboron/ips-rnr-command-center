# IPS R&R Command Center 공동개발 안내

저장소: https://github.com/baraboron/ips-rnr-command-center

이 문서는 관련자가 같은 코드를 기준으로 개발하고, 작업 전후에 `pull`을 받아 충돌을 줄이기 위한 공동개발 규칙입니다.

## 1. 최초 참여자 설정

Git과 Node.js를 설치한 뒤 다음 명령을 실행합니다.

```bash
git clone https://github.com/baraboron/ips-rnr-command-center.git
cd ips-rnr-command-center
npm install
```

현재 프로젝트에 `package.json`이 없다면 `npm install`은 생략합니다. 로컬 환경변수는 담당자에게 전달받아 프로젝트 루트에 `.env.local`로 저장합니다. `.env.local`은 GitHub에 올리지 않습니다.

## 1-1. 로컬 로그인 사용법

현재 60일 검증 단계에서는 별도 비밀번호 없이 사용자 선택으로 접속합니다. 첫 화면에서 본인을 선택하면 역할별 메뉴와 업무 범위가 적용됩니다.

- 시스템 관리자: 전체 현황·조직 배분·관리자 메뉴
- 팀장: 담당 조직의 업무 현황·조직 배분 메뉴
- 팀원: 본인 업무 중심 화면

역할 매핑은 `auth.js`의 `ROLE_BY_MEMBER_ID`에서 관리합니다. 이 방식은 검증용이며, 회사 SSO 연동 시 `authProvider.signIn`만 SSO/OIDC 인증으로 교체하는 것을 목표로 합니다.

## 2. 매일 작업 시작할 때

항상 원격 최신 내용을 먼저 받은 후 작업합니다.

```bash
git switch main
git pull --rebase origin main
git switch -c feature/작업내용
```

브랜치 이름 예시: `feature/dashboard-filter`, `fix/employee-search`, `docs/setup-guide`

## 3. 개발 중 원격 변경사항 받기

작업 중 다른 사람이 `main`에 변경사항을 올렸다면 현재 브랜치에서 실행합니다.

```bash
git fetch origin
git rebase origin/main
```

충돌이 발생하면 파일을 수정한 뒤 다음 순서로 계속 진행합니다.

```bash
git add 충돌을_해결한_파일
git rebase --continue
```

중단하려면 다음 명령을 사용합니다.

```bash
git rebase --abort
```

## 4. 작업 저장 및 공유

작업 단위가 완성될 때마다 의미 있는 단위로 커밋하고 push합니다.

```bash
git status
git add 수정한_파일
git commit -m "feat: R&R 검색 필터 추가"
git push -u origin feature/작업내용
```

그 다음 GitHub에서 `feature/작업내용` → `main` Pull Request를 생성합니다. 검토와 테스트가 끝난 뒤 `main`에 병합합니다.

커밋 메시지는 다음 형식을 권장합니다.

```text
feat: 새 기능
fix: 오류 수정
docs: 문서 수정
refactor: 구조 개선
style: 화면 또는 형식 수정
chore: 설정 및 관리 작업
```

## 5. Pull Request 규칙

- `main`에 직접 커밋하거나 직접 push하지 않습니다.
- 하나의 PR에는 하나의 기능 또는 수정 목적만 포함합니다.
- 화면 변경 시 변경 전후 설명이나 캡처를 첨부합니다.
- 테스트하지 못한 항목은 PR 본문에 명시합니다.
- 병합 전 최신 `main`을 반영합니다.

```bash
git fetch origin
git rebase origin/main
git push --force-with-lease
```

`--force` 대신 반드시 `--force-with-lease`를 사용합니다.

## 6. 다음 작업 시작

작업을 끝낸 뒤 push와 PR 생성을 완료합니다. 다음 작업에서는 기존 브랜치를 재사용하지 말고 최신 `main`에서 새 브랜치를 만듭니다.

```bash
git switch main
git pull --rebase origin main
git switch -c feature/다음작업
```

## 7. 환경변수와 데이터베이스 주의사항

- `.env.local`, API 키, 비밀번호, 개인 토큰은 커밋하지 않습니다.
- Supabase 설정 변경은 `supabase.sql`에 재현 가능한 SQL로 기록합니다.
- 운영 데이터에 직접 테스트하지 않습니다.
- 데이터 구조 변경 SQL은 PR에 변경 이유와 영향 범위를 적습니다.

## 7-1. AI 기능 사용

현재 AI 기능은 서버의 `OPENAI_API_KEY`로만 호출합니다. 브라우저 코드나 Git 커밋에 API 키를 넣지 않습니다.

- 부서장·시스템 관리자: `AI 도우미 → 부서 관리 레포트`
- 모든 사용자: `AI 도우미 → 주간·월간 브리핑`
- 업무 등록 화면: 설명 입력 아래 `AI 명세 보완`
- 로컬 서버: `server.mjs` 실행 후 `http://127.0.0.1:4173`

실제 키는 `.env`에 두고 `.env.example`에는 변수명만 기록합니다. AI 결과는 초안이므로 저장·공유 전에 담당자가 사실관계와 개인정보 포함 여부를 확인합니다.

## 8. 문제 해결

```bash
git status
git log --oneline --decorate -5
git branch -vv
git fetch origin
git log --oneline HEAD..origin/main
```

작업을 임시 보관해야 할 때:

```bash
git stash push -m "작업 임시 보관"
git pull --rebase origin main
git stash pop
```

문제가 해결되지 않으면 현재 브랜치명, 실행한 명령, 오류 메시지를 함께 공유합니다.

## 권장 GitHub 저장소 설정

관리자는 GitHub의 `Settings → Branches`에서 `main` 보호 규칙을 설정합니다.

- Pull Request를 통한 병합만 허용
- 최소 1명 승인 요구
- 강제 push 및 브랜치 삭제 제한

이 규칙을 적용하면 모든 변경사항이 검토를 거쳐 `main`에 반영되고, 각 개발자는 작업 시작 시 `git pull --rebase origin main`으로 최신 코드를 받을 수 있습니다.
