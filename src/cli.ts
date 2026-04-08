/**
 * CLI 커맨드 정의 - commander 기반
 *
 * Usage:
 *   damn-my-slow-kt init              # config.yaml 생성 + 스케줄 설치 여부 질문
 *   damn-my-slow-kt run               # 1회 측정 + 감면 신청
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
import fs from 'fs';
import os from 'os';

import {
  loadConfig,
  saveConfig,
  getDefaultConfig,
  DEFAULT_CONFIG_PATH,
  Config,
} from './config';
import { SpeedDatabase } from './db';
import { KTProvider, SpeedTestResult } from './kt';
import { sendNotifications } from './notify';
import { printHistory, printStats } from './report';
import { installSchedule, removeSchedule, getPlatform } from './scheduler';
import { checkForUpdates } from './updater';

// package.json에서 버전 읽기
// eslint-disable-next-line @typescript-eslint/no-var-requires
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
        console.log(chalk.yellow(`⚠️  ${configPath} 파일이 이미 존재합니다.`));
        console.log('덮어쓰려면 --force 옵션을 사용하세요.');
        process.exit(1);
      }

      console.log(chalk.cyan('\n🐌 damn-my-slow-kt 초기 설정\n'));

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
          type: 'input',
          name: 'plan_name',
          message: '요금제 이름 (예: 기가라이트):',
          default: '기가라이트',
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

      const cfg: Config = {
        credentials: { id: answers.id, password: answers.password },
        plan: { name: answers.plan_name, speed_mbps: answers.speed_mbps },
        schedule: { time: '04:00', timezone: 'Asia/Seoul' },
        notification: {
          discord_webhook: answers.discord_webhook,
          telegram_bot_token: answers.telegram_token,
          telegram_chat_id: telegramChatId,
        },
        headless: answers.headless,
        db_path: getDefaultConfig().db_path,
      };

      // 설정 파일 저장
      const dir = path.dirname(configPath);
      if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
      saveConfig(cfg, configPath);

      console.log(`\n${chalk.green(`✅ 설정 파일 생성 완료: ${configPath}`)}`);
      console.log(
        chalk.dim(`주의: ${configPath} 에는 비밀번호가 포함됩니다.`)
      );

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
          const { schedTime } = await inquirer.prompt([
            {
              type: 'list',
              name: 'schedTime',
              message: '측정 시간을 선택하세요:',
              choices: [
                { name: '04:00 (새벽 4시 - 권장)', value: '04:00' },
                { name: '02:00 (새벽 2시)', value: '02:00' },
                { name: '03:00 (새벽 3시)', value: '03:00' },
                { name: '사용자 지정', value: 'custom' },
              ],
              default: '04:00',
            },
          ]);

          let finalTime = schedTime;
          if (schedTime === 'custom') {
            const { customTime } = await inquirer.prompt([
              {
                type: 'input',
                name: 'customTime',
                message: '시간 입력 (HH:MM):',
                default: '04:00',
                validate: (v: string) =>
                  /^\d{2}:\d{2}$/.test(v) || 'HH:MM 형식으로 입력하세요.',
              },
            ]);
            finalTime = customTime;
          }

          cfg.schedule.time = finalTime;
          saveConfig(cfg, configPath);

          try {
            installSchedule(cfg);
          } catch (e: unknown) {
            const err = e instanceof Error ? e : new Error(String(e));
            console.error(chalk.red(`스케줄 설치 실패: ${err.message}`));
          }
        }
      } else if (platform === 'windows') {
        console.log('\nWindows에서는 작업 스케줄러를 수동으로 설정하세요:');
        console.log(`  npx damn-my-slow-kt schedule install`);
      }

      console.log('\n이제 실행하세요:');
      console.log(chalk.bold('  npx damn-my-slow-kt run'));
      console.log(chalk.gray('\n  또는 글로벌 설치 후 직접 실행:'));
      console.log(chalk.gray('  npm install -g damn-my-slow-kt && damn-my-slow-kt run'));
    });

  // ─────────────────────────────────────
  // run
  // ─────────────────────────────────────
  program
    .command('run')
    .description('1회 측정 + 감면 신청 실행')
    .option('-c, --config <path>', '설정 파일 경로', DEFAULT_CONFIG_PATH)
    .option('--dry-run', '측정만 하고 감면 신청 생략', false)
    .option('-v, --verbose', '상세 로그 출력', false)
    .option('--screenshot', '측정 완료 후 스크린샷 저장', false)
    .action(async (opts: { config: string; dryRun: boolean; verbose: boolean; screenshot: boolean }) => {
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

      if (!cfg.credentials.id || !cfg.credentials.password) {
        console.error(chalk.red('❌ KT 계정 정보가 설정되지 않았습니다.'));
        console.error(`${opts.config}에서 credentials.id와 credentials.password를 설정하세요.`);
        process.exit(1);
      }

      console.log(chalk.cyan('\n🐌 damn-my-slow-kt 실행'));
      console.log(`KT | ${opts.dryRun ? 'dry-run 모드' : '감면 신청 활성화'}\n`);

      const provider = new KTProvider(cfg);
      const db = new SpeedDatabase(cfg.db_path);
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

      printRunResult(record);

      await sendNotifications(cfg, record);

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
      console.log(`계정 ID: ${cfg.credentials.id}`);
      console.log(`비밀번호: ${'*'.repeat(cfg.credentials.password.length)}`);
      console.log(`요금제: ${cfg.plan.name} (${cfg.plan.speed_mbps} Mbps)`);
      console.log(`측정 시간: ${cfg.schedule.time} (${cfg.schedule.timezone})`);
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
        installSchedule(cfg);
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

function printRunResult(record: {
  sla_result: string;
  download_mbps: number;
  upload_mbps: number;
  ping_ms: number;
  complaint_filed: boolean;
  complaint_result: string;
}): void {
  const slaColor =
    record.sla_result === 'pass'
      ? chalk.green
      : record.sla_result === 'fail'
      ? chalk.red
      : chalk.yellow;
  const slaIcon =
    record.sla_result === 'pass' ? '✅' : record.sla_result === 'fail' ? '❌' : '⚠️';

  console.log('\n' + chalk.bold('측정 결과:'));
  console.log(`  ⬇️  다운로드: ${chalk.bold(`${record.download_mbps.toFixed(1)} Mbps`)}`);
  console.log(`  ⬆️  업로드:   ${chalk.bold(`${record.upload_mbps.toFixed(1)} Mbps`)}`);
  console.log(`  🏓 Ping:     ${record.ping_ms.toFixed(0)} ms`);
  console.log(`  ${slaIcon}  SLA:      ${slaColor(record.sla_result.toUpperCase())}`);

  if (record.complaint_filed) {
    const resultColor =
      record.complaint_result === 'success' ? chalk.green : chalk.red;
    console.log(`  🔔 이의신청: ${resultColor(record.complaint_result)}`);
  } else if (record.sla_result === 'fail' && record.complaint_result === 'skipped') {
    console.log(`  🔔 이의신청: ${chalk.dim('생략됨 (dry-run)')}`);
  }
}
