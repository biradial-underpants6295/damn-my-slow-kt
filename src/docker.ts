/**
 * Docker 자동 감지 및 래핑
 *
 * Synology NAS 등 GTK 라이브러리가 없는 Linux에서
 * Chromium 실행 실패 시 Playwright 공식 Docker 이미지로 자동 전환.
 */

import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import chalk from 'chalk';
import { DATA_DIR } from './config';

// ─── 감지 함수 ─────────────────────────────────────────────────────

/** Docker 컨테이너 내부에서 실행 중인지 확인 */
export function isInsideDocker(): boolean {
  // 우리가 re-exec 시 설정하는 환경변수 (가장 확실)
  if (process.env.DAMN_DOCKER === '1') return true;

  // Docker 컨테이너는 /.dockerenv 파일이 존재
  if (fs.existsSync('/.dockerenv')) return true;

  // cgroup 기반 감지 (일부 Linux 환경)
  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf-8');
    if (cgroup.includes('docker') || cgroup.includes('containerd')) return true;
  } catch {
    // /proc가 없는 환경 — Docker 아님
  }

  return false;
}

/** Docker CLI가 설치되어 있고 Docker 데몬이 실행 중인지 확인 */
export function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Chromium 실행 실패가 shared library 누락 때문인지 판별.
 * Synology 등에서 libatk-1.0.so.0, libgdk-3.so.0 등이 없을 때 발생.
 */
export function isSharedLibraryError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes('shared libraries') ||
    msg.includes('cannot open shared object file') ||
    msg.includes('libatk') ||
    msg.includes('libgdk') ||
    msg.includes('libgtk') ||
    msg.includes('libgobject') ||
    msg.includes('libglib') ||
    msg.includes('libpango') ||
    msg.includes('libnss') ||
    msg.includes('libnspr')
  );
}

// ─── Docker 재실행 ─────────────────────────────────────────────────

/**
 * 현재 Playwright 버전에 맞는 Docker 이미지 태그 반환.
 * Playwright 공식 Docker 이미지: mcr.microsoft.com/playwright:v{version}-noble
 */
function getDockerImageTag(): string {
  try {
    const pkgPath = require.resolve('playwright/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return `v${pkg.version}-noble`;
  } catch {
    // require.resolve 실패 시 (npx 환경 등) — 안전한 기본값
    return 'v1.52.0-noble';
  }
}

/**
 * 현재 CLI 명령을 Docker 컨테이너 안에서 재실행.
 *
 * - DATA_DIR (~/.damn-my-slow-isp)을 컨테이너에 마운트하여 설정/DB 공유
 * - process.argv에서 서브커맨드와 옵션을 추출하여 그대로 전달
 * - DAMN_DOCKER=1 환경변수로 재귀 방지
 *
 * 이 함수는 반환하지 않음 (process.exit 호출)
 */
export function reExecInDocker(): never {
  const imageTag = getDockerImageTag();
  const dockerImage = `mcr.microsoft.com/playwright:${imageTag}`;
  const containerDataDir = '/root/.damn-my-slow-isp';

  // process.argv에서 서브커맨드 + 옵션 추출 (node, script 경로 제외)
  // 예: ['node', 'damn-my-slow-kt', 'run', '--dry-run'] → ['run', '--dry-run']
  const cliArgs = process.argv.slice(2);

  // DATA_DIR 경로를 컨테이너 경로로 재매핑
  // (사용자가 -c 옵션으로 DATA_DIR 내 경로를 지정한 경우)
  const remappedArgs = cliArgs.map(arg => {
    if (arg.includes(DATA_DIR)) {
      return arg.replace(DATA_DIR, containerDataDir);
    }
    return arg;
  });

  console.log(chalk.cyan('\n🐳 Linux에서 Chromium 실행 불가 — Docker로 자동 전환'));
  console.log(chalk.dim(`   이미지: ${dockerImage}`));
  console.log(chalk.dim(`   마운트: ${DATA_DIR} → ${containerDataDir}`));
  console.log('');

  const dockerArgs = [
    'run', '--rm',
    '-v', `${DATA_DIR}:${containerDataDir}:rw`,
    '-e', 'DAMN_DOCKER=1',
    // 호스트에 TTY가 있으면 -it 추가 (interactive 프롬프트 + 색상 출력)
    ...(process.stdout.isTTY ? ['-it'] : []),
    dockerImage,
    'npx', '-y', 'damn-my-slow-kt@latest',
    ...remappedArgs,
  ];

  const result = spawnSync('docker', dockerArgs, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

/**
 * Docker 미설치 시 안내 메시지 출력.
 * Synology 사용자를 위한 구체적인 설치 가이드 포함.
 */
export function printDockerInstallGuide(errorMsg: string): void {
  console.error(chalk.red('\n❌ Chromium 실행에 필요한 시스템 라이브러리가 없습니다.'));
  console.error(chalk.dim(`   ${errorMsg}`));
  console.error('');
  console.error(chalk.yellow('💡 Docker를 설치하면 자동으로 해결됩니다:'));
  console.error(chalk.dim('   Synology: 패키지센터 → Container Manager 설치'));
  console.error(chalk.dim('   일반 Linux: https://docs.docker.com/engine/install/'));
  console.error('');
  console.error(chalk.dim('   Docker 설치 후 다시 실행하면 자동으로 Docker를 사용합니다.'));
  console.error('');
  console.error(chalk.dim('   수동 실행:'));
  console.error(chalk.dim(`   docker run --rm -v ${DATA_DIR}:/root/.damn-my-slow-isp \\`));
  console.error(chalk.dim('     mcr.microsoft.com/playwright:v1.52.0-noble \\'));
  console.error(chalk.dim('     npx -y damn-my-slow-kt@latest run'));
}
