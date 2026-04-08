/**
 * KT 자동화 - speed.kt.com 품질보증 테스트
 *
 * Flow (실제 테스트를 통해 검증된 플로우):
 *   1. https://speed.kt.com/sla/slatest/introduce.asp 접속
 *   2. "품질보증(SLA) 테스트" 버튼 클릭 (class="redbtn btntolayer") → 레이어 팝업
 *   3. 레이어에서 회선 선택 (radio button - el-radio 컴포넌트, value="0")
 *   4. "#measureBtn" 클릭 → 테스트 시작
 *   5. 5회 자동 측정 완료 대기 (각 300초 간격 → 총 ~25분)
 *   6. 결과 파싱 (SLA pass/fail)
 *   7. fail이면 "이의신청" 버튼 클릭
 *
 * 로그인 플로우:
 *   - 로그인 없이 접속 → accounts.kt.com으로 리다이렉트
 *   - 로그인 후 비밀번호 변경 안내 → "다음에 하기" 클릭 (3개월 유예)
 *   - 로그인 완료 후 SLA 소개 페이지로 복귀
 */

import { Browser, BrowserContext, Page, chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Config, DATA_DIR } from './config';
import chalk from 'chalk';

const KT_SLA_INTRO_URL = 'https://speed.kt.com/sla/slatest/introduce.asp';
// TEST_TIMEOUT_MIN 환경변수로 타임아웃 조절 가능 (기본 40분)
const SLA_TEST_TIMEOUT_MS = (parseInt(process.env.TEST_TIMEOUT_MIN || '0') || 40) * 60 * 1000;
const POLL_INTERVAL_MS = 15 * 1000; // 15초 — 라운드 변화를 빠르게 감지

// ─── 진행 UI 헬퍼 ────────────────────────────────────────────────

const STEPS = {
  login:   { num: 1, total: 5, label: '로그인' },
  layer:   { num: 2, total: 5, label: 'SLA 테스트 준비' },
  measure: { num: 3, total: 5, label: '속도 측정' },
  parse:   { num: 4, total: 5, label: '결과 분석' },
  action:  { num: 5, total: 5, label: '감면 처리' },
};

function stepHeader(step: { num: number; total: number; label: string }): void {
  const bar = '●'.repeat(step.num) + '○'.repeat(step.total - step.num);
  console.log(chalk.cyan(`\n  ${bar}  `) + chalk.bold(`[${step.num}/${step.total}] ${step.label}`));
}

function info(msg: string): void {
  console.log(chalk.dim(`       ${msg}`));
}

function formatElapsed(ms: number): string {
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return min > 0 ? `${min}분 ${sec}초` : `${sec}초`;
}

/** 측정 진행 바 (1~5회차) */
function measureProgress(round: number, total: number, elapsedMs: number): void {
  const filled = round;
  const empty = total - round;
  const bar = chalk.green('■'.repeat(filled)) + chalk.gray('□'.repeat(empty));
  const elapsed = formatElapsed(elapsedMs);
  // 커서를 줄 앞으로 이동하여 같은 줄에 덮어쓰기
  if (process.stdout.isTTY) {
    process.stdout.write(`\r       ${bar}  ${round}/${total}회 완료  ${chalk.dim(elapsed)}  `);
  } else {
    console.log(`       ${bar}  ${round}/${total}회 완료  ${elapsed}`);
  }
}

export interface SpeedTestResult {
  download_mbps: number;
  upload_mbps: number;
  ping_ms: number;
  sla_result: 'pass' | 'fail' | 'unknown';
  complaint_filed: boolean;
  complaint_result: 'success' | 'failed' | 'skipped' | 'not_applicable';
  raw_data: Record<string, unknown>;
  error: string;
}

function defaultResult(): SpeedTestResult {
  return {
    download_mbps: 0,
    upload_mbps: 0,
    ping_ms: 0,
    sla_result: 'unknown',
    complaint_filed: false,
    complaint_result: 'skipped',
    raw_data: {},
    error: '',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class KTProvider {
  private config: Config;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(config: Config) {
    this.config = config;
  }

  async run(dryRun = false): Promise<SpeedTestResult> {
    const result = defaultResult();

    // Playwright 브라우저 바이너리가 없으면 자동 설치 (npx 첫 실행 시 필요)
    try {
      this.browser = await chromium.launch({
        headless: this.config.headless,
        args: [
          '--no-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--use-fake-ui-for-media-stream',
          '--disable-web-security',
        ],
      });
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (err.message.includes("Executable doesn't exist")) {
        console.log('📦 Chromium 브라우저 설치 중... (최초 1회)');
        execSync('npx playwright install chromium', { stdio: 'inherit' });
        this.browser = await chromium.launch({
          headless: this.config.headless,
          args: [
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--use-fake-ui-for-media-stream',
            '--disable-web-security',
          ],
        });
      } else {
        throw e;
      }
    }

    this.context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/123.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });

    try {
      this.page = await this.context.newPage();

      // Step 1: 로그인
      stepHeader(STEPS.login);
      info('speed.kt.com 접속 중...');
      await this.page.goto(KT_SLA_INTRO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);
      await this.handleLogin();

      const currentUrl = this.page.url();
      if (!currentUrl.includes('sla/slatest/introduce.asp')) {
        info('SLA 페이지로 이동 중...');
        await this.page.goto(KT_SLA_INTRO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2000);
      }
      info('로그인 완료');

      // Step 2: SLA 테스트 준비
      stepHeader(STEPS.layer);
      info('품질보증(SLA) 테스트 레이어 열기...');
      await this.openSlaLayer();
      info('회선 선택 중...');
      await this.selectLine();
      info('준비 완료');

      // Step 3: 속도 측정
      stepHeader(STEPS.measure);
      info('5회 측정 시작 (약 25분 소요)');
      await this.startMeasurement();
      await this.waitForCompletion();

      // Step 4: 결과 분석
      stepHeader(STEPS.parse);
      info('측정 데이터 파싱 중...');
      const parsed = await this.parseResults();
      Object.assign(result, parsed);

      // Step 5: 감면 처리
      stepHeader(STEPS.action);
      if (result.sla_result === 'fail' && !dryRun) {
        info('SLA 미달 → 이의신청 진행...');
        const ok = await this.fileComplaint();
        result.complaint_filed = ok;
        result.complaint_result = ok ? 'success' : 'failed';
        info(ok ? '이의신청 완료' : '이의신청 실패');
      } else if (result.sla_result === 'fail' && dryRun) {
        info('SLA 미달 (dry-run → 이의신청 생략)');
        result.complaint_result = 'skipped';
      } else if (result.sla_result === 'pass') {
        info('SLA 통과 → 이의신청 불필요');
        result.complaint_result = 'not_applicable';
      }
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      info(chalk.red(`오류: ${err.message}`));
      result.error = err.message;
      result.sla_result = 'unknown';

      // 오류 스크린샷
      try {
        await this.page?.screenshot({ path: 'kt-error.png' });
        info('스크린샷 저장: kt-error.png');
      } catch {
        // ignore
      }
    } finally {
      await this.context?.close();
      await this.browser?.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }

    return result;
  }

  private async handleLogin(): Promise<void> {
    const page = this.page!;
    const { id, password } = this.config.credentials;

    if (!id || !password) {
      throw new Error('KT 계정 정보가 설정되지 않았습니다. 설정 파일을 확인하세요.');
    }

    const url = page.url();
    if (!url.includes('accounts.kt.com')) {
      return;
    }

    info('KT 로그인 페이지 감지...');
    await this.fillLoginForm(id, password);

    // 로그인 후 리다이렉트 대기 — accounts.kt.com에서 벗어날 때까지
    try {
      await page.waitForURL((url) => !url.toString().includes('accounts.kt.com'), { timeout: 15000 });
    } catch {
      // 비밀번호 변경 등 중간 페이지에서 멈출 수 있음
    }
    await sleep(2000);

    const afterUrl = page.url();
    if (afterUrl.includes('unchanged-password') || afterUrl.includes('change-password')) {
      info('비밀번호 변경 안내 → 다음에 하기');
      try {
        await page.waitForSelector('button', { timeout: 5000 });
        await page.evaluate(() => {
          const btns = document.querySelectorAll('button');
          for (const btn of btns) {
            const text = btn.textContent || '';
            if (text.includes('다음에 하기') || text.includes('나중에') || text.includes('Skip')) {
              btn.click();
              return;
            }
          }
        });
        await sleep(3000);
      } catch {
        // 다음에 하기 버튼 없음, 계속 진행
      }
    }
  }

  private async openSlaLayer(): Promise<void> {
    const page = this.page!;
    const { id, password } = this.config.credentials;

    // SLA 테스트 버튼 클릭 — 미로그인 시 accounts.kt.com으로 리다이렉트됨
    const btnExists = await page.evaluate(() => {
      return !!document.querySelector('a.redbtn.btntolayer');
    });

    if (!btnExists) {
      throw new Error('품질보증(SLA) 테스트 버튼을 찾지 못했습니다');
    }

    await page.click('a.redbtn.btntolayer');
    await sleep(3000);

    // 로그인 페이지로 리다이렉트 되었는지 확인
    const currentUrl = page.url();
    if (currentUrl.includes('accounts.kt.com')) {
      info('로그인 필요 → 로그인 진행');
      await this.fillLoginForm(id, password);

      // 로그인 후 리다이렉트 대기
      try {
        await page.waitForURL((url) => !url.toString().includes('accounts.kt.com'), { timeout: 15000 });
      } catch {
        // 비밀번호 변경 안내 등 중간 페이지에서 멈출 수 있음
      }
      await sleep(2000);

      // 비밀번호 변경 안내 처리
      const afterUrl = page.url();
      if (afterUrl.includes('unchanged-password') || afterUrl.includes('change-password')) {
        info('비밀번호 변경 안내 → 다음에 하기');
        await page.evaluate(() => {
          const btns = document.querySelectorAll('button');
          for (const btn of btns) {
            if ((btn.textContent || '').includes('다음에 하기')) {
              btn.click();
              return;
            }
          }
        });
        await sleep(3000);
      }

      // 로그인 후 SLA 페이지로 재접속
      if (!page.url().includes('sla/slatest/introduce.asp')) {
        await page.goto(KT_SLA_INTRO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2000);
      }

      // 다시 레이어 버튼 클릭
      await page.click('a.redbtn.btntolayer');
      await sleep(3000);
    }

    // 레이어가 열렸는지 확인 — Vue 컴포넌트가 #ifArea에 회선 정보를 렌더링
    const layerText = await page.evaluate(() => {
      return document.getElementById('ifArea')?.textContent?.trim().slice(0, 200) || '';
    });

    if (!layerText) {
      throw new Error('로그인 후에도 SLA 레이어가 열리지 않았습니다');
    }

    info('SLA 레이어 열림');
  }

  private async fillLoginForm(id: string, password: string): Promise<void> {
    const page = this.page!;

    // accounts.kt.com 로그인 폼: input#id (아이디), input#password (비밀번호)
    // 구버전 호환을 위해 generic selector도 fallback으로 유지
    const idSelectors = ['input#id', "input[name='id']", "input[type='text']"];
    const pwSelectors = ['input#password', "input[name='password']", "input[type='password']"];

    let idFilled = false;
    for (const sel of idSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 5000 });
        await page.fill(sel, id);
        info(`계정: ${id}`);
        idFilled = true;
        break;
      } catch {
        continue;
      }
    }
    if (!idFilled) return;

    for (const sel of pwSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 3000 });
        await page.fill(sel, password);
        break;
      } catch {
        continue;
      }
    }

    // 로그인 버튼 클릭 — Playwright의 click()으로 안정적인 클릭
    try {
      const loginBtn = page.locator('button[type="submit"]').filter({ hasText: '로그인' });
      await loginBtn.waitFor({ state: 'visible', timeout: 3000 });
      await loginBtn.click();
    } catch {
      // fallback: evaluate로 직접 클릭
      try {
        await page.evaluate(() => {
          const btns = document.querySelectorAll('button, input[type="submit"]');
          for (const btn of btns) {
            const text = (btn as HTMLElement).textContent || (btn as HTMLInputElement).value || '';
            if (text.includes('로그인')) {
              (btn as HTMLElement).click();
              return;
            }
          }
        });
      } catch {
        // 로그인 버튼 없음
      }
    }
  }

  private async selectLine(): Promise<void> {
    const page = this.page!;

    const result = await page.evaluate(() => {
      // Element UI 라디오 — 첫 번째 회선이 기본 선택됨
      const radioLabel = document.querySelector('label.el-radio.addr') as HTMLElement | null;
      if (radioLabel) {
        radioLabel.click(); // Element UI는 label 클릭으로 선택 처리

        // 회선 정보 텍스트 추출 (상품명 - 주소)
        const labelText = radioLabel.querySelector('.el-radio__label')?.textContent?.trim() || '';
        return labelText || 'selected (no label)';
      }

      // fallback: generic radio
      const radioInput = document.querySelector('input[type="radio"]') as HTMLInputElement | null;
      if (radioInput) {
        radioInput.checked = true;
        radioInput.dispatchEvent(new Event('change', { bubbles: true }));
        const label = radioInput.closest('label');
        if (label) (label as HTMLElement).click();
        return radioInput.value;
      }
      return 'no radio found';
    });

    if (result && result !== 'no radio found') {
      info(`회선: ${result}`);
    }

    await sleep(500);
  }

  private async startMeasurement(): Promise<void> {
    const page = this.page!;

    // #measureBtn (a.speed_speedtest_prestart_btn) 클릭 — Vue 컴포넌트가 SLA 테스트 시작
    const btn = page.locator('#measureBtn, a.speed_speedtest_prestart_btn').first();
    try {
      await btn.waitFor({ state: 'visible', timeout: 5000 });
      await btn.click();
    } catch {
      throw new Error('속도 측정 시작 버튼(#measureBtn)을 찾지 못했습니다');
    }

    await sleep(5000);

    // 측정이 시작되었는지 확인 — "회차 측정중" 또는 결과 테이블이 나타나야 함
    const layerText = await page.evaluate(() => {
      return (
        document
          .getElementById('ifArea')
          ?.textContent?.replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300) || ''
      );
    });

    if (layerText.includes('측정중') || layerText.includes('SLA 테스트')) {
      info('측정 시작 확인');
    } else {
      info('측정 시작 대기 중...');
    }

    // 단말 정보 출력 — 페이지 하단의 품질측정 단말정보
    const deviceInfo = await page.evaluate(() => {
      const ifArea = document.getElementById('ifArea');
      if (!ifArea) return null;
      const text = ifArea.textContent || '';
      const osMatch = text.match(/OS\s+([\s\S]*?)(?=CPU)/);
      const cpuMatch = text.match(/CPU\s+([\s\S]*?)(?=RAM)/);
      const ramMatch = text.match(/RAM\s+([\s\S]*?)(?=Browser)/);
      const browserMatch = text.match(/Browser\s+([\s\S]*?)(?=재측정|$)/);
      return {
        os: osMatch ? osMatch[1].trim() : '',
        cpu: cpuMatch ? cpuMatch[1].trim() : '',
        ram: ramMatch ? ramMatch[1].trim() : '',
        browser: browserMatch ? browserMatch[1].trim() : '',
      };
    });

    if (deviceInfo && deviceInfo.os) {
      info(chalk.cyan('품질측정 단말정보:'));
      info(`  OS: ${deviceInfo.os}`);
      info(`  CPU: ${deviceInfo.cpu}`);
      info(`  RAM: ${deviceInfo.ram}`);
      info(`  Browser: ${deviceInfo.browser}`);
    }

    // HTML 캡처 저장 (디버그/증거용)
    await this.saveHtmlSnapshot('measurement-start');
  }

  private async waitForCompletion(): Promise<void> {
    const page = this.page!;
    const maxWaitMs = SLA_TEST_TIMEOUT_MS;
    let elapsed = 0;
    let lastReportedRound = 0; // 이미 출력한 라운드 추적

    while (elapsed < maxWaitMs) {
      await sleep(POLL_INTERVAL_MS);
      elapsed += POLL_INTERVAL_MS;

      // 구조화된 CSS 클래스로 회차별 결과를 직접 파싱
      const status = await page.evaluate(() => {
        const ifArea = document.getElementById('ifArea');
        if (!ifArea) return null;

        // 회차별 상세 결과
        const rounds: Array<{ speed: string; slaRef: string; result: string; date: string }> = [];
        for (let i = 1; i <= 5; i++) {
          const speed = ifArea.querySelector(`.step-table-speed-${i}`)?.textContent?.trim() || '';
          const slaRef = ifArea.querySelector(`.step-table-default-${i}`)?.textContent?.trim() || '';
          const resultText = ifArea.querySelector(`.step-table-result-${i}`)?.textContent?.trim() || '';
          const date = ifArea.querySelector(`.step-table-date-${i}`)?.textContent?.trim() || '';
          rounds.push({ speed, slaRef, result: resultText, date });
        }

        const completedRounds = rounds.filter(r => r.speed).length;

        // "측정중" 상태 확인
        const fullText = ifArea.textContent?.replace(/\s+/g, ' ').trim() || '';
        const isMeasuring = fullText.includes('측정중');

        // 카운트다운 타이머
        const countdown = ifArea.querySelector('.delayTimeSec')?.textContent?.trim() || '';

        // 결과 요약 텍스트
        const totalMatch = fullText.match(/테스트\s*횟수\s*(\d+)\s*번/);
        const totalCount = totalMatch ? parseInt(totalMatch[1]) : 0;

        return { rounds, completedRounds, isMeasuring, countdown, totalCount, textSnippet: fullText.slice(0, 200) };
      });

      if (!status) continue;

      if (process.env.DEBUG_POLL) {
        console.log(`\n[DEBUG POLL ${formatElapsed(elapsed)}] rounds=${status.completedRounds} measuring=${status.isMeasuring} countdown=${status.countdown} total=${status.totalCount}`);
        console.log(`  text: ${status.textSnippet}`);
      }

      // 새로 완료된 라운드가 있으면 즉시 결과 출력
      if (status.completedRounds > lastReportedRound) {
        for (let i = lastReportedRound; i < status.completedRounds; i++) {
          const r = status.rounds[i];
          const isFail = r.result.includes('미달');
          const icon = isFail ? '❌' : '✅';
          if (process.stdout.isTTY) console.log(''); // 진행 바 줄바꿈
          info(`${icon} ${i + 1}회차: ${r.speed} (기준 ${r.slaRef}) → ${r.result}  [${r.date}]`);
        }
        lastReportedRound = status.completedRounds;

        // HTML 스냅샷 저장
        await this.saveHtmlSnapshot(`round-${status.completedRounds}`);
      }

      const roundsDone = status.completedRounds || status.totalCount;

      // 완료 조건: 5개 회차의 측정값이 모두 채워짐
      // (페이지가 "측정중" 텍스트를 유지하더라도, 5개 속도값이 있으면 완료)
      if (status.completedRounds >= 5) {
        measureProgress(5, 5, elapsed);
        if (process.stdout.isTTY) console.log('');
        info('5회 측정 완료!');
        await this.saveHtmlSnapshot('complete');
        break;
      } else if (roundsDone > 0) {
        measureProgress(roundsDone, 5, elapsed);
        if (status.countdown) {
          if (process.stdout.isTTY) {
            process.stdout.write(chalk.dim(` 다음: ${status.countdown}`));
          }
        }
      }
    }

    if (elapsed >= maxWaitMs) {
      if (process.stdout.isTTY) console.log('');
      info(chalk.yellow(`⏰ ${Math.round(maxWaitMs / 60000)}분 타임아웃 - 현재 결과로 진행`));
      await this.saveHtmlSnapshot('timeout');
    }
  }

  private async parseResults(): Promise<Partial<SpeedTestResult>> {
    const page = this.page!;
    const result: Partial<SpeedTestResult> = {
      download_mbps: 0,
      upload_mbps: 0,
      ping_ms: 0,
      sla_result: 'unknown',
      raw_data: {},
      error: '',
    };

    try {
      // 구조화된 DOM에서 회차별 데이터를 직접 추출
      const parsed = await page.evaluate(() => {
        const ifArea = document.getElementById('ifArea');
        if (!ifArea) return null;

        // 회차별 결과 파싱 — CSS 클래스 기반
        const rounds: Array<{ speed: string; slaRef: string; result: string; date: string }> = [];
        for (let i = 1; i <= 5; i++) {
          const speed = ifArea.querySelector(`.step-table-speed-${i}`)?.textContent?.trim() || '';
          const slaRef = ifArea.querySelector(`.step-table-default-${i}`)?.textContent?.trim() || '';
          const resultText = ifArea.querySelector(`.step-table-result-${i}`)?.textContent?.trim() || '';
          const date = ifArea.querySelector(`.step-table-date-${i}`)?.textContent?.trim() || '';
          if (speed) {
            rounds.push({ speed, slaRef, result: resultText, date });
          }
        }

        // 요약 텍스트 (display:none이어도 textContent로 접근 가능)
        const fullText = ifArea.textContent?.replace(/\s+/g, ' ').trim() || '';
        const satisfyMatch = fullText.match(/SLA만족\s*횟수는?\s*(\d+)\s*번/);
        const failMatch = fullText.match(/미달\s*횟수는?\s*(\d+)\s*번/);
        const totalMatch = fullText.match(/테스트\s*횟수\s*(\d+)\s*번/);

        return {
          rounds,
          satisfyCount: satisfyMatch ? parseInt(satisfyMatch[1]) : 0,
          failCount: failMatch ? parseInt(failMatch[1]) : 0,
          totalCount: totalMatch ? parseInt(totalMatch[1]) : 0,
          fullText: fullText.slice(0, 500),
        };
      });

      if (!parsed) {
        result.error = 'ifArea 엘리먼트를 찾지 못했습니다';
        return result;
      }

      // 회차별 속도를 평균으로 계산
      const speeds = parsed.rounds
        .map((r) => parseFloat(r.speed))
        .filter((v) => !isNaN(v));

      if (speeds.length > 0) {
        result.download_mbps = speeds.reduce((a, b) => a + b, 0) / speeds.length;
      }

      // SLA 결과 판정
      const { satisfyCount, failCount, totalCount } = parsed;
      if (totalCount > 0) {
        info(`전체 ${totalCount}회: 만족 ${satisfyCount}회, 미달 ${failCount}회`);

        result.raw_data = {
          total: totalCount,
          satisfy: satisfyCount,
          fail: failCount,
          rounds: parsed.rounds,
        };

        // 5회 중 3회 이상 미달이면 SLA fail
        if (failCount >= 3) {
          result.sla_result = 'fail';
        } else {
          result.sla_result = 'pass';
        }
      }

      // 개별 라운드 결과 출력
      for (const round of parsed.rounds) {
        const isFail = round.result.includes('미달');
        const icon = isFail ? '❌' : '✅';
        info(`  ${icon} ${round.speed} (기준: ${round.slaRef}) → ${round.result}`);
      }

      // fallback: 텍스트 기반 판정
      if (result.sla_result === 'unknown') {
        if (parsed.fullText.includes('미달') && /[345]번/.test(parsed.fullText)) {
          result.sla_result = 'fail';
        } else if (parsed.fullText.includes('만족')) {
          result.sla_result = 'pass';
        }
      }
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      info(chalk.red(`결과 파싱 실패: ${err.message}`));
      result.error = err.message;
    }

    return result;
  }

  /**
   * 5회 측정 완료 후 "속도측정 상세이력" 다이얼로그가 자동으로 뜸.
   * 다이얼로그에서:
   * 1. 측정 결과 상세 정보를 CLI에 출력 (증거)
   * 2. 전화번호를 입력 (config.phone)
   * 3. "확인" 버튼 클릭 → 이의신청(품질점검 신청) 완료
   */
  private async fileComplaint(): Promise<boolean> {
    const page = this.page!;

    // 상세이력 다이얼로그가 열릴 때까지 대기
    try {
      await page.waitForSelector('.slaTestResultDetailPopup', { state: 'visible', timeout: 30000 });
    } catch {
      info('상세이력 다이얼로그가 열리지 않았습니다');
      return false;
    }

    await sleep(2000);
    await this.saveHtmlSnapshot('complaint-dialog');

    // 상세이력 정보를 CLI에 출력
    const detail = await page.evaluate(() => {
      const popup = document.querySelector('.slaTestResultDetailPopup');
      if (!popup) return null;

      // 요약 테이블 (test_table type1) 파싱
      const summaryRows = popup.querySelectorAll('.test_table.type1 tr');
      const summary: Record<string, string> = {};
      summaryRows.forEach(row => {
        const th = row.querySelector('th')?.textContent?.trim() || '';
        const td = row.querySelector('td')?.textContent?.trim() || '';
        if (th) summary[th] = td;
      });

      // 회차별 속도 테이블 (test_table type3) 파싱
      const speedRows = popup.querySelectorAll('.test_table.type3 tbody tr');
      const rounds: Array<{ round: string; speed: string }> = [];
      speedRows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 2) {
          rounds.push({
            round: cells[0].textContent?.trim() || '',
            speed: cells[1].textContent?.trim() || '',
          });
        }
      });

      return { summary, rounds };
    });

    if (detail) {
      console.log('');
      info(chalk.cyan('━━━ SLA 테스트 결과 상세 ━━━'));
      info(`  측정일자:    ${detail.summary['측정일자'] || '-'}`);
      info(`  상품명:      ${detail.summary['상품명'] || '-'}`);
      info(`  SLA기준속도: ${detail.summary['SLA기준속도'] || '-'}`);
      info(`  측정횟수:    ${detail.summary['측정횟수'] || '-'}`);
      info(`  미달횟수:    ${detail.summary['미달횟수'] || '-'}`);
      info(`  결과:        ${detail.summary['결 과'] || '-'}`);
      info('');
      info('  회차별 다운로드 속도:');
      for (const r of detail.rounds) {
        info(`    ${r.round}회차: ${r.speed} Mbps`);
      }
      info(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    }

    // 전화번호 입력 — config.phone에서 가져옴
    const phone = this.config.phone || '';
    if (!phone) {
      info(chalk.yellow('전화번호가 설정되지 않아 이의신청을 진행할 수 없습니다.'));
      info(chalk.dim('설정 파일에 phone: "01012345678" 을 추가하세요.'));
      return false;
    }

    // 010-XXXX-XXXX 형태로 파싱
    const digits = phone.replace(/-/g, '');
    const prefix = digits.slice(0, 3);  // 010
    const mid = digits.slice(3, 7);     // 중간 4자리
    const last = digits.slice(7, 11);   // 끝 4자리

    info(`연락처 입력: ${prefix}-${mid}-${last}`);

    // 휴대폰 라디오 선택 (기본이 hp이지만 명시적으로)
    await page.evaluate(() => {
      const hpRadio = document.querySelector('input[type="radio"][value="hp"]') as HTMLInputElement;
      if (hpRadio) {
        const label = hpRadio.closest('label');
        if (label) label.click();
      }
    });

    // 중간번호, 끝번호 입력
    try {
      await page.fill('input[name="telnum2"]', mid);
      await page.fill('input[name="telnum3"]', last);
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      info(chalk.red(`전화번호 입력 실패: ${err.message}`));
      return false;
    }

    await sleep(1000);

    // "확인" 버튼 클릭
    try {
      await page.click('a.sla_popup_detail_confirmCompAction_btn');
      info('품질점검 신청 확인 클릭');
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      info(chalk.red(`확인 버튼 클릭 실패: ${err.message}`));
      return false;
    }

    await sleep(3000);
    await this.saveHtmlSnapshot('complaint-submitted');

    return true;
  }

  async takeScreenshot(filePath = 'screenshot.png'): Promise<void> {
    if (this.page) {
      await this.page.screenshot({ path: filePath });
      console.log(`스크린샷 저장: ${filePath}`);
    }
  }

  /** #ifArea의 HTML을 파일로 저장 — 디버그/증거용 */
  private async saveHtmlSnapshot(label: string): Promise<void> {
    try {
      const snapshotDir = path.join(DATA_DIR, 'snapshots');
      fs.mkdirSync(snapshotDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filePath = path.join(snapshotDir, `${timestamp}_${label}.html`);

      const html = await this.page!.evaluate(() => {
        return document.getElementById('ifArea')?.innerHTML || document.body.innerHTML;
      });

      fs.writeFileSync(filePath, html, 'utf8');
    } catch {
      // 스냅샷 저장 실패는 무시 — 측정 플로우에 영향 없음
    }
  }
}
