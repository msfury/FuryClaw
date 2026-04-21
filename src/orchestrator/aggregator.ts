import { execa } from "execa";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WorkerResult, OrchestratorResult, TaskPlan } from "../types/task.js";
import { AGGREGATOR_SYSTEM_PROMPT } from "./prompts.js";

export interface AggregatorOptions {
  plan: TaskPlan;
  results: WorkerResult[];
  workingDirectory: string;
  model: string;
  effort: string;
}

export async function aggregateResults(opts: AggregatorOptions): Promise<OrchestratorResult> {
  const { plan, results, workingDirectory, model, effort } = opts;
  const startTime = Date.now();

  const totalCost = results.reduce((sum, r) => sum + r.costUsd, 0);
  const allSucceeded = results.every((r) => r.success);

  // Build a compact summary of all worker results for the aggregator
  const workerSummary = results
    .map((r) => {
      const task = plan.tasks.find((t) => t.id === r.taskId);
      return [
        `## Worker: ${r.taskId} (${task?.role ?? "unknown"})`,
        `Status: ${r.success ? "OK" : "FAILED"}`,
        `Files: ${r.filesChanged.join(", ") || "none"}`,
        `Decisions: ${r.decisions.join(" | ") || "none"}`,
        `Notes: ${r.notes.join(" | ") || "none"}`,
        r.success ? "" : `Error: ${r.output.slice(0, 300)}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  const prompt = `Original task: ${plan.summary}\n\nWorker results:\n${workerSummary}`;

  let summary: string;
  let aggregatorCost = 0;

  try {
    const tmpDir = join(tmpdir(), "furyclaw");
    mkdirSync(tmpDir, { recursive: true });
    const sysPromptFile = join(tmpDir, `aggregator-sysprompt-${Date.now()}.txt`);
    writeFileSync(sysPromptFile, AGGREGATOR_SYSTEM_PROMPT, "utf-8");

    const result = await execa(
      "claude",
      [
        "--print",
        "--output-format", "json",
        "--model", model,
        "--effort", effort,
        "--system-prompt-file", sysPromptFile,
        "--permission-mode", "auto",
        "--allowedTools", "Read,Glob,Grep",
      ],
      {
        cwd: workingDirectory,
        reject: false,
        timeout: 60 * 60 * 1000,
        input: prompt,
        env: { ...process.env, FORCE_COLOR: "0" },
      }
    );

    if (result.exitCode === 0) {
      try {
        const json = JSON.parse(result.stdout);
        summary = json.result ?? result.stdout;
        aggregatorCost = json.total_cost_usd ?? 0;
      } catch {
        summary = result.stdout;
      }
    } else {
      summary = buildFallbackSummary(results, plan);
    }
  } catch {
    summary = buildFallbackSummary(results, plan);
  }

  return {
    success: allSucceeded,
    summary,
    workerResults: results,
    totalCostUsd: totalCost + aggregatorCost,
    totalDurationMs: Date.now() - startTime,
  };
}

function buildFallbackSummary(results: WorkerResult[], plan: TaskPlan): string {
  const lines = [`# ${plan.summary}`, ""];
  for (const r of results) {
    const task = plan.tasks.find((t) => t.id === r.taskId);
    lines.push(`- **${task?.role ?? r.taskId}**: ${r.success ? "✓" : "✗"} ${r.filesChanged.join(", ")}`);
  }
  return lines.join("\n");
}
