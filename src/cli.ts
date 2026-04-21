#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { ProjectManager } from "./orchestrator/pm.js";
import { loadConfig } from "./config/config.js";
import { startDashboard } from "./web/server.js";
import { LOG_FILE_PATH, logger } from "./utils/logger.js";

const program = new Command();

program
  .name("furyclaw")
  .description("Claude Code CLI 멀티 에이전트 오케스트레이터")
  .version("0.1.0");

// 원샷 CLI 실행
program
  .command("run")
  .description("터미널에서 작업 한 번 실행")
  .argument("<task>", "수행할 작업 설명")
  .option("-c, --concurrency <n>", "동시 워커 수", "3")
  .option("-m, --model <model>", "기본 모델 (opus/sonnet/haiku)", "opus")
  .option("-e, --effort <level>", "추론 강도 (low/medium/high/max)", "max")
  .option("-p, --permission <mode>", "권한 모드 (strict/auto/unrestricted)", "auto")
  .option("-d, --dir <path>", "워킹 디렉터리", process.cwd())
  .option("--budget <usd>", "총 예산 상한 (USD)")
  .action(async (task: string, opts) => {
    const config = loadConfig(opts.dir, {
      concurrency: parseInt(opts.concurrency, 10),
      defaultModel: opts.model,
      effort: opts.effort,
      permissionMode: opts.permission,
      ...(opts.budget ? { maxBudgetUsd: parseFloat(opts.budget) } : {}),
    });

    console.log(
      chalk.bold.magenta("\n  FuryClaw") +
        chalk.dim(
          ` v0.1.0 — 워커 ${config.concurrency}개, 모델 ${config.defaultModel}, effort ${config.effort}`
        )
    );
    console.log(chalk.dim(`  로그: ${LOG_FILE_PATH}\n`));
    logger.info("cli", `run 모드 시작. dir=${opts.dir}`);

    const pm = new ProjectManager(config, opts.dir);
    let lastChatLen = 0;

    pm.on("state", () => {
      const state = pm.getState();
      const chat = state.chat;
      while (lastChatLen < chat.length) {
        const msg = chat[lastChatLen];
        lastChatLen++;
        if (msg.from === "user") continue;
        if (msg.from === "system" && msg.type === "status") {
          console.log(chalk.dim(`  ${msg.text}`));
        } else if (msg.from === "system" && msg.type === "plan") {
          console.log(chalk.cyan(`\n${msg.text}\n`));
        } else if (msg.from === "system" && msg.type === "result") {
          console.log(chalk.green(`\n${msg.text}\n`));
        } else if (msg.from === "pm") {
          console.log(chalk.bold("PM: ") + msg.text);
        } else if (msg.from === "worker") {
          const prefix = msg.workerId ? `[${msg.workerId}] ` : "";
          if (msg.type === "result") {
            console.log(chalk.green(`\n${prefix}${msg.text}\n`));
          } else if (msg.type === "broadcast") {
            console.log(chalk.yellow(`${prefix}${msg.text}`));
          } else if (msg.type === "ask") {
            console.log(chalk.cyan(`${prefix}${msg.text}`));
          } else {
            console.log(`  ${prefix}${msg.text}`);
          }
        } else {
          console.log(`  ${msg.text}`);
        }
      }
    });

    await pm.handleUserMessage(task);

    // 완료 대기
    await new Promise<void>((resolve) => {
      const check = () => {
        const s = pm.getState().status;
        if (s === "done" || s === "error") {
          resolve();
          return;
        }
        setTimeout(check, 500);
      };
      check();
    });

    // PMAgent 마지막 보고가 enqueue된 상태일 수 있으니 잠시 대기
    while (pm.isBusy()) {
      await new Promise((r) => setTimeout(r, 300));
    }

    const state = pm.getState();
    console.log(chalk.dim(`\n━━━ 누적 비용: $${state.totalCostUsd.toFixed(4)} ━━━\n`));

    await pm.dispose();
  });

// 웹 대시보드
program
  .command("web")
  .description("웹 대시보드 시작")
  .option("-c, --concurrency <n>", "동시 워커 수", "3")
  .option("-m, --model <model>", "기본 모델 (opus/sonnet/haiku)", "opus")
  .option("-e, --effort <level>", "추론 강도 (low/medium/high/max)", "max")
  .option("-p, --permission <mode>", "권한 모드 (strict/auto/unrestricted)", "auto")
  .option("-d, --dir <path>", "워킹 디렉터리", process.cwd())
  .option("--port <port>", "대시보드 포트", "3000")
  .action(async (opts) => {
    const config = loadConfig(opts.dir, {
      concurrency: parseInt(opts.concurrency, 10),
      defaultModel: opts.model,
      effort: opts.effort,
      permissionMode: opts.permission,
    });

    console.log(
      chalk.bold.magenta("\n  FuryClaw PM") +
        chalk.dim(
          ` v0.1.0 — 모델 ${config.defaultModel}, effort ${config.effort}, 워커 ${config.concurrency}개`
        )
    );
    console.log(chalk.dim(`  로그: ${LOG_FILE_PATH}`));
    logger.info("cli", `web 모드 시작. dir=${opts.dir} port=${opts.port}`);

    await startDashboard(config, opts.dir, parseInt(opts.port, 10));
  });

program.parse();
