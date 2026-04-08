/**
 * CLI 커맨드 정의 - commander 기반
 *
 * Usage:
 *   damn-my-slow-kt init              # 초기 설정 (~/.damn-my-slow-isp/config-kt.yaml)
 *   damn-my-slow-kt run               # 측정 + 감면 신청 (설정에 따라 다회 반복)
 *   damn-my-slow-kt run --once        # 1회만 측정
 *   damn-my-slow-kt run --dry-run     # 측정만 (감면 신청 생략)
 *   damn-my-slow-kt history           # 이력 조회
 *   damn-my-slow-kt report            # 요약 리포트
 *   damn-my-slow-kt schedule install  # 스케줄 등록
 *   damn-my-slow-kt schedule remove   # 스케줄 제거
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import path from 'path';
import { execSync } from 'child_process';
import fs from 'fs';

import {
  loadConfig,
  saveConfig,
  getDefaultConfig,
  DEFAULT_CONFIG_PATH,
  DATA_DIR,
  Config,
} from './config';
import { SpeedDatabase } from './db';
import { KTProvider, SpeedTestResult } from './kt';
import { sendNotifications } from './notify';
import { printHistory, printStats } from './report';
import { installSchedule, removeSchedule, getPlatform } from './scheduler';
import { checkForUpdates } from './updater';
import { checkAndRunMigrations, CURRENT_CONFIG_VERSION } from './migration';

// package.json에서 버전 읽기
const pkg = require('../package.json') as { version: string; name: string };

export function buildCli(): Command {
  const program = new Command();

  program
    .name('damn-my-slow-kt')
    .description('🐌 느린 KT 인터넷? 자동으로 환불받자.')
    .version(pkg.version)
    .option('--no-update-check', '자동 업데이트 체크 비활성화');

  // ─────────────────────────────────────
  // init
  // ─────────────────────────────────────
  program
    .command('init')
    .description('초기 설정: 설정 파일 생성 + 자동 스케줄 설치 여부 질문')
    .option('-c, --config <path>', '설정 파일 경로', DEFAULT_CONFIG_PATH)
    .option('-f, --force', '기존 파일 덮어쓰기', false)
    .action(async (opts: { config: string; force: boolean }) => {
      const configPath = opts.config;

      if (fs.existsSync(configPath) && !opts.force) {
        // 기존 설정 파일이 있으면 마이그레이션 체크 후 종료
        let cfg = loadConfig(configPath);
        cfg = await checkAndRunMigrations(cfg, configPath, { interactive: true });

        if (cfg._config_version >= CURRENT_CONFIG_VERSION) {
          console.log(chalk.green(`✅ 설정이 최신 상태입니다. (v${cfg._config_version})`));
          console.log(chalk.dim(`   ${configPath}`));
          console.log(chalk.dim('\n   새로 설정하려면 --force 옵션을 사용하세요.'));
        }
        return;
      }

      console.log(chalk.cyan('\n🐌 damn-my-slow-kt 초기 설정\n'));
      console.log(chalk.yellow('⚠️  KT SLA 측정은 유선(LAN) 연결에서만 유효합니다.'));
      console.log(chalk.yellow('   Wi-Fi로 측정하면 감면 신청이 거부될 수 있습니다.'));
      console.log('');
      printSpeedAgentInstallGuide();
      console.log(chalk.dim(`\n📋 KT 품질보장제도(SLA) 공식 안내:`));
      console.log(chalk.dim('   https://ermsweb.kt.com/search/faq/faqAnswerM.do?kbId=KNOW0002301063\n'));

      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'id',
          message: 'KT 아이디 (이메일 또는 ID):',
          validate: (v: string) => v.trim() !== '' || '아이디를 입력하세요.',
        },
        {
          type: 'password',
          name: 'password',
          message: 'KT 비밀번호:',
          mask: '*',
          validate: (v: string) => v.trim() !== '' || '비밀번호를 입력하세요.',
        },
        {
          type: 'number',
          name: 'speed_mbps',
          message: '계약 속도 (Mbps):',
          default: 1000,
        },
        {
          type: 'input',
          name: 'discord_webhook',
          message: 'Discord 웹훅 URL (없으면 엔터):',
          default: '',
        },
        {
          type: 'input',
          name: 'telegram_token',
          message: 'Telegram 봇 토큰 (없으면 엔터):',
          default: '',
        },
        {
          type: 'confirm',
          name: 'headless',
          message: '브라우저를 숨김 모드로 실행할까요?',
          default: true,
        },
      ]);

      let telegramChatId = '';
      if (answers.telegram_token) {
        const chatAnswer = await inquirer.prompt([
          {
            type: 'input',
            name: 'chat_id',
            message: 'Telegram 채팅 ID:',
            default: '',
          },
        ]);
        telegramChatId = chatAnswer.chat_id;
      }

      const defaults = getDefaultConfig();
      const cfg: Config = {
        _config_version: defaults._config_version,
        credentials: { id: answers.id, password: answers.password },
        plan: { speed_mbps: answers.speed_mbps },
        schedule: {
          time: '04:00',
          timezone: 'Asia/Seoul',
          max_attempts: defaults.schedule.max_attempts,
          retry_interval_minutes: defaults.schedule.retry_interval_minutes,
          stop_on_complaint_success: defaults.schedule.stop_on_complaint_success,
        },
        notification: {
          discord_webhook: answers.discord_webhook,
          telegram_bot_token: answers.telegram_token,
          telegram_chat_id: telegramChatId,
        },
        headless: answers.headless,
        db_path: defaults.db_path,
      };

      // 설정 파일 저장
      const dir = path.dirname(configPath);
      if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
      saveConfig(cfg, configPath);

      console.log(`\n${chalk.green(`✅ 설정 파일 생성 완료: ${configPath}`)}`);
      console.log(chalk.dim(`주의: ${configPath} 에는 비밀번호가 포함됩니다.`));
      console.log(chalk.dim(`기본 설정: 하루 최대 ${cfg.schedule.max_attempts}회, ${cfg.schedule.retry_interval_minutes}분 간격 측정 (감면 성공 시 중단)`));

      // 자동 스케줄 설치 여부 물어보기
      const platform = getPlatform();
      if (platform !== 'windows' && platform !== 'unknown') {
        const { installSched } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'installSched',
            message: '매일 자동으로 속도 측정을 실행할까요?',
            default: true,
          },
        ]);

        if (installSched) {
          try {
            installSchedule(cfg, configPath);
          } catch (e: unknown) {
            const err = e instanceof Error ? e : new Error(String(e));
            console.log('');
            console.log(chalk.yellow('⚠️  설정 저장은 완료되었으나, 자동 스케줄 등록에 실패했습니다.'));
            console.log(chalk.dim(`   원인: ${err.message}`));
            console.log('');
            console.log('   수동으로 실행하려면:');
            console.log(chalk.bold(`     npx --yes damn-my-slow-kt run --config ${configPath}`));
            console.log('');
            console.log('   스케줄을 다시 등록하려면:');
            console.log(chalk.bold(`     npx --yes damn-my-slow-kt schedule install --config ${configPath}`));
          }
        }
      } else if (platform === 'windows') {
        console.log('\nWindows에서는 작업 스케줄러를 수동으로 설정하세요:');
        console.log(`  npx damn-my-slow-kt schedule install --config ${configPath}`);
      }

      console.log(chalk.dim('\n지금 테스트하려면 실행해보세요:'));
      console.log(chalk.bold('  npx damn-my-slow-kt run'));

      await askForStar();
    });

  // ─────────────────────────────────────
  // run - 1회 측정 후 종료. cron/launchd가 다회 트리거.
  // 매 실행 시 오늘 이미 감면 성공했는지 DB에서 확인.
  // ─────────────────────────────────────
  program
    .command('run')
    .description('1회 측정 + 감면 신청 (스케줄러가 다회 트리거)')
    .option('-c, --config <path>', '설정 파일 경로', DEFAULT_CONFIG_PATH)
    .option('--dry-run', '측정만 하고 감면 신청 생략', false)
    .option('--force', '오늘 완료 여부 무시하고 강제 실행', false)
    .option('-v, --verbose', '상세 로그 출력', false)
    .option('--screenshot', '측정 완료 후 스크린샷 저장', false)
    .action(async (opts: { config: string; dryRun: boolean; force: boolean; verbose: boolean; screenshot: boolean }) => {
      // 업데이트 체크
      const noUpdateCheck = program.opts().noUpdateCheck as boolean | undefined;
      await checkForUpdates(pkg.version, { noUpdateCheck });

      let cfg: Config;
      try {
        cfg = loadConfig(opts.config);
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        console.error(chalk.red(`❌ ${err.message}`));
        process.exit(1);
      }

      // 마이그레이션 체크 (업데이트 후 설정 변경 안내)
      cfg = await checkAndRunMigrations(cfg, opts.config);

      if (!cfg.credentials.id || !cfg.credentials.password) {
        console.error(chalk.red('❌ KT 계정 정보가 설정되지 않았습니다.'));
        console.error(`${opts.config}에서 credentials.id와 credentials.password를 설정하세요.`);
        process.exit(1);
      }

      // ── 오늘 상태 체크 ──
      const db = new SpeedDatabase(cfg.db_path);
      const todayRecords = db.getTodayRecords(cfg.schedule.timezone);
      const todayCount = todayRecords.length;
      const maxAttempts = cfg.schedule.max_attempts || 10;
      const alreadySucceeded = db.hasTodayComplaintSuccess(cfg.schedule.timezone);
      const isInteractive = process.stdout.isTTY === true;

      if (!opts.force) {
        // 오늘 감면 성공 완료
        if (alreadySucceeded && cfg.schedule.stop_on_complaint_success !== false) {
          if (isInteractive) {
            console.log(chalk.green(`\n✅ 오늘 이미 감면 신청에 성공했습니다. (${todayCount}회 측정)`));
            const { proceed } = await inquirer.prompt([{
              type: 'confirm',
              name: 'proceed',
              message: '그래도 추가 측정하시겠습니까?',
              default: false,
            }]);
            if (!proceed) {
              db.close();
              return;
            }
          } else {
            // non-interactive (cron/launchd): 스킵 + --force 안내
            console.log(`[skip] 오늘 감면 성공 완료 (${todayCount}회 측정). 스킵합니다.`);
            console.log(`       강제 실행하려면: npx damn-my-slow-kt run --force`);
            db.close();
            return;
          }
        }

        // 오늘 최대 횟수 도달
        if (todayCount >= maxAttempts) {
          if (isInteractive) {
            console.log(chalk.yellow(`\n⚠️  오늘 이미 ${todayCount}회 측정했습니다. (최대 ${maxAttempts}회)`));
            const { proceed } = await inquirer.prompt([{
              type: 'confirm',
              name: 'proceed',
              message: '최대 횟수를 초과하여 추가 측정하시겠습니까?',
              default: false,
            }]);
            if (!proceed) {
              db.close();
              return;
            }
          } else {
            console.log(`[skip] 오늘 ${todayCount}/${maxAttempts}회 완료. 스킵합니다.`);
            console.log(`       강제 실행하려면: npx damn-my-slow-kt run --force`);
            db.close();
            return;
          }
        }
      }

      // ── 측정 실행 ──
      console.log(chalk.cyan('\n🐌 damn-my-slow-kt 실행'));
      console.log(`KT | ${opts.dryRun ? 'dry-run 모드' : '감면 신청 활성화'}`);
      console.log(chalk.dim('유선(LAN) 연결 확인 필수 — Wi-Fi 측정은 SLA 인정 불가'));
      if (isInteractive) {
        printSpeedAgentInstallGuide();
      }
      if (todayCount > 0) {
        console.log(chalk.dim(`오늘 ${todayCount + 1}번째 측정 (최대 ${maxAttempts}회)`));
      }
      console.log('');

      const provider = new KTProvider(cfg);
      const measuredAt = new Date().toISOString();

      console.log(`측정 시작: ${measuredAt.slice(0, 19)}`);
      if (!cfg.headless) {
        console.log(chalk.dim('브라우저 창이 열립니다 (headless=false)'));
      }

      const result: SpeedTestResult = await provider.run(opts.dryRun);

      const record = {
        isp: 'kt',
        measured_at: measuredAt,
        download_mbps: result.download_mbps,
        upload_mbps: result.upload_mbps,
        ping_ms: result.ping_ms,
        sla_result: result.sla_result,
        complaint_filed: result.complaint_filed,
        complaint_result: result.complaint_result,
        raw_data: JSON.stringify(result.raw_data),
        error: result.error,
      };

      db.save(record);
      db.close();

      printRunResult(record, cfg.plan.speed_mbps);
      await sendNotifications(cfg, record);

      if (result.complaint_result === 'success') {
        console.log(chalk.green('\n🎉 감면 신청 성공! 다음 스케줄 실행 시 자동으로 스킵됩니다.'));
      }

      if (result.error) {
        console.error(`\n${chalk.red(`⚠️  오류 발생: ${result.error}`)}`);
        process.exit(1);
      }

    });

  // ─────────────────────────────────────
  // config show
  // ─────────────────────────────────────
  const configCmd = program.command('config').description('설정 관리');

  configCmd
    .command('show')
    .description('현재 설정 확인')
    .option('-c, --config <path>', '설정 파일 경로', DEFAULT_CONFIG_PATH)
    .action((opts: { config: string }) => {
      let cfg: Config;
      try {
        cfg = loadConfig(opts.config);
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        console.error(chalk.red(err.message));
        process.exit(1);
      }

      console.log(chalk.cyan('\n⚙️  현재 설정 (KT)\n'));
      console.log(`설정 버전: v${cfg._config_version}`);
      console.log(`계정 ID: ${cfg.credentials.id}`);
      console.log(`비밀번호: ${'*'.repeat(cfg.credentials.password.length)}`);
      console.log(`계약 속도: ${cfg.plan.speed_mbps} Mbps`);
      console.log(`첫 측정: ${cfg.schedule.time} (${cfg.schedule.timezone})`);
      console.log(`최대 측정: ${cfg.schedule.max_attempts}회/일 | ${cfg.schedule.retry_interval_minutes}분 간격`);
      console.log(`감면 성공 시: ${cfg.schedule.stop_on_complaint_success ? '중단' : '계속 측정'}`);
      console.log(`Discord 웹훅: ${cfg.notification.discord_webhook ? '설정됨' : '없음'}`);
      console.log(`Telegram: ${cfg.notification.telegram_bot_token ? '설정됨' : '없음'}`);
      console.log(`Headless 모드: ${cfg.headless}`);
      console.log(`DB 경로: ${cfg.db_path}`);
    });

  // ─────────────────────────────────────
  // history
  // ─────────────────────────────────────
  program
    .command('history')
    .description('측정 이력 조회')
    .option('-c, --config <path>', '설정 파일 경로', DEFAULT_CONFIG_PATH)
    .option('-n, --limit <number>', '표시할 이력 수', '20')
    .option('-m, --month <YYYY-MM>', '월 필터')
    .action((opts: { config: string; limit: string; month?: string }) => {
      let cfg: Config;
      try {
        cfg = loadConfig(opts.config);
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        console.error(chalk.red(err.message));
        process.exit(1);
      }

      const db = new SpeedDatabase(cfg.db_path);
      const records = db.getHistory(parseInt(opts.limit) || 20, opts.month);
      db.close();
      printHistory(records);
    });

  // ─────────────────────────────────────
  // report
  // ─────────────────────────────────────
  program
    .command('report')
    .description('요약 리포트')
    .option('-c, --config <path>', '설정 파일 경로', DEFAULT_CONFIG_PATH)
    .option('-m, --month <YYYY-MM>', '월 필터')
    .action((opts: { config: string; month?: string }) => {
      let cfg: Config;
      try {
        cfg = loadConfig(opts.config);
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        console.error(chalk.red(err.message));
        process.exit(1);
      }

      const db = new SpeedDatabase(cfg.db_path);
      const stats = db.getStats(opts.month);
      db.close();
      printStats(stats);
    });

  // ─────────────────────────────────────
  // schedule
  // ─────────────────────────────────────
  const schedCmd = program.command('schedule').description('자동 실행 스케줄 관리');

  schedCmd
    .command('install')
    .description('자동 실행 스케줄 등록')
    .option('-c, --config <path>', '설정 파일 경로', DEFAULT_CONFIG_PATH)
    .action((opts: { config: string }) => {
      let cfg: Config;
      try {
        cfg = loadConfig(opts.config);
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        console.error(chalk.red(err.message));
        process.exit(1);
      }

      try {
        installSchedule(cfg, opts.config);
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        console.error(chalk.red(`❌ 스케줄 설치 실패: ${err.message}`));
        process.exit(1);
      }
    });

  schedCmd
    .command('remove')
    .description('자동 실행 스케줄 제거')
    .action(() => {
      try {
        removeSchedule();
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        console.error(chalk.red(`❌ 스케줄 제거 실패: ${err.message}`));
        process.exit(1);
      }
    });

  return program;
}

// ─── 속도 바 시각화 ─────────────────────────────────────────────

/** 터미널 너비에 맞춘 속도 게이지 바 */
function speedBar(mbps: number, maxMbps: number, width = 30): string {
  const ratio = Math.min(mbps / maxMbps, 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;

  // 속도 비율에 따른 색상: <30% 빨강, <50% 노랑, >=50% 초록
  const colorFn = ratio < 0.3 ? chalk.red : ratio < 0.5 ? chalk.yellow : chalk.green;
  const bar = colorFn('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
  const pct = `${(ratio * 100).toFixed(0)}%`;

  return `${bar} ${chalk.bold(`${mbps.toFixed(1)}`)} Mbps ${chalk.dim(`(${pct})`)}`;
}

function printRunResult(record: {
  sla_result: string;
  download_mbps: number;
  upload_mbps: number;
  ping_ms: number;
  complaint_filed: boolean;
  complaint_result: string;
}, contractSpeed = 1000): void {
  const isFail = record.sla_result === 'fail';
  const isPass = record.sla_result === 'pass';

  // 상단 구분선
  const headerColor = isFail ? chalk.red : isPass ? chalk.green : chalk.yellow;
  const headerIcon = isFail ? '❌' : isPass ? '✅' : '⚠️';
  const headerText = isFail ? 'SLA 미달' : isPass ? 'SLA 통과' : 'SLA 불명';

  console.log('');
  console.log(headerColor(`  ┌${'─'.repeat(46)}┐`));
  console.log(headerColor(`  │`) + `  ${headerIcon}  ${chalk.bold(headerText)}` + ' '.repeat(46 - headerText.length * 2 - 6) + headerColor('│'));
  console.log(headerColor(`  ├${'─'.repeat(46)}┤`));

  // 속도 게이지
  console.log(headerColor('  │') + `  ⬇ 다운로드  ${speedBar(record.download_mbps, contractSpeed, 20)}` + headerColor('  │'));
  console.log(headerColor('  │') + `  ⬆ 업로드    ${speedBar(record.upload_mbps, contractSpeed, 20)}` + headerColor('  │'));
  console.log(headerColor('  │') + `  ⏱ Ping      ${chalk.bold(record.ping_ms.toFixed(0))} ms` + ' '.repeat(Math.max(0, 31 - record.ping_ms.toFixed(0).length)) + headerColor('│'));

  // 이의신청 결과
  if (record.complaint_filed || (isFail && record.complaint_result === 'skipped')) {
    console.log(headerColor(`  ├${'─'.repeat(46)}┤`));

    if (record.complaint_result === 'success') {
      console.log(headerColor('  │') + chalk.green('  🎉 감면 신청 성공!') + ' '.repeat(27) + headerColor('│'));
    } else if (record.complaint_result === 'failed') {
      console.log(headerColor('  │') + chalk.red('  ⚠️  감면 신청 실패') + ' '.repeat(27) + headerColor('│'));
    } else if (record.complaint_result === 'skipped') {
      console.log(headerColor('  │') + chalk.dim('  📋 감면 신청 생략 (dry-run)') + ' '.repeat(19) + headerColor('│'));
    }
  }

  console.log(headerColor(`  └${'─'.repeat(46)}┘`));
}

// ─── KT 속도측정 프로그램 설치 안내 ────────────────────────────────

/**
 * KT SLA 측정을 위해 speed.kt.com의 속도측정 에이전트 설치가 필요.
 * macOS: ktspeed.pkg, Windows: 사이트에서 직접 설치.
 */
function printSpeedAgentInstallGuide(): void {
  const platform = process.platform;

  console.log(chalk.yellow('\n📦 KT 속도측정 프로그램 사전 설치 필요'));
  if (platform === 'darwin') {
    console.log(chalk.dim('   macOS: 아래 링크에서 프로그램을 설치하세요 (최초 1회)'));
    console.log(chalk.bold('   https://speed.kt.com/file/ktspeed.pkg'));
  } else if (platform === 'win32') {
    console.log(chalk.dim('   Windows: 아래 절차를 따라 설치하세요 (최초 1회)'));
    console.log(chalk.dim('   1. https://speed.kt.com 접속'));
    console.log(chalk.dim('   2. 속도측정 → 품질보증(SLA) 테스트 클릭'));
    console.log(chalk.dim('   3. 안내에 따라 속도측정 프로그램 설치'));
  } else {
    // Linux/Docker — 별도 에이전트 불필요 (브라우저 기반 측정)
    console.log(chalk.dim('   Linux: 별도 설치 없이 브라우저 기반으로 측정됩니다.'));
  }
  console.log('');
}

// ─── GitHub Star 요청 ─────────────────────────────────────────────

const STAR_FLAG_FILE = path.join(DATA_DIR, '.star-asked');
const REPO = 'kargnas/damn-my-slow-kt';

/**
 * 첫 실행 시 한 번만 GitHub 스타 여부를 물어본다.
 * gh CLI가 없거나 non-interactive면 조용히 스킵.
 */
async function askForStar(): Promise<void> {
  // interactive가 아니면 스킵
  if (!process.stdout.isTTY) return;

  // 이미 물어본 적 있으면 스킵
  if (fs.existsSync(STAR_FLAG_FILE)) return;

  // 플래그 먼저 기록 (다시 묻지 않기 위해)
  try {
    fs.mkdirSync(path.dirname(STAR_FLAG_FILE), { recursive: true });
    fs.writeFileSync(STAR_FLAG_FILE, new Date().toISOString(), 'utf8');
  } catch {
    return;
  }

  // gh CLI 존재 확인
  try {
    execSync('which gh 2>/dev/null', { stdio: 'ignore' });
  } catch {
    return;
  }

  console.log('');
  const { star } = await inquirer.prompt([{
    type: 'confirm',
    name: 'star',
    message: `도움이 됐다면 GitHub에 ⭐ 하나 남겨주시겠어요? (${REPO})`,
    default: true,
  }]);

  if (star) {
    try {
      execSync(`gh repo edit ${REPO} --star 2>/dev/null`, { stdio: 'ignore' });
      console.log(chalk.green('⭐ 감사합니다!'));
    } catch {
      // gh api로 fallback
      try {
        execSync(`gh api -X PUT /user/starred/${REPO} 2>/dev/null`, { stdio: 'ignore' });
        console.log(chalk.green('⭐ 감사합니다!'));
      } catch {
        console.log(chalk.dim(`직접 스타해주세요: https://github.com/${REPO}`));
      }
    }
  }
}
