# Codex 공동개발자 온보딩 프롬프트

아래 내용을 Codex에 그대로 전달하세요.

```text
이 프로젝트의 공동 개발자로 참여합니다.

GitHub 저장소:
https://github.com/baraboron/ips-rnr-command-center.git

먼저 다음을 수행해 주세요.

1. Codex의 GitHub 연동 상태를 확인합니다.
2. 저장소를 현재 작업공간에 연결하거나 clone합니다.
3. 프로젝트 루트의 `COLLABORATION_GUIDE.md`를 먼저 읽습니다.
4. 현재 브랜치와 작업 트리 상태를 확인합니다.
5. `main` 브랜치의 최신 내용을 pull합니다.

공동개발 규칙:

- `main`에 직접 commit하거나 push하지 않습니다.
- 작업 전 항상 `git switch main` 후 `git pull --rebase origin main`을 실행합니다.
- 작업별로 `feature/작업내용`, `fix/작업내용`, `docs/작업내용` 형식의 새 브랜치를 만듭니다.
- 작업이 끝나면 변경사항을 확인하고 의미 있는 단위로 commit합니다.
- 작업 브랜치를 GitHub에 push한 뒤 Pull Request로 `main`에 병합합니다.
- 다른 개발자의 변경사항은 작업 중에도 `git fetch origin`과 `git rebase origin/main`으로 반영합니다.
- 충돌이 발생하면 임의로 덮어쓰지 말고 충돌 내용을 설명한 뒤 해결합니다.
- `.env.local`, API 키, 비밀번호, 개인 토큰은 절대 commit하지 않습니다.
- Supabase 관련 변경은 `supabase.sql`에 재현 가능한 SQL로 기록합니다.

작업을 시작하기 전에 다음 결과를 보고해 주세요.

- 현재 작업공간 경로
- 현재 브랜치
- 원격 저장소 연결 상태
- 최신 `main` 반영 여부
- 변경되지 않은 파일 목록

이후 제가 작업 내용을 전달하면, 작업 범위를 먼저 요약하고 필요한 파일을 확인한 뒤 구현합니다. 구현 후에는 변경 파일, 테스트 결과, commit 및 PR 진행 상태를 간단히 보고해 주세요.
```

## Codex 연결이 안 될 때

Codex에서 GitHub 로그인을 완료한 뒤 위 프롬프트를 다시 전달합니다. 저장소 접근 권한이 없으면 GitHub 저장소 관리자가 해당 개발자의 GitHub 계정을 `Settings → Collaborators`에서 초대해야 합니다.
