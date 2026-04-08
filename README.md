# 🐌 damn-my-slow-kt

**KT 인터넷 요금 → 0원.** SLA 미달 속도를 자동으로 측정하고 요금 감면을 신청해주는 도구.

---

## 이게 뭔데

KT는 SLA 기준(계약 속도의 50%)을 미달하면 **측정한 날의 요금을 감면**해줘야 한다. 한 번 측정해서 한 달 치가 깎이는 게 아니다. **매일 측정해야 매일 감면된다.** 30일 매일 미달이면 전액 감면.

근데 그걸 누가 매일 직접 KT 홈페이지 들어가서 로그인하고, 25분 기다리고, 이의신청 버튼 누르냐? 아무도 안 한다. **이 도구는 그걸 대신 한다.**

```
📊 측정 결과
   계약 속도:  1,000 Mbps  (기가라이트)
   측정 속도:     64 Mbps  ← 계약의 6.4%
   → SLA 실패 → 이의신청 완료 → 당월 요금 감면
```

---

## 시작하기

```bash
npx -y damn-my-slow-kt@latest init
```

KT 계정 입력하면 끝. 매일 자동으로 최대 10회 (2시간 간격) 측정하고, 미달이면 바로 감면 신청한다. 성공하면 나머지는 자동 스킵.

```
04:00  → 측정 → 속도 정상 → 종료
06:00  → 측정 → SLA 미달 → 감면 신청 성공!
08:00  → "오늘 이미 감면 성공" → 스킵
10:00  → 스킵
 ...
```

---

## 스케줄 해제하기

```bash
npx -y damn-my-slow-kt@latest schedule remove
```

---

## 설정 바꾸기

`~/.damn-my-slow-isp/config-kt.yaml` 파일을 직접 편집:

```yaml
schedule:
  time: "04:00"          # 첫 측정 시작 시간
  max_attempts: 10       # 하루 최대 측정 횟수
  retry_interval_minutes: 120  # 측정 간격 (분)

notification:
  discord_webhook: ""    # Discord 알림 (선택)
  telegram_bot_token: "" # Telegram 알림 (선택)
```

설정 변경 후 스케줄 재등록:
```bash
npx -y damn-my-slow-kt@latest schedule install
```

---

## 업데이트

```bash
npx -y damn-my-slow-kt@latest init
```

새 버전에서 설정이 바뀌면 자동으로 안내해주고, 적용할지 물어본다.

---

## KT SLA 감면 기준

| | 한 번만 측정 | 매일 측정 |
|---|---|---|
| 감면 범위 | **하루분만** | **매일 하루분씩 → 최대 전액** |

- **최저보장속도**: 계약 속도의 50% (1Gbps → 500Mbps 미달 시 대상)
- **판정**: 5회 측정 중 3회 이상 미달 → 이의신청 가능
- **대상**: 유선(LAN) 연결만 (Wi-Fi 제외)
- **측정**: [speed.kt.com](https://speed.kt.com) KT 공식 SLA 서버
- **공식 안내**: [KT 초고속 인터넷 품질보장제도(SLA)](https://ermsweb.kt.com/search/faq/faqAnswerM.do?kbId=KNOW0002301063&nodeId=NODE0000000255&parentNodeId=NODE0000000238)

---

## NAS / Docker에서 실행

Synology NAS 등 시스템 라이브러리가 부족한 환경에서는 Playwright 공식 Docker 이미지를 사용:

```bash
# 1. 먼저 호스트에서 설정 파일 생성
npx -y damn-my-slow-kt@latest init

# 2. Docker로 실행
docker run --rm \
  -v ~/.damn-my-slow-isp:/root/.damn-my-slow-isp \
  mcr.microsoft.com/playwright:v1.52.0-noble \
  npx -y damn-my-slow-kt@latest run
```

cron으로 자동 실행하려면 `/etc/crontab`에 직접 등록:

```bash
# 매일 04:00, 06:00, ..., 22:00 (2시간 간격 10회)
0  4  * * * root  docker run --rm -v /var/services/homes/admin/.damn-my-slow-isp:/root/.damn-my-slow-isp mcr.microsoft.com/playwright:v1.52.0-noble npx -y damn-my-slow-kt@latest run >> /var/services/homes/admin/.damn-my-slow-isp/cron.log 2>&1
0  6  * * * root  docker run --rm -v /var/services/homes/admin/.damn-my-slow-isp:/root/.damn-my-slow-isp mcr.microsoft.com/playwright:v1.52.0-noble npx -y damn-my-slow-kt@latest run >> /var/services/homes/admin/.damn-my-slow-isp/cron.log 2>&1
```

---

## 테스트 완료 환경

| 환경 | OS | 상태 |
|------|-----|------|
| macOS (Apple Silicon) | macOS 15+ | ✅ 네이티브 실행 |
| Linux (x86_64) | Ubuntu 22.04+ | ✅ 네이티브 실행 |
| Synology NAS | DSM 7.x (Docker) | ✅ Playwright 공식 이미지 |
| GitHub Actions | Ubuntu (Node 20/22/24) | ✅ CI 통과 |

---

## 요구사항

- Node.js 20+ (22+ 권장 — native SQLite 지원)
- KT 인터넷 계정
- 유선(LAN) 연결
- NAS/서버: Docker 필요 (Playwright 시스템 라이브러리 의존성)

---

## 개발 (Contributing)

### 기술 스택
| Component | Technology |
|-----------|-----------|
| Language | TypeScript (ES2020, CommonJS, strict) |
| CLI | Commander + Inquirer + Chalk v4 |
| Browser | Playwright (headless Chromium) |
| Storage | node:sqlite (Node 22+) / JSON fallback |
| Config | YAML — `~/.damn-my-slow-isp/config-kt.yaml` |
| Lint | ESLint + typescript-eslint |
| Test | Vitest |
| CI | GitHub Actions (Node 20 + 22 matrix) |

### 개발 환경 설정

```bash
git clone https://github.com/kargnas/damn-my-slow-kt.git
cd damn-my-slow-kt
npm install
npx playwright install chromium
npm run build
```

### 명령어

| Command | Description |
|---------|-------------|
| `npm run build` | TypeScript 컴파일 |
| `npm run typecheck` | 타입 체크 (`tsc --noEmit`) |
| `npm run lint` | ESLint |
| `npm test` | Vitest 단위 테스트 |
| `npm run dev` | ts-node 개발 모드 |

### 기여 방법
1. 새 브랜치에서 작업: `git checkout -b feat/my-feature`
2. 커밋 전 반드시 확인: `npm run typecheck && npm run lint && npm run build && npm test`
3. PR 생성 (main 브랜치 대상)
4. 커밋 메시지: 한국어 conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)

> AI 에이전트로 개발 환경을 구성하려면 [README.ai-ready.md](./README.ai-ready.md) 참고
