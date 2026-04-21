import { execa } from "execa";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskPlanSchema, type TaskPlan } from "../types/task.js";
import { topologicalSort } from "../workers/worker-manager.js";
import { PLANNER_SYSTEM_PROMPT } from "./prompts.js";
import { CLAUDE_MODEL_ID } from "../config/models.js";

export interface PlannerOptions {
  userTask: string;
  workingDirectory: string;
  model?: string;
  effort: string;
}

export async function planTask(opts: PlannerOptions): Promise<TaskPlan> {
  const { userTask, workingDirectory, effort } = opts;

  // System prompt includes JSON format instructions (no --json-schema needed)
  const fullPrompt = `${PLANNER_SYSTEM_PROMPT}

RESPOND WITH EXACTLY THIS JSON STRUCTURE (no markdown, no code fences):
{
  "summary": "brief description of the plan",
  "tasks": [
    {
      "id": "unique-task-id",
      "role": "general|implementer|sysadmin|tester|reviewer|documenter|researcher",
      "mission": "one line describing what this task does",
      "description": "detailed description",
      "scope": { "ownFiles": ["files to modify"], "readonlyFiles": [], "forbiddenFiles": [] },
      "requirements": ["requirement 1", "requirement 2"],
      "constraints": [],
      "suggestedApproach": "optional hint",
      "dependsOn": ["other-task-id"],
      "model": "opus"
    }
  ]
}`;

  const tmpDir = join(tmpdir(), "furyclaw");
  mkdirSync(tmpDir, { recursive: true });
  const sysPromptFile = join(tmpDir, `planner-sysprompt-${Date.now()}.txt`);
  writeFileSync(sysPromptFile, fullPrompt, "utf-8");

  const args = [
    "--print",
    "--output-format", "json",
    "--model", CLAUDE_MODEL_ID,
    "--effort", effort,
    "--system-prompt-file", sysPromptFile,
    "--permission-mode", "auto",
    "--allowedTools", "Read,Glob,Grep",
  ];

  const result = await execa("claude", args, {
    cwd: workingDirectory,
    reject: false,
    timeout: 60 * 60 * 1000,
    input: userTask,
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");

  if (result.exitCode !== 0) {
    throw new Error(`Planner exited with code ${result.exitCode}.\nStderr: ${stderr.slice(0, 500)}\nStdout: ${stdout.slice(0, 500)}`);
  }

  if (!stdout.trim()) {
    throw new Error(`Planner returned empty output. Stderr: ${stderr.slice(0, 500)}`);
  }

  // Parse Claude's JSON output
  let claudeResult: string;
  try {
    const jsonResult = JSON.parse(stdout);
    if (jsonResult.is_error) {
      throw new Error(`Claude error: ${jsonResult.result || "unknown"}`);
    }
    claudeResult = jsonResult.result ?? "";
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Claude error:")) throw err;
    throw new Error(`Failed to parse Claude output: ${(err as Error).message}\nRaw: ${stdout.slice(0, 500)}`);
  }

  // Extract JSON from Claude's response (might have text around it)
  let parsed: unknown;
  try {
    parsed = JSON.parse(claudeResult);
  } catch {
    // Try to find JSON in the response
    const jsonMatch = claudeResult.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        throw new Error(`Could not extract JSON from planner response:\n${claudeResult.slice(0, 800)}`);
      }
    } else {
      throw new Error(`No JSON found in planner response:\n${claudeResult.slice(0, 800)}`);
    }
  }

  let plan;
  try {
    plan = TaskPlanSchema.parse(parsed);
  } catch (err) {
    throw new Error(`Plan validation failed: ${(err as Error).message}\nParsed: ${JSON.stringify(parsed).slice(0, 500)}`);
  }

  // Auto-compute execution order if not provided
  if (!plan.executionOrder || plan.executionOrder.length === 0) {
    plan.executionOrder = topologicalSort(plan.tasks);
  }

  return plan;
}
