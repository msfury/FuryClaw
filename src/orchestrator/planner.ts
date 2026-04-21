import { execa } from "execa";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskPlanSchema, type TaskPlan } from "../types/task.js";
import { topologicalSort } from "../workers/worker-manager.js";
import { PLANNER_SYSTEM_PROMPT } from "./prompts.js";
import { CLAUDE_MODEL_ID } from "../config/models.js";
import { logger, dumpToFile } from "../utils/logger.js";

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
    // 띄우는 Claude는 무한 권한 — 인터랙티브 모드가 아니므로 권한 프롬프트가 떠도
    // 처리할 사람이 없음. 탐색·파일 읽기·외부 디렉터리 접근 모두 자유롭게.
    "--dangerously-skip-permissions",
  ];

  logger.info("planner", `Claude CLI 호출 시작. userTask=${userTask.slice(0, 120)}…`);

  const result = await execa("claude", args, {
    cwd: workingDirectory,
    reject: false,
    timeout: 60 * 60 * 1000,
    input: userTask,
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");

  // 실패/이상 흐름 감지 시 raw 출력을 파일로 덤프 후 경로를 에러 메시지에 포함시킨다.
  const dumpIfNeeded = (reason: string) => {
    const dumpContent = [
      `# Planner 실패 덤프`,
      `# reason: ${reason}`,
      `# exitCode: ${result.exitCode}`,
      `# cwd: ${workingDirectory}`,
      `# userTask: ${userTask}`,
      ``,
      `===== STDERR =====`,
      stderr || "(empty)",
      ``,
      `===== STDOUT =====`,
      stdout || "(empty)",
    ].join("\n");
    const path = dumpToFile("planner", "error", dumpContent);
    logger.error("planner", `${reason}. 덤프: ${path}`);
    return path;
  };

  if (result.exitCode !== 0) {
    const dump = dumpIfNeeded("non-zero exit");
    throw new Error(
      `Planner exit ${result.exitCode}. 상세: ${dump || stderr.slice(0, 300)}`
    );
  }

  if (!stdout.trim()) {
    const dump = dumpIfNeeded("empty stdout");
    throw new Error(`Planner 빈 출력. 상세: ${dump}`);
  }

  // Claude CLI의 JSON 출력 파싱
  let claudeResult: string;
  try {
    const jsonResult = JSON.parse(stdout);
    if (jsonResult.is_error) {
      const dump = dumpIfNeeded("claude is_error=true");
      throw new Error(`Claude 에러: ${jsonResult.result || "unknown"}. 상세: ${dump}`);
    }
    claudeResult = jsonResult.result ?? "";
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Claude 에러:")) throw err;
    const dump = dumpIfNeeded("stdout JSON parse 실패");
    throw new Error(
      `Claude 출력 파싱 실패: ${(err as Error).message}. 상세: ${dump}`
    );
  }

  // Claude 응답에서 JSON 추출 (앞뒤 텍스트가 있을 수도 있음)
  let parsed: unknown;
  try {
    parsed = JSON.parse(claudeResult);
  } catch {
    const jsonMatch = claudeResult.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        const dump = dumpIfNeeded("extracted JSON parse 실패");
        const snippet = claudeResult.slice(0, 400).replace(/\n/g, " ");
        throw new Error(
          `Planner 응답 일부만 JSON. 상세: ${dump}\nPlanner가 말한 내용(발췌): ${snippet}`
        );
      }
    } else {
      const dump = dumpIfNeeded("응답에 JSON 없음");
      const snippet = claudeResult.slice(0, 400).replace(/\n/g, " ");
      throw new Error(
        `Planner가 JSON 대신 대화로 답했습니다. 상세: ${dump}\nPlanner가 말한 내용(발췌): ${snippet}`
      );
    }
  }

  let plan;
  try {
    plan = TaskPlanSchema.parse(parsed);
  } catch (err) {
    const dump = dumpToFile(
      "planner",
      "schema-fail",
      `# zod 검증 실패\n${(err as Error).message}\n\n# parsed 값\n${JSON.stringify(parsed, null, 2)}`
    );
    logger.error("planner", `TaskPlanSchema 검증 실패. 덤프: ${dump}`);
    throw new Error(`플랜 스키마 검증 실패. 상세: ${dump}`);
  }

  logger.info("planner", `플랜 생성 성공. 태스크 ${plan.tasks.length}개.`);

  // Auto-compute execution order if not provided
  if (!plan.executionOrder || plan.executionOrder.length === 0) {
    plan.executionOrder = topologicalSort(plan.tasks);
  }

  return plan;
}
