# Main branch 운영 정책

이 저장소는 `main` 브랜치 하나만 장기 운영 브랜치로 사용한다.

## 작업 절차

```bash
git switch main
git pull --rebase origin main
# 변경 작업 및 검증
git add <변경 파일>
git commit -m "feat: 변경 내용"
git push origin main
```

별도 feature/fix/docs 브랜치와 Pull Request는 사용하지 않는다. 예외가 필요하면 작업 전에 소유자에게 확인한다.

커밋 전에는 관련 문법 검사와 화면 동작을 확인하고, 커밋은 기능 단위로 구분한다. `.env.local`, 인증정보, 개인 데이터는 커밋하지 않는다.

현재 배포 링크: https://wonikway-ips.vercel.app
