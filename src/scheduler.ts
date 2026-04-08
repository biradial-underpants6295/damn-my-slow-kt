/**
 * 자동 스케줄 설치/제거 (macOS launchd / Linux systemd/cron)
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Config, DATA_DIR, DEFAULT_CONFIG_PATH } from './config';

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
// 스케줄 시간 계산
// ─────────────────────────────────────────────

interface ScheduleTime { hour: number; minute: number; }

/**
 * 시작 시간 + 간격 + 최대 횟수로 트리거 시간 목록 생성.
 * 예: 04:00, max=10, interval=120 → 04:00, 06:00, 08:00, ..., 22:00
 */
function buildScheduleTimes(config: Config): ScheduleTime[] {
  const [startH, startM] = config.schedule.time.split(':').map(Number);
  const maxAttempts = config.schedule.max_attempts || 10;
  const intervalMin = config.schedule.retry_interval_minutes || 120;

  const times: ScheduleTime[] = [];
  for (let i = 0; i < maxAttempts; i++) {
    const totalMinutes = (startH * 60 + startM) + (i * intervalMin);
    const hour = Math.floor(totalMinutes / 60) % 24;
    const minute = totalMinutes % 60;

    // 다음 날로 넘어가면 중단 (24시간 내만)
    if (i > 0 && totalMinutes >= 24 * 60) break;

    times.push({ hour, minute });
  }
  return times;
}

/** 스케줄 시간을 보기 좋게 출력 */
function formatScheduleTimes(times: ScheduleTime[]): string {
  return times.map((t) => `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`).join(', ');
}

// ─────────────────────────────────────────────
// macOS - launchd plist
// ─────────────────────────────────────────────

function buildLaunchdPlist(config: Config): string {
  const times = buildScheduleTimes(config);
  const exec = getCliExec();
  const configPath = DEFAULT_CONFIG_PATH;
  const logDir = DATA_DIR;
  const logPath = path.join(logDir, 'run.log');
  const errPath = path.join(logDir, 'run.error.log');

  fs.mkdirSync(logDir, { recursive: true });

  const args = [exec.program, ...exec.prefixArgs, 'run', '--config', configPath];
  const argsXml = args.map((a) => `    <string>${a}</string>`).join('\n');

  // launchd는 StartCalendarInterval을 array로 받으면 여러 시간에 트리거
  const calendarEntries = times.map((t) => `    <dict>
      <key>Hour</key>
      <integer>${t.hour}</integer>
      <key>Minute</key>
      <integer>${t.minute}</integer>
    </dict>`).join('\n');

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
  <array>
${calendarEntries}
  </array>
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

  const times = buildScheduleTimes(config);
  console.log(`✅ macOS launchd 스케줄 등록 완료: ${LAUNCHD_PLIST_PATH}`);
  console.log(`   매일 ${times.length}회 실행: ${formatScheduleTimes(times)}`);
  console.log(`   감면 성공 시 나머지 실행은 자동 스킵됩니다.`);
  console.log(`\n   제거하려면: npx damn-my-slow-kt schedule remove`);
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

/** crontab 바이너리가 PATH에 존재하는지 확인 */
function hasCrontab(): boolean {
  try {
    execSync('which crontab 2>/dev/null', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Synology NAS 감지 — /etc/synoinfo.conf 존재 여부로 판별.
 * Synology DSM은 user-level crontab이 없고 /etc/crontab을 직접 편집해야 한다.
 */
function isSynology(): boolean {
  return fs.existsSync('/etc/synoinfo.conf');
}

export function installLinux(config: Config): void {
  if (hasSystemd()) {
    installSystemd(config);
  } else if (isSynology()) {
    installSynologyCron(config);
  } else if (hasCrontab()) {
    installCron(config);
  } else {
    throw new Error(
      'crontab 명령어를 찾을 수 없습니다.\n' +
      '수동으로 cron을 설정하세요:\n' +
      `  npx --yes damn-my-slow-kt run --config ${DEFAULT_CONFIG_PATH}`
    );
  }
}

function installSystemd(config: Config): void {
  const times = buildScheduleTimes(config);
  const exec = getCliExec();
  const configPath = DEFAULT_CONFIG_PATH;

  const serviceDir = path.dirname(SYSTEMD_SERVICE_PATH);
  fs.mkdirSync(serviceDir, { recursive: true });

  const execCmd = [exec.program, ...exec.prefixArgs, 'run', '--config', configPath].join(' ');

  const serviceContent = `[Unit]
Description=damn-my-slow-kt KT SLA Speed Test

[Service]
Type=oneshot
ExecStart=${execCmd}
StandardOutput=journal
StandardError=journal
`;

  // systemd는 여러 OnCalendar 라인을 지원
  const onCalendarLines = times
    .map((t) => `OnCalendar=*-*-* ${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}:00`)
    .join('\n');

  const timerContent = `[Unit]
Description=damn-my-slow-kt daily timer (${times.length}회/일)

[Timer]
${onCalendarLines}
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
  console.log(`   매일 ${times.length}회 실행: ${formatScheduleTimes(times)}`);
  console.log(`   감면 성공 시 나머지 실행은 자동 스킵됩니다.`);
  console.log(`   확인: systemctl --user status damn-my-slow-kt.timer`);
  console.log(`\n   제거하려면: npx damn-my-slow-kt schedule remove`);
}

/**
 * Synology NAS 전용 cron 설치.
 * DSM은 user-level crontab이 없으므로 /etc/crontab을 직접 편집하고
 * synoservicectl --restart crond로 crond를 재시작한다.
 * /etc/crontab 형식: minute hour mday month wday user command
 */
function installSynologyCron(config: Config): void {
  const SYSTEM_CRONTAB = '/etc/crontab';
  const times = buildScheduleTimes(config);
  const exec = getCliExec();
  const configPath = DEFAULT_CONFIG_PATH;
  const logPath = path.join(DATA_DIR, 'cron.log');
  const user = os.userInfo().username;

  const execCmd = [exec.program, ...exec.prefixArgs, 'run', '--config', configPath].join(' ');

  // Synology /etc/crontab은 user 필드가 포함된 형식
  const cronLines = times.map((t) =>
    `${t.minute}\t${t.hour}\t*\t*\t*\t${user}\t${execCmd} >> ${logPath} 2>&1 ${CRON_COMMENT}`
  );

  let existing = '';
  try {
    existing = fs.readFileSync(SYSTEM_CRONTAB, 'utf8');
  } catch {
    throw new Error(`${SYSTEM_CRONTAB}을 읽을 수 없습니다. sudo 권한이 필요할 수 있습니다.`);
  }

  // 기존 damn-my-slow-kt 라인 제거 후 새 라인 추가
  const lines = existing
    .split('\n')
    .filter((l) => !l.includes(CRON_COMMENT));

  // 마지막 빈 줄 유지하면서 추가
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  lines.push(...cronLines, '');

  const newCrontab = lines.join('\n');

  try {
    fs.writeFileSync(SYSTEM_CRONTAB, newCrontab, 'utf8');
  } catch {
    throw new Error(
      `/etc/crontab 쓰기 실패. sudo 권한으로 다시 시도하세요:\n` +
      `  sudo npx --yes damn-my-slow-kt schedule install`
    );
  }

  // crond 재시작으로 변경사항 반영
  try {
    execSync('synoservicectl --restart crond 2>/dev/null', { stdio: 'ignore' });
  } catch {
    // synoservicectl이 없으면 /usr/syno/bin/ 경로로 재시도
    try {
      execSync('/usr/syno/bin/synoservicectl --restart crond 2>/dev/null', { stdio: 'ignore' });
    } catch {
      console.log('⚠️  crond 재시작 실패 — NAS를 재부팅하면 반영됩니다.');
    }
  }

  console.log(`✅ Synology /etc/crontab 등록 완료`);
  console.log(`   매일 ${times.length}회 실행: ${formatScheduleTimes(times)}`);
  console.log(`   감면 성공 시 나머지 실행은 자동 스킵됩니다.`);
  console.log(`\n   제거하려면: sudo npx --yes damn-my-slow-kt schedule remove`);
}

function installCron(config: Config): void {
  const times = buildScheduleTimes(config);
  const exec = getCliExec();
  const configPath = DEFAULT_CONFIG_PATH;
  const logPath = path.join(DATA_DIR, 'cron.log');

  const execCmd = [exec.program, ...exec.prefixArgs, 'run', '--config', configPath].join(' ');

  // 각 트리거 시간마다 cron 라인 생성
  const cronLines = times.map((t) =>
    `${t.minute} ${t.hour} * * * ${execCmd} >> ${logPath} 2>&1 ${CRON_COMMENT}`
  );

  let existing = '';
  try {
    existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
  } catch {
    // no crontab
  }

  // 기존 damn-my-slow-kt 라인 제거 후 새 라인 추가
  const lines = existing
    .split('\n')
    .filter((l) => !l.includes(CRON_COMMENT));
  lines.push(...cronLines);

  const newCrontab = lines.join('\n') + '\n';

  // stdin 방식 먼저 시도 (표준 Linux)
  const proc = require('child_process').spawnSync('crontab', ['-'], {
    input: newCrontab,
    encoding: 'utf8',
  });

  if (proc.status !== 0 || proc.error) {
    // BusyBox(Synology NAS 등)는 crontab - (stdin) 미지원 → 임시 파일 방식으로 재시도
    const tmpFile = path.join(os.tmpdir(), `damn-my-slow-kt-cron-${Date.now()}.tmp`);
    try {
      fs.writeFileSync(tmpFile, newCrontab, 'utf8');
      const proc2 = require('child_process').spawnSync('crontab', [tmpFile], {
        encoding: 'utf8',
      });
      if (proc2.status !== 0 || proc2.error) {
        const errMsg =
          (proc2.stderr as string | undefined) ||
          proc2.error?.message ||
          (proc.stderr as string | undefined) ||
          proc.error?.message ||
          'unknown error';
        throw new Error(`crontab 설치 실패: ${errMsg}`);
      }
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  console.log(`✅ crontab 등록 완료`);
  console.log(`   매일 ${times.length}회 실행: ${formatScheduleTimes(times)}`);
  console.log(`   감면 성공 시 나머지 실행은 자동 스킵됩니다.`);
  console.log(`\n   제거하려면: npx damn-my-slow-kt schedule remove`);
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

  // Synology NAS: /etc/crontab에서 제거
  if (isSynology()) {
    try {
      const SYSTEM_CRONTAB = '/etc/crontab';
      const existing = fs.readFileSync(SYSTEM_CRONTAB, 'utf8');
      const lines = existing.split('\n').filter((l) => !l.includes(CRON_COMMENT));
      fs.writeFileSync(SYSTEM_CRONTAB, lines.join('\n') + '\n', 'utf8');
      try {
        execSync('synoservicectl --restart crond 2>/dev/null', { stdio: 'ignore' });
      } catch {
        try {
          execSync('/usr/syno/bin/synoservicectl --restart crond 2>/dev/null', { stdio: 'ignore' });
        } catch { /* ignore */ }
      }
      console.log('✅ Synology /etc/crontab 스케줄 제거 완료');
    } catch {
      console.log('⚠️  /etc/crontab 수정 실패. sudo 권한으로 다시 시도하세요.');
    }
    return;
  }

  // 일반 Linux: crontab 명령어로 제거
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
    const times = buildScheduleTimes(config);
    console.log('Windows에서는 작업 스케줄러(Task Scheduler)를 사용하세요:');
    console.log('1. Win + R → taskschd.msc 입력');
    console.log('2. 기본 작업 만들기 클릭');
    console.log(`3. 프로그램: npx --yes damn-my-slow-kt run --config ${DEFAULT_CONFIG_PATH}`);
    console.log(`4. 트리거: 매일 ${formatScheduleTimes(times)} (${times.length}개 등록)`);
    console.log('   (run 내부에서 오늘 완료 여부를 체크하므로 모두 등록해도 안전합니다)');
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
