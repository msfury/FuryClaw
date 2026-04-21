import chalk from "chalk";
import ora from "ora";
import { planTask } from "./planner.js";
import { aggregateResults } from "./aggregator.js";
import { executeplan } from "../workers/worker-manager.js";
import type { StreamEvent } from "../workers/stream-parser.js";
import type { WorkerResult, OrchestratorResult } from "../types/task.js";
import type { FuryClawConfig } from "../types/config.js";

export interface RunOptions {
  userTask: string;
  config: FuryClawConfig;
  workingDirectory: string;
}

export async function run(opts: RunOptions): Promise<OrchestratorResult> {
  const { userTask, config, workingDirectory } = opts;

  // Phase 1: Plan
  const planSpinner = ora({
    text: chalk.cyan("Analyzing task and decomposing..."),
    color: "cyan",
  }).start();

  let plan;
  try {
    plan = await planTask({
      userTask,
      workingDirectory,
      model: config.defaultModel,
      effort: config.effort,
    });
    planSpinner.succeed(
      chalk.green(`Decomposed into ${plan.tasks.length} subtask(s): ${plan.summary}`)
    );
  } catch (err) {
    planSpinner.fail(chalk.red("Planning failed"));
    throw err;
  }

  // Show plan
  console.log();
  for (const task of plan.tasks) {
    const modelTag = chalk.dim(`[${task.model ?? config.defaultModel}]`);
    console.log(`  ${chalk.yellow("→")} ${chalk.bold(task.id)} ${modelTag} ${task.mission}`);
    if (task.scope.ownFiles.length > 0) {
      console.log(`    ${chalk.dim("files:")} ${task.scope.ownFiles.join(", ")}`);
    }
    if (task.dependsOn.length > 0) {
      console.log(`    ${chalk.dim("after:")} ${task.dependsOn.join(", ")}`);
    }
  }
  console.log();

  // Phase 2: Execute
  const activeWorkers = new Map<string, ReturnType<typeof ora>>();
  const completedCount = { value: 0 };

  const onWorkerEvent = (taskId: string, event: StreamEvent) => {
    if (event.type === "init") {
      const spinner = ora({
        text: chalk.blue(`[${taskId}] Started`),
        color: "blue",
        prefixText: "  ",
      }).start();
      activeWorkers.set(taskId, spinner);
    }
    if (event.type === "tool_use") {
      const spinner = activeWorkers.get(taskId);
      if (spinner) {
        spinner.text = chalk.blue(`[${taskId}] ${event.tool}...`);
      }
    }
  };

  const onWorkerComplete = (result: WorkerResult) => {
    completedCount.value++;
    const spinner = activeWorkers.get(result.taskId);
    const costStr = result.costUsd > 0 ? ` $${result.costUsd.toFixed(4)}` : "";
    const timeStr = `${(result.durationMs / 1000).toFixed(1)}s`;

    if (spinner) {
      if (result.success) {
        spinner.succeed(
          chalk.green(`[${result.taskId}] Done ${chalk.dim(`${timeStr}${costStr}`)}`)
        );
      } else {
        spinner.fail(chalk.red(`[${result.taskId}] Failed ${chalk.dim(timeStr)}`));
      }
    }
  };

  const executeSpinner = ora({
    text: chalk.cyan(`Executing ${plan.tasks.length} workers (concurrency: ${config.concurrency})...`),
    color: "cyan",
  }).start();
  executeSpinner.stop();

  const results = await executeplan({
    plan,
    config,
    workingDirectory,
    onWorkerEvent,
    onWorkerComplete,
  });

  console.log();

  // Phase 3: Aggregate
  const aggSpinner = ora({
    text: chalk.cyan("Synthesizing results..."),
    color: "cyan",
  }).start();

  const finalResult = await aggregateResults({
    plan,
    results,
    workingDirectory,
    model: config.defaultModel,
    effort: config.effort,
  });

  aggSpinner.succeed(chalk.green("Done"));

  return finalResult;
}
