# 🐌 damn-my-slow-kt

**KT 인터넷 요금 49,500원 → 0원.** SLA 미달 속도를 자동으로 측정하고 요금 감면을 신청해주는 CLI 도구.

---

## 실제로 이렇게 나왔다

```
📊 2026-03-24 04:00 측정 결과

   계약 속도:  1,000 Mbps  (기가라이트)
   측정 속도:     64 Mbps  ← 계약의 6.4%
   최저보장:    500 Mbps  (계약의 50%)

   5회 측정 중 5회 미달 → SLA 실패
   ✅ 이의신청 완료 → 당월 요금 감면 처리됨
```

KT는 SLA 기준(계약 속도의 50%)을 3회 이상 미달하면 **측정한 날 하루분** 요금을 감면해줘야 한다. 한 번 측정해서 한 달 치가 깎이는 게 아니다. **매일 측정해야 매일 감면된다.** 30일 매일 미달이면 30일분 전액 감면 = 0원.

근데 그걸 누가 매일 직접 KT 홈페이지 들어가서 로그인하고, 25분 기다리고, 이의신청 버튼 누르냐? 아무도 안 한다. 통신사도 그걸 알고 있다. **이 도구는 그 존나 귀찮은 걸 대신 한다.**

---

## Quick Start

```bash
npx damn-my-slow-kt init
```

설정하면 끝. 매일 **최대 10회** (2시간 간격) 알아서 측정하고, 미달이면 바로 신청한다. 감면 성공하면 나머지는 자동 스킵.

---

## 어떻게 동작하는가

```
📡 Bot: speed.kt.com 접속 중... KT 계정 로그인
   (Playwright headless Chromium으로 브라우저 자동화)

⏱  Bot: 측정 시작 - 5회 완료까지 약 25분 소요
   (KT 공식 SLA 측정 서버 사용, 결과 조작 불가)

📊 Bot: 측정 완료
   1회: 61 Mbps  ❌
   2회: 58 Mbps  ❌
   3회: 67 Mbps  ❌
   4회: 71 Mbps  ❌
   5회: 64 Mbps  ❌
   → 5/5 미달 (기준: 500 Mbps)

✅ Bot: 이의신청 버튼 클릭 완료
   Discord 알림 발송 → 결과 DB 저장
```

### 다회 측정 구조

`run` 한 번 = 1회 측정 후 종료. 스케줄러(launchd/cron/systemd)가 하루에 여러 번 트리거한다.

```
04:00  cron → run → 측정 → SLA pass (속도 정상) → 종료
06:00  cron → run → 측정 → SLA fail → 감면 신청 성공 → 종료
08:00  cron → run → "오늘 감면 성공 완료" → 스킵
10:00  cron → run → 스킵
  ...
```

- 감면 성공하면 이후 트리거는 자동 스킵
- 수동 실행 시 (interactive) 재시도 여부를 물어봄
- `--force`로 강제 실행 가능

---

## 설치 및 설정

### npx (설치 불필요)

```bash
npx damn-my-slow-kt init
```

### 글로벌 설치

```bash
npm install -g damn-my-slow-kt
damn-my-slow-kt init
```

`init` 실행 시 인터랙티브 모드로 설정:
- KT 계정 (아이디/비밀번호)
- 계약 속도 (Mbps)
- Discord/Telegram 알림 (선택)
- **자동 스케줄 등록** - macOS launchd / Linux systemd / cron에 다회 트리거 자동 등록

기존 설정이 있으면 `init`이 마이그레이션 체크를 실행하여 새 기능 적용 여부를 물어본다.

---

## 명령어

| 명령 | 설명 |
|------|------|
| `init` | 초기 설정 + 자동 스케줄 등록. 기존 설정 있으면 마이그레이션 체크 |
| `run` | 1회 측정 + 미달 시 이의신청 (오늘 완료 시 스킵) |
| `run --dry-run` | 측정만 (신청 안 함) |
| `run --force` | 오늘 완료 여부 무시하고 강제 실행 |
| `config show` | 현재 설정 확인 |
| `history` | 최근 측정 이력 |
| `history -m 2026-03` | 특정 월 이력 |
| `report` | 월간 요약 |
| `schedule install` | 자동 스케줄 등록 |
| `schedule remove` | 자동 스케줄 제거 |

---

## 자동 스케줄

`init` 시 OS에 맞게 자동 등록된다. 설정에 따라 하루 최대 10회, 2시간 간격으로 트리거.

| OS | 방식 | 설정 파일 |
|----|------|----------|
| macOS | launchd | `~/Library/LaunchAgents/com.damn-my-slow-kt.plist` |
| Linux (systemd) | systemd user timer | `~/.config/systemd/user/damn-my-slow-kt.timer` |
| Linux (기타) | crontab | `crontab -l` |

스케줄 제거:
```bash
npx damn-my-slow-kt schedule remove
```

---

## 설정 파일

경로: `~/.damn-my-slow-isp/config-kt.yaml`

`init` 실행 시 자동 생성. 직접 편집도 가능:

```yaml
_config_version: 3

credentials:
  id: "kt아이디@example.com"
  password: "비밀번호"

plan:
  name: "기가라이트"
  speed_mbps: 1000       # 계약 속도 (Mbps)

schedule:
  time: "04:00"          # 첫 측정 시작 시간
  timezone: "Asia/Seoul"
  max_attempts: 10       # 하루 최대 측정 횟수
  retry_interval_minutes: 120  # 트리거 간격 (분)
  stop_on_complaint_success: true  # 감면 성공 시 나머지 스킵

notification:
  discord_webhook: ""    # Discord 알림 (선택)
  telegram_bot_token: "" # Telegram 알림 (선택)
  telegram_chat_id: ""

headless: true           # false면 브라우저 창 표시 (디버그용)
db_path: "~/.damn-my-slow-isp/history-kt.db"
```

---

## 업데이트

```bash
npx damn-my-slow-kt@latest init
```

업데이트 후 `init` 또는 `run`을 실행하면 새 기능에 대한 마이그레이션 안내가 나온다:

```
📋 업데이트 후 변경 사항이 있습니다:

  [v3] 다회 측정 지원 (하루 최대 10회)
    기존: 하루 1회 측정
    변경: 하루 최대 10회, 2시간 간격으로 측정 (감면 성공 시 중단)

? [v3] 다회 측정 지원 - 적용하시겠습니까? (Y/n)
? 스케줄을 새 설정으로 재등록하시겠습니까? (Y/n)
```

---

## KT SLA 감면 제도

### 왜 매일 돌려야 하는가

| | 한 번만 측정 | 매일 측정 |
|---|---|---|
| 감면 범위 | **하루분만** | **매일 하루분씩** |
| 월 49,500원 기준 | ~1,650원 | **49,500원 (전액)** |

KT SLA 감면은 **측정한 날의 이용 요금만** 감면된다. 한 번 측정해서 한 달 치가 빠지는 게 아니다. 그래서 매일 자동으로 돌려야 의미가 있다.

### 감면 기준

- **최저보장속도**: 계약 속도의 50%
  - 1Gbps 계약 → 500Mbps 미달 시 감면 대상
- **판정**: 5회 측정 (300초 간격, 총 ~25분) 중 3회 이상 미달 → 이의신청 가능
- **대상**: 유선(LAN) 연결만 (Wi-Fi 제외)
- **측정 서버**: [speed.kt.com](https://speed.kt.com) KT 공식 SLA 측정

---

## 데이터 저장 경로

| 파일 | 경로 |
|------|------|
| 설정 파일 | `~/.damn-my-slow-isp/config-kt.yaml` |
| 측정 이력 DB | `~/.damn-my-slow-isp/history-kt.db` |
| 실행 로그 | `~/.damn-my-slow-isp/run.log` |
| 에러 로그 | `~/.damn-my-slow-isp/run.error.log` |

---

## 요구사항

- Node.js 20+
- KT 인터넷 계정
- 유선(LAN) 연결 환경
