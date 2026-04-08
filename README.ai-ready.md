# AI Agentic Coding Setup — damn-my-slow-kt

> **이 문서는 AI 에이전트(Codex, Claude Code, OpenCode 등)가 이 프로젝트를 개발/테스트할 때 필요한 환경 설정을 안내합니다.**
> 사람 개발자가 AI 코딩 환경을 구성할 때도 참고하세요.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   damn-my-slow-kt                    │
│                                                      │
│  CLI (Commander)                                     │
│    ├── init      → 설정 wizard + 스케줄 등록          │
│    ├── run       → Playwright → speed.kt.com 측정    │
│    ├── history   → SQLite/JSON DB 조회               │
│    ├── report    → 월간 통계                          │
│    └── schedule  → launchd/systemd/cron 등록         │
│                                                      │
│  Storage: SQLite (Node 22+) / JSON fallback (20+)   │
│  Config:  ~/.damn-my-slow-isp/config-kt.yaml        │
│  No external DB/Redis/Docker required!              │
└─────────────────────────────────────────────────────┘
```

---

## Quick Setup (Local Development)

```bash
# 1. Install dependencies
npm install

# 2. Install Playwright browsers (headless Chromium)
npx playwright install chromium

# 3. Build
npm run build

# 4. Create test config (optional — only needed for actual KT measurement)
cp config.yaml.example ~/.damn-my-slow-isp/config-kt.yaml
# Edit with your KT credentials if you want to test real measurement

# 5. Run type check + lint + tests
npm run typecheck
npm run lint
npm test
```

---

## Codex Cloud Setup (Ubuntu 24.04)

> **Codex Cloud는 Docker를 사용할 수 없습니다.**
> 이 프로젝트는 외부 서비스(MySQL, Redis 등)가 불필요하므로 바로 사용 가능합니다.

### Setup Script (네트워크 접근 가능 시)

```bash
#!/bin/bash
# Codex Cloud: 초기 설정 (network enabled)
npm install
npx playwright install-deps chromium  # 시스템 의존성 (Ubuntu)
npx playwright install chromium       # Chromium 브라우저 바이너리
npm run build
```

### Maintain Script (브랜치 전환 후)

```bash
#!/bin/bash
# Codex Cloud: 브랜치 체크아웃 후 유지보수
npm install
npm run build
```

---

## Required Secrets

| Secret | Required | Purpose |
|--------|----------|---------|
| KT ID/Password | **Yes** (for `run` only) | KT 계정 — `config.yaml`에 설정 |
| Discord Webhook | No | 결과 알림 |
| Telegram Token | No | 결과 알림 |

> **개발/테스트 시에는 credential 없이도** `build`, `typecheck`, `lint`, `test` 모두 실행 가능합니다.
> `run` 명령만 실제 KT 계정이 필요합니다.

---

## Available Commands

| Command | Description | Needs Credential |
|---------|-------------|-----------------|
| `npm run build` | TypeScript → JavaScript 컴파일 | No |
| `npm run typecheck` | `tsc --noEmit` 타입 체크 | No |
| `npm run lint` | ESLint 정적 분석 | No |
| `npm test` | Vitest 단위 테스트 | No |
| `npm run dev` | ts-node 개발 모드 | No |

---

## Tech Stack Summary

| Component | Technology | Notes |
|-----------|-----------|-------|
| Language | TypeScript (ES2020, CommonJS) | `strict: true` |
| Runtime | Node.js 20+ | Node 22+ 권장 (native SQLite) |
| CLI | Commander + Inquirer + Chalk v4 | CJS 호환 버전 |
| Browser | Playwright (Chromium) | KT SLA 측정 자동화 |
| Storage | node:sqlite / JSON fallback | 외부 DB 불필요 |
| HTTP | Axios | 알림, npm 업데이트 체크 |
| Config | YAML (js-yaml) | `~/.damn-my-slow-isp/config-kt.yaml` |
| Lint | ESLint + typescript-eslint | `eslint.config.mjs` |
| Test | Vitest | `tests/` directory |
