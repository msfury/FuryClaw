import { execa, type ResultPromise } from "execa";
import treeKill from "tree-kill";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStreamParser, type StreamEvent } from "./stream-parser.js";
import { buildPermissionFlags, buildAllowedTools } from "../permissions/permission-tier.js";
import type { SubTask, WorkerResult } from "../types/task.js";
import type { FuryClawConfig } from "../types/config.js";
import { CLAUDE_MODEL_ID, KOREAN_LANGUAGE_DIRECTIVE } from "../config/models.js";
import { TOOL_DEFS, MCP_TOOL_ALLOWLIST } from "../mcp/mcp-server.js";

/**
 * TOOL_DEFS를 워커 시스템 프롬프트용 마크다운 섹션으로 변환.
 * 툴 이름·인자·설명·블로킹 여부를 서버 정의에서 직접 파생하므로,
 * 툴 추가/변경 시 프롬프트가 자동 갱신됨 (drift 방지).
 */
function buildMcpToolsSection(): string {
  const lines: string[] = [
    "MCP 소통 도구 (mcp__furyclaw__<이름> 형태로 노출, 반드시 활용):",
    "",
  ];
  TOOL_DEFS.forEach((t, i) => {
    const keys = Object.keys(t.inputSchema.properties);
    const signature = keys.length > 0 ? `{ ${keys.join(", ")} }` : "{}";
    const blockTag = t.blocking ? " (블로킹)" : "";
    lines.push(`${i + 1}. **${t.name}(${signature})**${blockTag}`);
    for (const descLine of t.description.split("\n")) {
      lines.push(`   ${descLine}`);
    }
    lines.push("");
  });
  return lines.join("\n");
}

const COMPACT_OUTPUT_INSTRUCTION = `
${KOREAN_LANGUAGE_DIRECTIVE}

당신은 FuryClaw 멀티 에이전트 시스템의 워커(Claude Code 인스턴스)입니다. 사용자가 아니라 오케스트레이터(PM)에게 보고합니다.

운영 모드:
- 비대화형(--print) 모드. 사용자에게 직접 질문 불가. AskUserQuestion 도구 사용 금지.
- PM 및 다른 워커와는 MCP 도구로 **적극적으로** 소통합니다.
- 침묵하지 마세요. 플랜 선언 → 스텝 보고 → 필요 시 broadcast/ask → 완료 신호의 흐름을 지키세요.

${buildMcpToolsSection()}
중복 작업 방지 원칙:
- 내 ownFiles 밖의 작업이 필요한데 다른 워커가 이미 하고 있다면, 그 쪽이 끝날 때까지 기다리거나 ask_worker로 결과 공유 요청.
- 내 플랜에 있는 스텝을 다른 워커가 이미 훔쳐갔다면(list_workers에서 status=stolen), 그 스텝은 건너뛰고 다음으로.

모든 도구 인자·보고 텍스트는 **한국어**로 작성.

최종 보고 형식 (report_done 호출 후, stdout에 출력):
---RESULT---
FILES: file1.ts, file2.ts (변경/생성된 파일, 없으면 "none")
DECISIONS: 핵심 결정 1 | 핵심 결정 2
NOTES: 오케스트레이터가 필요로 하는 결과 데이터 (실제 경로/값/전체 답변). 절대 잘라내지 마세요.
---END---

- 코드 작업: 변경 후 무엇을 했는지 보고.
- 탐색/쿼리 작업: NOTES에 **전체** 답변과 **모든** 파일 경로/데이터. 요약 금지.
- 인사/메타 설명/장황한 마크다운 금지. 간결하지만 **완전하게**.
`.trim();

export interface WorkerOptions {
  task: SubTask;
  config: FuryClawConfig;
  workingDirectory: string;
  mcpConfigPath?: string;
  onEvent?: (taskId: string, event: StreamEvent) => void;
  predecessorOutputs?: Map<string, string>;
}

export async function runWorker(opts: WorkerOptions): Promise<WorkerResult> {
  const { task, config, workingDirectory, mcpConfigPath, onEvent, predecessorOutputs } = opts;
  const startTime = Date.now();

  const systemPrompt = buildSystemPrompt(task, config, predecessorOutputs);
  const promptText = task.requirements.join("\n");
  const args = buildArgs(task, config, systemPrompt, mcpConfigPath);

  let result: WorkerResult = {
    taskId: task.id,
    success: false,
    output: "",
    filesChanged: [],
    decisions: [],
    notes: [],
    costUsd: 0,
    durationMs: 0,
  };

  const parser = createStreamParser((event) => {
    onEvent?.(task.id, event);

    if (event.type === "result") {
      result.success = true;
      result.output = event.result;
      result.costUsd = event.costUsd;
      result.usage = event.usage;
      parseCompactOutput(event.result, result);
      // Emit cost event so dashboard can update
      onEvent?.(task.id, { type: "cost", costUsd: event.costUsd });
    }
    if (event.type === "error") {
      result.output = event.message;
    }
  });

  let proc: ResultPromise | undefined;

  try {
    proc = execa("claude", args, {
      cwd: workingDirectory,
      reject: false,
      timeout: 60 * 60 * 1000,
      input: promptText,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    if (proc.stdout) {
      proc.stdout.on("data", (chunk: Buffer) => {
        parser.feed(chunk.toString());
      });
    }

    const execResult = await proc;
    parser.flush();

    if (execResult.exitCode !== 0 && !result.success) {
      result.output = String(execResult.stderr || execResult.stdout || "Process exited with error");
    }

    // If streaming didn't give us a result, try parsing stdout as JSON
    if (!result.success && execResult.stdout) {
      try {
        const json = JSON.parse(String(execResult.stdout));
        if (json.result) {
          result.success = !json.is_error;
          result.output = json.result;
          result.costUsd = json.total_cost_usd ?? 0;
          if (json.usage) {
            result.usage = {
              inputTokens: json.usage.input_tokens,
              outputTokens: json.usage.output_tokens,
            };
          }
          parseCompactOutput(json.result, result);
        }
      } catch {
        // Not JSON, use raw output
        if (!result.output) result.output = String(execResult.stdout);
      }
    }
  } catch (err) {
    result.output = err instanceof Error ? err.message : String(err);
  }

  result.durationMs = Date.now() - startTime;
  return result;
}

export function killWorker(pid: number): Promise<void> {
  return new Promise((resolve) => {
    treeKill(pid, "SIGTERM", (err) => {
      if (err) {
        treeKill(pid, "SIGKILL", () => resolve());
      } else {
        resolve();
      }
    });
  });
}

function buildSystemPrompt(
  task: SubTask,
  _config: FuryClawConfig,
  predecessorOutputs?: Map<string, string>
): string {
  const sections: string[] = [COMPACT_OUTPUT_INSTRUCTION];

  sections.push(`\n## 당신의 task_id: ${task.id}`);
  sections.push(`> 모든 MCP 툴 호출 시 task_id/from 필드에 반드시 **"${task.id}"**를 넣으세요. 추측/생략 금지.`);
  sections.push(`## Your Role: ${task.role}`);
  sections.push(`## Mission: ${task.mission}`);

  if (task.scope.ownFiles.length > 0) {
    sections.push(`\n## Your Files (modify these):\n${task.scope.ownFiles.map((f) => `- ${f}`).join("\n")}`);
  }
  if (task.scope.readonlyFiles.length > 0) {
    sections.push(`## Reference Files (read only):\n${task.scope.readonlyFiles.map((f) => `- ${f}`).join("\n")}`);
  }
  if (task.scope.forbiddenFiles.length > 0) {
    sections.push(`## DO NOT TOUCH:\n${task.scope.forbiddenFiles.map((f) => `- ${f}`).join("\n")}`);
  }

  if (task.constraints.length > 0) {
    sections.push(`\n## Constraints:\n${task.constraints.map((c) => `- ${c}`).join("\n")}`);
  }

  if (task.interfaceContracts.length > 0) {
    sections.push(`\n## Interface Contracts:`);
    for (const ic of task.interfaceContracts) {
      sections.push(`- ${ic.type === "provides" ? "YOU PROVIDE" : "YOU CONSUME"} (${ic.counterpart}): ${ic.contract}`);
    }
  }

  if (task.suggestedApproach) {
    sections.push(`\n## Suggested Approach:\n${task.suggestedApproach}`);
  }

  if (predecessorOutputs && predecessorOutputs.size > 0) {
    sections.push(`\n## Previous Worker Results:`);
    for (const [id, output] of predecessorOutputs) {
      sections.push(`### ${id}:\n${output.slice(0, 2000)}`);
    }
  }

  return sections.join("\n");
}

function buildArgs(
  task: SubTask,
  config: FuryClawConfig,
  systemPrompt: string,
  mcpConfigPath?: string
): string[] {
  // Write system prompt to temp file to avoid Windows command line length limits
  const tmpDir = join(tmpdir(), "furyclaw");
  mkdirSync(tmpDir, { recursive: true });
  const sysPromptFile = join(tmpDir, `sysprompt-${task.id}-${Date.now()}.txt`);
  writeFileSync(sysPromptFile, systemPrompt, "utf-8");

  const args: string[] = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--model", CLAUDE_MODEL_ID,
    "--effort", config.effort,
    "--system-prompt-file", sysPromptFile,
  ];

  const permFlags = buildPermissionFlags(config.permissionMode);
  args.push(...permFlags);

  const role = config.roles[task.role] ?? config.roles["general"];
  if (role?.allowedTools) {
    const filtered = buildAllowedTools(task.role, role.allowedTools, config.permissionMode);
    if (filtered.length > 0 && config.permissionMode !== "unrestricted") {
      // MCP furyclaw 툴은 TOOL_DEFS에서 파생되는 MCP_TOOL_ALLOWLIST를 그대로 사용.
      // 툴 추가 시 mcp-server.ts TOOL_DEFS만 수정하면 여기도 자동 반영됨.
      const mcpTools = mcpConfigPath ? MCP_TOOL_ALLOWLIST : [];
      const combined = [...new Set([...filtered, ...mcpTools])];
      args.push("--allowedTools", combined.join(","));
    }
  }

  if (task.maxBudgetUsd) {
    args.push("--max-turns", String(Math.ceil(task.maxBudgetUsd * 20)));
  }

  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath);
  }

  // Prompt is passed via stdin (input option in execa), not as positional arg
  return args;
}

function parseCompactOutput(raw: string, result: WorkerResult): void {
  const filesMatch = raw.match(/FILES:\s*(.+)/);
  if (filesMatch) {
    result.filesChanged = filesMatch[1].split(",").map((f) => f.trim()).filter(Boolean);
  }

  const decisionsMatch = raw.match(/DECISIONS:\s*(.+)/);
  if (decisionsMatch) {
    result.decisions = decisionsMatch[1].split("|").map((d) => d.trim()).filter(Boolean);
  }

  const notesMatch = raw.match(/NOTES:\s*(.+)/);
  if (notesMatch) {
    result.notes = notesMatch[1].split("|").map((n) => n.trim()).filter(Boolean);
  }
}
