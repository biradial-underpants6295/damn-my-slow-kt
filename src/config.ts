/**
 * 설정 파일 로드/저장 - KT 전용
 * 기본 경로: ~/.damn-my-slow-isp/config-kt.yaml
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import os from 'os';

/** 모든 ISP 공용 데이터 디렉토리 (~/.damn-my-slow-isp/) */
export const DATA_DIR = path.join(os.homedir(), '.damn-my-slow-isp');

export interface Credentials {
  id: string;
  password: string;
}

export interface Plan {
  name: string;
  speed_mbps: number;
}

export interface Schedule {
  time: string;
  timezone: string;
}

export interface Notification {
  discord_webhook: string;
  telegram_bot_token: string;
  telegram_chat_id: string;
}

export interface Config {
  credentials: Credentials;
  plan: Plan;
  schedule: Schedule;
  notification: Notification;
  headless: boolean;
  db_path: string;
}

export const DEFAULT_CONFIG_PATH = path.join(DATA_DIR, 'config-kt.yaml');

export function getDefaultConfig(): Config {
  return {
    credentials: { id: '', password: '' },
    plan: { name: '기가라이트', speed_mbps: 1000 },
    schedule: { time: '04:00', timezone: 'Asia/Seoul' },
    notification: {
      discord_webhook: '',
      telegram_bot_token: '',
      telegram_chat_id: '',
    },
    headless: true,
    db_path: path.join(DATA_DIR, 'history-kt.db'),
  };
}

export function loadConfig(configPath?: string): Config {
  const cfgPath = configPath || DEFAULT_CONFIG_PATH;

  if (!fs.existsSync(cfgPath)) {
    throw new Error(
      `설정 파일이 없습니다: ${cfgPath}\n'npx damn-my-slow-kt init' 명령으로 설정 파일을 생성하세요.`
    );
  }

  const raw = yaml.load(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown> || {};
  const defaults = getDefaultConfig();

  const creds = (raw.credentials || {}) as Record<string, string>;
  const plan = (raw.plan || {}) as Record<string, unknown>;
  const sched = (raw.schedule || {}) as Record<string, string>;
  const notif = (raw.notification || {}) as Record<string, string>;

  return {
    credentials: {
      id: creds.id || '',
      password: creds.password || '',
    },
    plan: {
      name: String(plan.name || '기가라이트'),
      speed_mbps: Number(plan.speed_mbps || 1000),
    },
    schedule: {
      time: sched.time || '04:00',
      timezone: sched.timezone || 'Asia/Seoul',
    },
    notification: {
      discord_webhook: notif.discord_webhook || '',
      telegram_bot_token: notif.telegram_bot_token || '',
      telegram_chat_id: notif.telegram_chat_id || '',
    },
    headless: raw.headless !== undefined ? Boolean(raw.headless) : true,
    db_path: String(raw.db_path || defaults.db_path),
  };
}

export function saveConfig(config: Config, configPath?: string): void {
  const cfgPath = configPath || DEFAULT_CONFIG_PATH;

  const data = {
    credentials: {
      id: config.credentials.id,
      password: config.credentials.password,
    },
    plan: {
      name: config.plan.name,
      speed_mbps: config.plan.speed_mbps,
    },
    schedule: {
      time: config.schedule.time,
      timezone: config.schedule.timezone,
    },
    notification: {
      discord_webhook: config.notification.discord_webhook,
      telegram_bot_token: config.notification.telegram_bot_token,
      telegram_chat_id: config.notification.telegram_chat_id,
    },
    headless: config.headless,
    db_path: config.db_path,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fs.writeFileSync(cfgPath, (yaml as any).dump(data, { allowUnicode: true }), 'utf8');
}

export function getExampleConfigContent(): string {
  return `# damn-my-slow-kt 설정 파일
# 주의: 이 파일은 .gitignore에 포함되어 있습니다 (비밀번호 보호)

credentials:
  id: "KT_아이디@example.com"
  password: "비밀번호"

plan:
  name: "기가라이트"
  speed_mbps: 1000  # 계약 속도 (Mbps) - 기가라이트: 1000, 기가프리미엄: 2000

schedule:
  time: "04:00"  # 매일 새벽 4시 측정
  timezone: "Asia/Seoul"

notification:
  discord_webhook: ""  # Discord 웹훅 URL (선택)
  telegram_bot_token: ""  # Telegram 봇 토큰 (선택)
  telegram_chat_id: ""  # Telegram 채팅 ID (선택)

headless: true  # false로 설정하면 브라우저 창 표시 (디버그용)
db_path: "~/.damn-my-slow-isp/history-kt.db"  # 측정 이력 저장 경로
`;
}
