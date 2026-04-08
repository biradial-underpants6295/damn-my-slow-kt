/**
 * 자동 업데이트 체크 - npm registry에서 최신 버전 확인
 * 24시간에 1번만 체크 (캐시)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import chalk from 'chalk';

const CACHE_FILE = path.join(os.homedir(), '.damn-my-slow-isp', 'update-cache.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24시간
const PACKAGE_NAME = 'damn-my-slow-kt';

interface UpdateCache {
  lastCheck: number;
  latestVersion: string;
}

function readCache(): UpdateCache | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(raw) as UpdateCache;
  } catch {
    return null;
  }
}

function writeCache(data: UpdateCache): void {
  try {
    const dir = path.dirname(CACHE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf8');
  } catch {
    // ignore cache write errors
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const resp = await axios.get(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      timeout: 5000,
    });
    return resp.data?.version || null;
  } catch {
    return null;
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

export async function checkForUpdates(
  currentVersion: string,
  options: { noUpdateCheck?: boolean; interactive?: boolean } = {}
): Promise<void> {
  if (options.noUpdateCheck) return;

  const cache = readCache();
  const now = Date.now();

  // 24시간 이내 체크했으면 스킵
  if (cache && now - cache.lastCheck < CHECK_INTERVAL_MS) {
    const latestVersion = cache.latestVersion;
    if (latestVersion && compareVersions(latestVersion, currentVersion) > 0) {
      printUpdateNotice(currentVersion, latestVersion);
    }
    return;
  }

  const latestVersion = await fetchLatestVersion();
  if (!latestVersion) return;

  writeCache({ lastCheck: now, latestVersion });

  if (compareVersions(latestVersion, currentVersion) > 0) {
    printUpdateNotice(currentVersion, latestVersion);
  }
}

function printUpdateNotice(current: string, latest: string): void {
  console.log('');
  console.log(
    chalk.yellow('🔄 새 버전이 있습니다:') +
      chalk.dim(` v${current}`) +
      chalk.yellow(' → ') +
      chalk.green(`v${latest}`)
  );
  console.log(chalk.dim('   업데이트하려면:'));
  console.log(chalk.cyan(`   npm install -g ${PACKAGE_NAME}@latest`));
  console.log('');
}
