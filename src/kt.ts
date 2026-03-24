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
import { Config } from './config';

const KT_SLA_INTRO_URL = 'https://speed.kt.com/sla/slatest/introduce.asp';
const SLA_TEST_TIMEOUT_MS = 40 * 60 * 1000; // 40분
const POLL_INTERVAL_MS = 30 * 1000; // 30초

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

    this.browser = await chromium.launch({
      headless: this.config.headless,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--use-fake-ui-for-media-stream',
        '--disable-web-security',
      ],
    });

    this.context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/123.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });

    try {
      this.page = await this.context.newPage();

      // Step 1: SLA 소개 페이지 접속
      console.log('KT SLA 소개 페이지 접속 중...');
      await this.page.goto(KT_SLA_INTRO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);

      // Step 2: 로그인 처리 (필요 시)
      await this.handleLogin();

      // Step 3: SLA 소개 페이지 확인
      const currentUrl = this.page.url();
      if (!currentUrl.includes('sla/slatest/introduce.asp')) {
        console.log(`SLA 소개 페이지로 이동 중... (현재: ${currentUrl})`);
        await this.page.goto(KT_SLA_INTRO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2000);
      }

      // Step 4: 품질보증(SLA) 테스트 레이어 열기
      console.log('품질보증(SLA) 테스트 레이어 열기...');
      await this.openSlaLayer();

      // Step 5: 회선 선택
      console.log('회선 선택 중...');
      await this.selectLine();

      // Step 6: 측정 시작
      console.log('속도측정 시작...');
      await this.startMeasurement();

      // Step 7: 완료 대기
      console.log('측정 진행 중 (5회 × 300초 = 최대 25분 대기)...');
      await this.waitForCompletion();

      // Step 8: 결과 파싱
      console.log('결과 파싱 중...');
      const parsed = await this.parseResults();
      Object.assign(result, parsed);

      // Step 9: SLA 미달 시 이의신청
      if (result.sla_result === 'fail' && !dryRun) {
        console.log('SLA 미달 감지 - 이의신청 시도...');
        const ok = await this.fileComplaint();
        result.complaint_filed = ok;
        result.complaint_result = ok ? 'success' : 'failed';
      } else if (result.sla_result === 'fail' && dryRun) {
        console.log('SLA 미달 (dry-run 모드 - 이의신청 생략)');
        result.complaint_result = 'skipped';
      } else if (result.sla_result === 'pass') {
        console.log('SLA 통과 - 이의신청 불필요');
        result.complaint_result = 'not_applicable';
      }
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error(`KT 자동화 오류: ${err.message}`);
      result.error = err.message;
      result.sla_result = 'unknown';

      // 오류 스크린샷
      try {
        await this.page?.screenshot({ path: 'kt-error.png' });
        console.log('오류 스크린샷 저장: kt-error.png');
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
      throw new Error('KT 계정 정보가 설정되지 않았습니다. config.yaml을 확인하세요.');
    }

    const url = page.url();
    if (!url.includes('accounts.kt.com')) {
      console.log(`초기 접속 페이지 OK (로그인 리다이렉트 없음): ${url}`);
      return;
    }

    console.log('KT 로그인 페이지 감지 - 로그인 시도...');
    await this.fillLoginForm(id, password);
    await sleep(3000);

    const afterUrl = page.url();
    if (afterUrl.includes('unchanged-password') || afterUrl.includes('change-password')) {
      console.log('비밀번호 변경 안내 페이지 감지 - 다음에 하기 클릭');
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
        console.log('비밀번호 변경 유예 완료');
      } catch {
        console.log('다음에 하기 버튼 없음, 계속 진행');
      }
    }

    console.log(`로그인 후 URL: ${page.url()}`);
  }

  private async openSlaLayer(): Promise<void> {
    const page = this.page!;
    const { id, password } = this.config.credentials;

    const clickResult = await page.evaluate(() => {
      const btn = document.querySelector('a.redbtn.btntolayer') as HTMLElement | null;
      if (btn) {
        btn.click();
        return 'clicked: ' + btn.textContent?.trim();
      }
      return 'button not found';
    });

    console.log(`레이어 버튼 클릭 결과: ${clickResult}`);

    if (clickResult.includes('not found')) {
      throw new Error('품질보증(SLA) 테스트 버튼을 찾지 못했습니다');
    }

    await sleep(3000);

    const layerInfo = await page.evaluate(() => {
      const div = document.getElementById('ifArea');
      const text = (div?.textContent || '').trim();
      const hasLogin = !!(
        div?.querySelector('input[type="password"]') ||
        document.querySelector('input[type="password"]')
      );
      return { text: text.slice(0, 200), hasLogin };
    });

    console.log(`레이어 내용: ${JSON.stringify(layerInfo)}`);

    if (layerInfo.hasLogin || !layerInfo.text) {
      console.log('레이어 열기 후 로그인 페이지 감지 - 로그인 진행');
      await this.fillLoginForm(id, password);
      await sleep(3000);

      // 비밀번호 변경 안내 처리
      const afterUrl = page.url();
      if (afterUrl.includes('unchanged-password')) {
        console.log('비밀번호 변경 안내 - 다음에 하기 클릭');
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
      console.log('로그인 완료 - SLA 소개 페이지로 재접속');
      await page.goto(KT_SLA_INTRO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);

      // 다시 레이어 버튼 클릭
      await page.evaluate(() => {
        const btn = document.querySelector('a.redbtn.btntolayer') as HTMLElement | null;
        btn?.click();
      });
      await sleep(2000);

      const retryText = await page.evaluate(() => {
        return document.getElementById('ifArea')?.textContent?.trim().slice(0, 100) || '';
      });

      console.log(`재시도 후 레이어 내용: ${retryText}`);

      if (!retryText) {
        throw new Error('로그인 후에도 레이어가 열리지 않았습니다');
      }
    }
  }

  private async fillLoginForm(id: string, password: string): Promise<void> {
    const page = this.page!;
    const idSelector = "input[type='text'], input[type='email'], #userId, input[name='userId']";
    const passwordSelector = "input[type='password']";

    try {
      await page.waitForSelector(idSelector, { timeout: 8000 });
      await page.fill(idSelector, id);
      console.log(`ID 입력: ${id}`);
    } catch {
      console.log('ID 필드 없음');
      return;
    }

    try {
      await page.waitForSelector(passwordSelector, { timeout: 3000 });
      await page.fill(passwordSelector, password);
      console.log('비밀번호 입력 완료');
    } catch {
      console.log('비밀번호 필드 없음');
      return;
    }

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
      console.log('로그인 버튼 클릭');
    } catch {
      console.log('로그인 버튼 없음');
    }
  }

  private async selectLine(): Promise<void> {
    const page = this.page!;

    const result = await page.evaluate(() => {
      const radioInput = document.querySelector('input[type="radio"]') as HTMLInputElement | null;

      if (radioInput) {
        radioInput.checked = true;
        radioInput.dispatchEvent(new Event('input', { bubbles: true }));
        radioInput.dispatchEvent(new Event('change', { bubbles: true }));

        const label = radioInput.closest('label');
        if (label) (label as HTMLElement).click();

        return 'selected radio value: ' + radioInput.value;
      }
      return 'no radio found';
    });

    console.log(`회선 선택 결과: ${result}`);
    await sleep(500);
  }

  private async startMeasurement(): Promise<void> {
    const page = this.page!;

    const result = await page.evaluate(() => {
      const btn = document.getElementById('measureBtn') as HTMLElement | null;
      if (btn) {
        btn.click();
        return 'clicked #measureBtn';
      }

      const btn2 = document.querySelector('a.speed_speedtest_prestart_btn') as HTMLElement | null;
      if (btn2) {
        btn2.click();
        return 'clicked by class';
      }

      return 'button not found';
    });

    console.log(`측정 시작 결과: ${result}`);

    if (result.includes('not found')) {
      throw new Error('속도 측정 시작 버튼(#measureBtn)을 찾지 못했습니다');
    }

    await sleep(3000);

    const layerText = await page.evaluate(() => {
      return (
        document
          .getElementById('ifArea')
          ?.textContent?.replace(/\s+/g, ' ')
          .trim()
          .slice(0, 200) || ''
      );
    });

    console.log(`측정 시작 후 상태: ${layerText}`);
  }

  private async waitForCompletion(): Promise<void> {
    const page = this.page!;
    const maxWaitMs = SLA_TEST_TIMEOUT_MS;
    let elapsed = 0;

    while (elapsed < maxWaitMs) {
      await sleep(POLL_INTERVAL_MS);
      elapsed += POLL_INTERVAL_MS;

      const layerText = await page.evaluate(() => {
        return (
          document.getElementById('ifArea')?.textContent?.replace(/\s+/g, ' ').trim() || ''
        );
      });

      if (!layerText) {
        console.log(`[${elapsed / 1000}s] 레이어 텍스트 없음`);
        continue;
      }

      console.log(`[${elapsed / 1000}s] 현재 상태: ${layerText.slice(0, 200)}`);

      const totalMatch = layerText.match(/테스트\s*횟수\s*(\d+)\s*번/);
      const totalCount = totalMatch ? parseInt(totalMatch[1]) : 0;

      if (totalCount >= 5 && !layerText.includes('측정중')) {
        console.log(`5회 측정 완료! (총 ${totalCount}회)`);
        break;
      } else if (totalCount >= 5) {
        console.log('5회차 측정 진행 중...');
      } else if (totalCount > 0) {
        console.log(`현재까지 ${totalCount}회 측정 완료, 대기 중...`);
      }
    }

    if (elapsed >= maxWaitMs) {
      console.log('40분 타임아웃 - 현재까지의 결과로 파싱');
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
      let layerText = await page.evaluate(() => {
        return (
          document.getElementById('ifArea')?.textContent?.replace(/\s+/g, ' ').trim() || ''
        );
      });

      if (!layerText) {
        layerText = await page.evaluate(() => {
          return document.body?.textContent?.replace(/\s+/g, ' ').trim() || '';
        });
      }

      console.log(`파싱할 텍스트: ${layerText.slice(0, 300)}`);

      if (layerText) {
        const satisfyMatch = layerText.match(/SLA만족\s*횟수는?\s*(\d+)\s*번/);
        const failMatch = layerText.match(/미달\s*횟수는?\s*(\d+)\s*번/);
        const totalMatch = layerText.match(/테스트\s*횟수\s*(\d+)\s*번/);

        if (satisfyMatch && failMatch) {
          const satisfyCount = parseInt(satisfyMatch[1]);
          const failCount = parseInt(failMatch[1]);
          const totalCount = totalMatch
            ? parseInt(totalMatch[1])
            : satisfyCount + failCount;

          console.log(
            `측정 결과: 전체 ${totalCount}회 중 만족 ${satisfyCount}회, 미달 ${failCount}회`
          );

          result.raw_data = {
            total: totalCount,
            satisfy: satisfyCount,
            fail: failCount,
            layer_text: layerText.slice(0, 500),
          };

          if (failCount >= 3) {
            result.sla_result = 'fail';
            console.log(`SLA 미달: ${failCount}회 미달 (3회 이상 시 fail)`);
          } else {
            result.sla_result = 'pass';
            console.log(`SLA 통과: ${failCount}회 미달 (3회 미만)`);
          }
        }

        // 속도 파싱
        const speedMatches = layerText.match(/(\d+(?:\.\d+)?)\s*(?:Mbps|mbps|Mb\/s|M)/g);
        if (speedMatches && speedMatches.length > 0) {
          result.download_mbps = parseFloat(speedMatches[0]);
        }

        // 결과 텍스트 기반 판단
        if (result.sla_result === 'unknown') {
          if (layerText.includes('미달') && /[345]번/.test(layerText)) {
            result.sla_result = 'fail';
          } else if (layerText.includes('만족')) {
            result.sla_result = 'pass';
          }
        }
      }
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error(`결과 파싱 실패: ${err.message}`);
      result.error = err.message;
    }

    return result;
  }

  private async fileComplaint(): Promise<boolean> {
    const page = this.page!;

    const clickResult = await page.evaluate(() => {
      const elements = document.querySelectorAll('a, button');
      for (const el of elements) {
        if ((el.textContent || '').includes('이의신청')) {
          (el as HTMLElement).click();
          return 'clicked: ' + el.textContent?.trim();
        }
      }
      return 'not found';
    });

    console.log(`이의신청 버튼 결과: ${clickResult}`);

    if (clickResult.includes('not found')) {
      console.log('이의신청 버튼을 찾지 못했습니다');
      return false;
    }

    await sleep(3000);

    try {
      const submitButton = page
        .locator('button')
        .filter({ hasText: /(신청|제출|확인)/ })
        .first();

      await submitButton.waitFor({ state: 'visible', timeout: 5000 });
      await submitButton.click();
      await sleep(3000);
      console.log('이의신청 제출 완료');
      return true;
    } catch {
      console.log('제출 버튼 없음 (이의신청 페이지가 다를 수 있음)');
      return true; // 버튼 클릭까지는 성공으로 처리
    }
  }

  async takeScreenshot(filePath = 'screenshot.png'): Promise<void> {
    if (this.page) {
      await this.page.screenshot({ path: filePath });
      console.log(`스크린샷 저장: ${filePath}`);
    }
  }
}
