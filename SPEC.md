# damn-my-slow-kt

KT 인터넷 SLA 속도 미달 시 요금 감면을 자동화하는 CLI 도구.

## 개요

KT는 SLA(Service Level Agreement) 기준 속도에 미달하면 요금 감면을 제공한다.
하지만 사용자가 직접 KT 홈페이지에 로그인 → 속도 측정 → 감면 신청을 해야 하는데, 이 과정이 귀찮아서 대부분 하지 않는다.

이 도구는 이 전체 과정을 자동화한다.

## 핵심 기능

1. **KT 홈페이지 자동 로그인** (Playwright 기반 브라우저 자동화)
2. **KT 공식 SLA 속도 측정 실행** (speed.kt.com)
3. **측정 결과 기록** (SQLite / JSON fallback)
4. **속도 미달 시 감면 자동 신청**
5. **결과 리포트** (Discord/Telegram 알림 옵션)
6. **다회 측정** - 하루 최대 N회, 감면 성공 시 자동 스킵
7. **업데이트 마이그레이션** - 버전 업 시 설정 변경 안내

## KT SLA 측정 플로우

1. https://speed.kt.com/sla/slatest/introduce.asp 접속
2. "품질보증(SLA) 테스트" 버튼 클릭
3. KT 계정 로그인 (accounts.kt.com)
4. 비밀번호 변경 안내 → "다음에 하기" 클릭 (필요 시)
5. 회선 선택 → 측정 시작 (#measureBtn)
6. 5회 자동 측정 완료 대기 (약 25분)
7. 결과 파싱 → SLA pass/fail 판단
8. fail 시 "이의신청" 버튼 클릭

## SLA 기준

- 최저보장속도: 계약 속도의 50% (기가라이트 1G → 500Mbps)
- 5회 측정 중 3회 이상 미달 시 SLA 실패 → 감면 신청 가능
- 유선(LAN) 연결만 대상

## 기술 스택

- **언어**: TypeScript (Node.js 20+)
- **브라우저 자동화**: Playwright (headless Chromium)
- **스케줄링**: macOS launchd / Linux systemd timer / crontab
- **설정**: YAML (`~/.damn-my-slow-isp/config-kt.yaml`)
- **데이터 저장**: SQLite (Node 22+ built-in) / JSON fallback
- **알림**: Discord webhook / Telegram bot (선택)
- **배포**: npm registry (`npx damn-my-slow-kt`)
- **CI/CD**: GitHub Actions (auto publish on version bump)

## 다회 측정 구조

`run` 1회 실행 = 1회 측정 후 종료. 스케줄러가 하루에 여러 번 트리거한다.

```
04:00  launchd → run → 측정 → SLA pass → 종료
06:00  launchd → run → 측정 → SLA fail → 감면 성공 → 종료
08:00  launchd → run → DB 체크 → "오늘 감면 성공" → 스킵
```

- `schedule.max_attempts`: 하루 최대 측정 횟수 (기본 10)
- `schedule.retry_interval_minutes`: 트리거 간격 (기본 120분)
- `schedule.stop_on_complaint_success`: 감면 성공 시 나머지 스킵 (기본 true)

### interactive vs non-interactive

| 상황 | interactive (TTY) | non-interactive (cron) |
|---|---|---|
| 오늘 감면 성공 | "그래도 추가 측정하시겠습니까?" | `[skip]` + `--force` 안내 |
| 최대 횟수 도달 | "초과하여 추가 측정하시겠습니까?" | `[skip]` + `--force` 안내 |

## 업데이트 마이그레이션

- 설정 파일에 `_config_version` 필드로 버전 관리
- `run` 또는 `init` 실행 시 현재 버전보다 높은 마이그레이션 감지 → 사용자에게 적용 여부 질문
- non-interactive 환경에서는 안내만 출력, 적용하지 않음

## 설정 파일 (`~/.damn-my-slow-isp/config-kt.yaml`)

```yaml
_config_version: 3

credentials:
  id: "사용자ID"
  password: "비밀번호"

plan:
  name: "기가라이트"
  speed_mbps: 1000

schedule:
  time: "04:00"
  timezone: "Asia/Seoul"
  max_attempts: 10
  retry_interval_minutes: 120
  stop_on_complaint_success: true

notification:
  discord_webhook: ""
  telegram_bot_token: ""
  telegram_chat_id: ""

headless: true
db_path: "~/.damn-my-slow-isp/history-kt.db"
```

## CLI 인터페이스

```bash
damn-my-slow-kt init              # 초기 설정. 기존 설정 있으면 마이그레이션 체크
damn-my-slow-kt run               # 1회 측정 (오늘 완료 시 스킵)
damn-my-slow-kt run --dry-run     # 측정만 (감면 신청 생략)
damn-my-slow-kt run --force       # 오늘 완료 여부 무시하고 강제 실행
damn-my-slow-kt config show       # 현재 설정 보기
damn-my-slow-kt history           # 측정 이력 조회
damn-my-slow-kt history -m 2026-04
damn-my-slow-kt report            # 요약 리포트
damn-my-slow-kt schedule install  # 스케줄 등록
damn-my-slow-kt schedule remove   # 스케줄 제거
```

## 프로젝트 구조

```
damn-my-slow-kt/
├── README.md
├── SPEC.md
├── package.json
├── tsconfig.json
├── bin/
│   └── damn-my-slow-kt      # CLI 엔트리포인트
├── src/
│   ├── index.ts              # 메인 진입점
│   ├── cli.ts                # CLI 커맨드 정의 (commander)
│   ├── config.ts             # YAML 설정 로드/저장
│   ├── db.ts                 # SQLite / JSON 이력 저장
│   ├── kt.ts                 # KT 자동화 (Playwright)
│   ├── migration.ts          # 업데이트 마이그레이션 시스템
│   ├── notify.ts             # Discord/Telegram 알림
│   ├── report.ts             # 리포트 출력
│   ├── scheduler.ts          # launchd/systemd/cron 스케줄 관리
│   └── updater.ts            # npm 최신 버전 체크
└── .github/
    └── workflows/
        └── publish.yml       # 자동 npm publish
```

## 데이터 저장 경로

| 파일 | 경로 |
|------|------|
| 설정 파일 | `~/.damn-my-slow-isp/config-kt.yaml` |
| 측정 이력 DB | `~/.damn-my-slow-isp/history-kt.db` |
| 실행 로그 | `~/.damn-my-slow-isp/run.log` |
| 에러 로그 | `~/.damn-my-slow-isp/run.error.log` |
| 업데이트 캐시 | `~/.damn-my-slow-isp/update-cache.json` |

## 주의사항

- KT 2FA/CAPTCHA 대응 필요할 수 있음
- 비밀번호 평문 저장 → 설정 파일은 홈 디렉토리에 저장되며 git에 포함되지 않음
- 유선(LAN) 연결 환경에서만 SLA 측정 유효
