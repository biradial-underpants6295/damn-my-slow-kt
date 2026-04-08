/**
 * 자동 스케줄 설치/제거 (macOS launchd / Linux systemd/cron)
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Config } from './config';

const LAUNCHD_PLIST_PATH = path.join(
  os.homedir(),
  'Library',
  'LaunchAgents',
  'com.damn-my-slow-kt.plist'
);
const CRON_COMMENT = '# damn-my-slow-kt';
const SYSTEMD_SERVICE_PATH = path.join(
  os.homedir(),
  '.config',
  'systemd',
  'user',
  'damn-my-slow-kt.service'
);
const SYSTEMD_TIMER_PATH = path.join(
  os.homedir(),
  '.config',
  'systemd',
  'user',
  'damn-my-slow-kt.timer'
);

export function getPlatform(): 'macos' | 'linux' | 'windows' | 'unknown' {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  if (platform === 'win32') return 'windows';
  return 'unknown';
}

/**
 * npx 임시 캐시 경로인지 판별.
 * npx는 _npx/ 디렉토리 아래에 임시 설치하므로, launchd/cron에 이 경로를 기록하면
 * 세션 종료 후 파일이 사라져 실행 실패한다.
 */
function isNpxTempPath(p: string): boolean {
  return p.includes('/_npx/') || p.includes('\\_npx\\');
}

interface CliExec {
  /** 실행 바이너리 (npx 모드면 npx 절대경로, 아니면 CLI 절대경로) */
  program: string;
  /** program 뒤에 붙는 인자 (npx 모드면 ['--yes', 'damn-my-slow-kt']) */
  prefixArgs: string[];
  /** npx 모드 여부 */
  isNpx: boolean;
}

function getCliExec(): CliExec {
  // 1) 글로벌 설치 경로 확인
  try {
    const globalPath = execSync('which damn-my-slow-kt 2>/dev/null', { encoding: 'utf8' }).trim();
    if (globalPath && !isNpxTempPath(globalPath)) {
      return { program: globalPath, prefixArgs: [], isNpx: false };
    }
  } catch {
    // ignore
  }

  // 2) process.argv[1]이 안정적 경로(글로벌 or 로컬 node_modules)인 경우
  const scriptPath = process.argv[1];
  if (scriptPath && scriptPath.includes('damn-my-slow-kt') && !isNpxTempPath(scriptPath)) {
    return { program: scriptPath, prefixArgs: [], isNpx: false };
  }

  // 3) npx 모드 - npx 바이너리 절대경로를 찾아서 사용
  let npxPath = 'npx';
  try {
    npxPath = execSync('which npx 2>/dev/null', { encoding: 'utf8' }).trim() || 'npx';
  } catch {
    // fallback
  }
  return { program: npxPath, prefixArgs: ['--yes', 'damn-my-slow-kt'], isNpx: true };
}

/** 사용자 안내용 실행 명령어 문자열 */
export function getRunCommand(): string {
  const exec = getCliExec();
  if (exec.isNpx) {
    return 'npx damn-my-slow-kt';
  }
  return 'damn-my-slow-kt';
}

// ─────────────────────────────────────────────
// macOS - launchd plist
// ─────────────────────────────────────────────

function buildLaunchdPlist(config: Config): string {
  const [hour, minute] = config.schedule.time.split(':');
  const exec = getCliExec();
  const configPath = path.resolve('config.yaml');
  const logDir = path.join(os.homedir(), '.damn-my-slow-kt');
  const logPath = path.join(logDir, 'run.log');
  const errPath = path.join(logDir, 'run.error.log');

  fs.mkdirSync(logDir, { recursive: true });

  // ProgramArguments: [program, ...prefixArgs, 'run', '--config', configPath]
  const args = [exec.program, ...exec.prefixArgs, 'run', '--config', configPath];
  const argsXml = args.map((a) => `    <string>${a}</string>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.damn-my-slow-kt</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${parseInt(hour)}</integer>
    <key>Minute</key>
    <integer>${parseInt(minute)}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${errPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
}

export function installMacos(config: Config): void {
  const plistDir = path.dirname(LAUNCHD_PLIST_PATH);
  fs.mkdirSync(plistDir, { recursive: true });

  // 기존 언로드
  try {
    execSync(`launchctl unload "${LAUNCHD_PLIST_PATH}" 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    // ignore
  }

  const plist = buildLaunchdPlist(config);
  fs.writeFileSync(LAUNCHD_PLIST_PATH, plist, 'utf8');

  execSync(`launchctl load "${LAUNCHD_PLIST_PATH}"`);
  console.log(`✅ macOS launchd 스케줄 등록 완료: ${LAUNCHD_PLIST_PATH}`);
  console.log(`   매일 ${config.schedule.time}에 자동 실행됩니다.`);
}

export function removeMacos(): void {
  if (!fs.existsSync(LAUNCHD_PLIST_PATH)) {
    console.log('등록된 launchd 스케줄이 없습니다.');
    return;
  }

  try {
    execSync(`launchctl unload "${LAUNCHD_PLIST_PATH}" 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    // ignore
  }

  fs.unlinkSync(LAUNCHD_PLIST_PATH);
  console.log('✅ macOS launchd 스케줄 제거 완료');
}

// ─────────────────────────────────────────────
// Linux - systemd timer 또는 cron
// ─────────────────────────────────────────────

function hasSystemd(): boolean {
  try {
    execSync('systemctl --user status 2>/dev/null', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function installLinux(config: Config): void {
  if (hasSystemd()) {
    installSystemd(config);
  } else {
    installCron(config);
  }
}

function installSystemd(config: Config): void {
  const [hour, minute] = config.schedule.time.split(':');
  const exec = getCliExec();
  const configPath = path.resolve('config.yaml');

  const serviceDir = path.dirname(SYSTEMD_SERVICE_PATH);
  fs.mkdirSync(serviceDir, { recursive: true });

  // ExecStart: program prefixArgs... run --config configPath
  const execCmd = [exec.program, ...exec.prefixArgs, 'run', '--config', configPath].join(' ');

  const serviceContent = `[Unit]
Description=damn-my-slow-kt KT SLA Speed Test

[Service]
Type=oneshot
ExecStart=${execCmd}
StandardOutput=journal
StandardError=journal
`;

  const timerContent = `[Unit]
Description=damn-my-slow-kt daily timer

[Timer]
OnCalendar=*-*-* ${hour}:${minute}:00
Persistent=true

[Install]
WantedBy=timers.target
`;

  fs.writeFileSync(SYSTEMD_SERVICE_PATH, serviceContent, 'utf8');
  fs.writeFileSync(SYSTEMD_TIMER_PATH, timerContent, 'utf8');

  execSync('systemctl --user daemon-reload');
  execSync('systemctl --user enable damn-my-slow-kt.timer');
  execSync('systemctl --user start damn-my-slow-kt.timer');

  console.log(`✅ systemd 타이머 등록 완료`);
  console.log(`   매일 ${config.schedule.time}에 자동 실행됩니다.`);
  console.log(`   확인: systemctl --user status damn-my-slow-kt.timer`);
}

function installCron(config: Config): void {
  const [hour, minute] = config.schedule.time.split(':');
  const exec = getCliExec();
  const configPath = path.resolve('config.yaml');
  const logPath = path.join(os.homedir(), '.damn-my-slow-kt', 'cron.log');

  const execCmd = [exec.program, ...exec.prefixArgs, 'run', '--config', configPath].join(' ');
  const cronLine =
    `${minute} ${hour} * * * ` +
    `${execCmd} >> ${logPath} 2>&1 ${CRON_COMMENT}`;

  let existing = '';
  try {
    existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
  } catch {
    // no crontab
  }

  const lines = existing
    .split('\n')
    .filter((l) => !l.includes(CRON_COMMENT));
  lines.push(cronLine);

  const newCrontab = lines.join('\n') + '\n';
  const { execFileSync } = require('child_process');
  const proc = require('child_process').spawnSync('crontab', ['-'], {
    input: newCrontab,
    encoding: 'utf8',
  });

  if (proc.status !== 0) {
    throw new Error(`crontab 설치 실패: ${proc.stderr}`);
  }

  console.log(`✅ crontab 등록 완료`);
  console.log(`   매일 ${config.schedule.time}에 자동 실행됩니다.`);
}

export function removeLinux(): void {
  if (fs.existsSync(SYSTEMD_SERVICE_PATH) || fs.existsSync(SYSTEMD_TIMER_PATH)) {
    try {
      execSync('systemctl --user stop damn-my-slow-kt.timer 2>/dev/null', { stdio: 'ignore' });
      execSync('systemctl --user disable damn-my-slow-kt.timer 2>/dev/null', { stdio: 'ignore' });
    } catch {
      // ignore
    }

    if (fs.existsSync(SYSTEMD_SERVICE_PATH)) fs.unlinkSync(SYSTEMD_SERVICE_PATH);
    if (fs.existsSync(SYSTEMD_TIMER_PATH)) fs.unlinkSync(SYSTEMD_TIMER_PATH);

    try {
      execSync('systemctl --user daemon-reload 2>/dev/null', { stdio: 'ignore' });
    } catch {
      // ignore
    }

    console.log('✅ systemd 타이머 제거 완료');
    return;
  }

  // cron 제거
  try {
    const existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
    const lines = existing.split('\n').filter((l) => !l.includes(CRON_COMMENT));
    const newCrontab = lines.join('\n') + '\n';
    require('child_process').spawnSync('crontab', ['-'], { input: newCrontab, encoding: 'utf8' });
    console.log('✅ crontab 스케줄 제거 완료');
  } catch {
    console.log('등록된 crontab 스케줄이 없습니다.');
  }
}

export function installSchedule(config: Config): void {
  const platform = getPlatform();

  if (platform === 'macos') {
    installMacos(config);
  } else if (platform === 'linux') {
    installLinux(config);
  } else if (platform === 'windows') {
    console.log('');
    console.log('Windows에서는 작업 스케줄러(Task Scheduler)를 사용하세요:');
    console.log('1. Win + R → taskschd.msc 입력');
    console.log('2. 기본 작업 만들기 클릭');
    console.log(`3. 프로그램: npx --yes damn-my-slow-kt run --config ${path.resolve('config.yaml')}`);
    console.log(`4. 트리거: 매일 ${config.schedule.time}`);
  } else {
    throw new Error(`지원하지 않는 플랫폼: ${platform}`);
  }
}

export function removeSchedule(): void {
  const platform = getPlatform();

  if (platform === 'macos') {
    removeMacos();
  } else if (platform === 'linux') {
    removeLinux();
  } else {
    console.log('이 플랫폼에서는 자동 제거가 지원되지 않습니다.');
  }
}
