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

설정하면 끝. 매일 새벽 4시에 알아서 측정하고, 미달이면 바로 신청한다.

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
   4: 71 Mbps   ❌
   5회: 64 Mbps  ❌
   → 5/5 미달 (기준: 500 Mbps)

✅ Bot: 이의신청 버튼 클릭 완료
   Discord 알림 발송 → 결과 DB 저장
```

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
- **자동 스케줄 등록** - macOS launchd 또는 Linux systemd에 자동으로 등록

---

## 명령어

| 명령 | 설명 |
|------|------|
| `init` | 초기 설정 + 자동 스케줄 등록 |
| `run` | 즉시 측정 + 미달 시 이의신청 |
| `run --dry-run` | 측정만 (신청 안 함) |
| `history` | 최근 측정 이력 |
| `history -m 2026-03` | 특정 월 이력 |
| `report` | 월간 요약 |
| `schedule install` | 자동 스케줄 등록 |
| `schedule remove` | 자동 스케줄 제거 |

---

## 자동 스케줄

`init` 시 OS에 맞게 자동 등록된다.

| OS | 방식 | 설정 파일 |
|----|------|----------|
| macOS | launchd | `~/Library/LaunchAgents/com.damn-my-slow-kt.plist` |
| Linux (systemd) | systemd user timer | `~/.config/systemd/user/` |
| Linux (기타) | crontab | `crontab -l` |

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

## 설정 파일 (config.yaml)

`init` 실행 시 자동 생성. 직접 편집도 가능:

```yaml
credentials:
  id: "kt아이디@example.com"
  password: "비밀번호"

plan:
  name: "기가라이트"
  speed_mbps: 1000       # 계약 속도 (Mbps)

schedule:
  time: "04:00"
  timezone: "Asia/Seoul"

notification:
  discord_webhook: ""    # Discord 알림 (선택)
  telegram_bot_token: "" # Telegram 알림 (선택)
  telegram_chat_id: ""
```

> `config.yaml`은 `.gitignore`에 포함되어 있습니다.

---

## 요구사항

- Node.js 20+
- KT 인터넷 계정
