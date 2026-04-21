/**
 * PM (Project Manager) — FuryClaw의 지속 데몬.
 *
 * 역할:
 *  - 사용자와 채팅으로 끊임없이 소통 (PMAgent가 한국어 자연어로 말함)
 *  - Planner를 통해 작업 분해 → 워커들을 병렬 실행
 *  - MCP 허브 이벤트 수신: 워커 플랜/스텝/broadcast/ask_pm/ask_worker/claim_step
 *  - 워커의 ask_pm / ask_worker를 PMAgent로 해결
 *  - "지금 뭐해?" 류 질문에 각 워커의 플랜·스텝·진행도를 종합 답변
 */

import { EventEmitter } from "node:events";
import { planTask } from "./planner.js";
import { runWorker } from "../workers/worker.js";
import { PMAgent } from "./pm-agent.js";
import { startMCPServer, type MCPServer, type MCPEvent, type WorkerRuntime } from "../mcp/mcp-server.js";
import type { SubTask, TaskPlan, WorkerResult } from "../types/task.js";
import type { FuryClawConfig } from "../types/config.js";
import type { StreamEvent } from "../workers/stream-parser.js";

// ─── 타입 ───

export type PMStatus =
  | "idle"
  | "planning"
  | "executing"
  | "waiting_user"
  | "replanning"
  | "done"
  | "error";

export interface ChatMessage {
  id: string;
  time: number;
  from: "user" | "pm" | "worker" | "system";
  workerId?: string;
  text: string;
  type: "message" | "question" | "plan" | "status" | "result" | "suggestion" | "broadcast" | "ask";
  choices?: string[];
  requiresResponse?: boolean;
}

export interface WorkerPlanStepView {
  index: number;
  title: string;
  status: "pending" | "running" | "done" | "stolen";
  claimedBy?: string;
}

export interface WorkerInfo {
  taskId: string;
  role: string;
  mission: string;
  status: "pending" | "running" | "done" | "failed" | "waiting";
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model?: string;
  startTime: number | null;
  durationMs: number;
  currentTool: string | null;
  filesChanged: string[];
  // 워커가 MCP로 선언한 플랜/스텝
  plan: WorkerPlanStepView[];
  currentStepIndex: number | null;
  currentStepTitle: string | null;
  // 훔쳐온 스텝들 (다른 워커에서 가져온 것)
  stolenSteps: Array<{ from: string; index: number; title: string; at: number }>;
  // 최근 broadcast 및 ask 이력 (UI 표시용)
  broadcasts: Array<{ at: number; message: string }>;
  recentAsks: Array<{ at: number; type: "ask_pm" | "ask_worker"; target?: string; question: string; answer?: string }>;
  logs: Array<{ time: number; type: string; message: string }>;
}

// MTok 단가 (USD). Cache read ≈ input의 10%, cache creation(5분) ≈ 125%.
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  opus: { input: 15, output: 75 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
};

function estimateCost(w: WorkerInfo): number {
  const m = (w.model || "opus").toLowerCase();
  const key = m.includes("opus") ? "opus" : m.includes("haiku") ? "haiku" : "sonnet";
  const p = MODEL_PRICES[key];
  return (
    (w.inputTokens * p.input +
      w.outputTokens * p.output +
      w.cacheReadTokens * p.input * 0.1 +
      w.cacheCreationTokens * p.input * 1.25) /
    1_000_000
  );
}

export interface PMState {
  status: PMStatus;
  plan: TaskPlan | null;
  workers: Map<string, WorkerInfo>;
  chat: ChatMessage[];
  totalCostUsd: number;
  startTime: number | null;
  pendingQuestion: ChatMessage | null;
}

// ─── PM 클래스 ───

export class ProjectManager extends EventEmitter {
  private state: PMState;
  private config: FuryClawConfig;
  private workingDirectory: string;
  private pendingResolve: ((answer: string) => void) | null = null;
  private pmAgent: PMAgent;
  private mcp: MCPServer | null = null;

  constructor(config: FuryClawConfig, workingDirectory: string) {
    super();
    this.config = config;
    this.workingDirectory = workingDirectory;
    this.pmAgent = new PMAgent(config, workingDirectory);
    this.state = {
      status: "idle",
      plan: null,
      workers: new Map(),
      chat: [],
      totalCostUsd: 0,
      startTime: null,
      pendingQuestion: null,
    };
  }

  getState(): PMState {
    return this.state;
  }

  getConfig(): FuryClawConfig {
    return this.config;
  }

  updateConfig(updates: Partial<FuryClawConfig>) {
    if (updates.defaultModel) this.config.defaultModel = updates.defaultModel;
    if (updates.effort) this.config.effort = updates.effort;
    if (updates.concurrency) this.config.concurrency = updates.concurrency;
    this.emit("state");
  }

  async dispose(): Promise<void> {
    if (this.mcp) {
      await this.mcp.stop();
      this.mcp = null;
    }
  }

  /** PMAgent가 아직 메시지를 처리 중인지. CLI 종료 전 기다릴 때 사용. */
  isBusy(): boolean {
    return this.pmAgent.isBusy();
  }

  // ─── 사용자 메시지 처리 ───
  async handleUserMessage(text: string) {
    this.addChat("user", text, "message");

    // PM이 사용자 답변 대기 중이었으면 해당 약속 해결
    if (this.state.pendingQuestion && this.pendingResolve) {
      this.state.pendingQuestion = null;
      this.state.status = "executing";
      this.pendingResolve(text);
      this.pendingResolve = null;
      this.emit("state");
      return;
    }

    // idle/done/error: 새 작업 시작
    if (
      this.state.status === "idle" ||
      this.state.status === "done" ||
      this.state.status === "error"
    ) {
      await this.startTask(text);
      return;
    }

    // 실행 중: PMAgent에 [USER] 블록으로 전달. PM이 상황 설명 또는 대응.
    this.askPmAgentToChat(`[USER] ${text}`);
  }

  // ─── 상태 문의/대화 전용: PMAgent에 [CONTEXT] + 메시지 주입 ───
  private askPmAgentToChat(rawMessage: string) {
    const context = this.buildContextBlock();
    const message = `${context}\n\n${rawMessage}`;

    this.pmAgent.enqueue(message, {
      onFinish: (full, cost) => {
        const finalText = full.trim();
        if (finalText) this.addChat("pm", finalText, "message");
        this.state.totalCostUsd += cost;
        this.emit("state");
      },
      onError: (err) => {
        this.addChat("system", `PM 호출 실패: ${err}`, "status");
        this.emit("state");
      },
    });
  }

  // ─── 작업 시작 ───
  private async startTask(userTask: string) {
    this.state.status = "planning";
    this.state.plan = null;
    this.state.workers.clear();
    this.state.totalCostUsd = 0;
    this.state.startTime = Date.now();
    this.state.pendingQuestion = null;
    this.emit("state");

    // MCP 서버 — 최초 1회 부팅, 이후 작업마다 상태만 리셋
    if (!this.mcp) {
      try {
        this.mcp = await startMCPServer(this.config.mcpPort);
        this.wireMCPEvents(this.mcp);
      } catch (err) {
        this.state.status = "error";
        this.addChat("system", `MCP 서버 기동 실패: ${err instanceof Error ? err.message : err}`, "status");
        this.emit("state");
        return;
      }
    } else {
      // 이전 작업의 워커 상태 제거
      this.mcp.reset();
    }

    this.askPmAgentToChat(`[EVENT] 사용자가 새 작업을 맡겼습니다. 지금부터 Planner가 작업을 분해할 거예요. 시작한다고 짧게 알리세요.`);

    // 플래닝
    let plan: TaskPlan;
    try {
      plan = await planTask({
        userTask,
        workingDirectory: this.workingDirectory,
        model: this.config.defaultModel,
        effort: this.config.effort,
      });
      this.state.plan = plan;
    } catch (err) {
      this.state.status = "error";
      const errMsg = err instanceof Error ? err.message : String(err);
      this.addChat("system", `Planner 실패: ${errMsg}`, "status");
      this.askPmAgentToChat(`[EVENT] Planner가 작업 분해에 실패했습니다. 에러: ${errMsg.slice(0, 300)}. 사용자에게 짧게 알리세요.`);
      this.emit("state");
      return;
    }

    // 플랜 요약을 system 라인으로 UI에 기록
    const planLines = plan.tasks.map(
      (t) => `• ${t.id} [${t.role}]: ${t.mission}`
    );
    this.addChat("system", `📋 플랜 — ${plan.tasks.length}개 태스크\n${planLines.join("\n")}`, "plan");

    // PMAgent가 플랜을 사용자에게 자연어로 소개
    const planForAgent = plan.tasks
      .map((t) => `  - ${t.id} (${t.role}): ${t.mission}`)
      .join("\n");
    this.askPmAgentToChat(
      `[EVENT] Planner가 ${plan.tasks.length}개의 서브태스크로 분해했습니다:\n${planForAgent}\n\n이제 워커들을 띄울 거라고, 어떤 워커가 무얼 맡는지 한두 문장으로 사용자에게 자연스럽게 설명하세요.`
    );

    // NEEDS_USER_INPUT 태스크 체크
    const needsInput = plan.tasks.find((t) => t.description.includes("NEEDS_USER_INPUT"));
    if (needsInput) {
      const gatherTasks = plan.tasks.filter(
        (t) => !t.description.includes("NEEDS_USER_INPUT") || t.dependsOn.length === 0
      );
      await this.executeTasks(gatherTasks);
      return;
    }

    this.state.status = "executing";
    this.emit("state");
    await this.executeTasks(plan.tasks);
  }

  // ─── 태스크 실행 ───
  private async executeTasks(tasks: SubTask[]) {
    this.state.status = "executing";
    this.emit("state");

    for (const task of tasks) {
      this.state.workers.set(task.id, {
        taskId: task.id,
        role: task.role,
        mission: task.mission,
        status: "pending",
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        model: task.model || this.config.defaultModel,
        startTime: null,
        durationMs: 0,
        currentTool: null,
        filesChanged: [],
        plan: [],
        currentStepIndex: null,
        currentStepTitle: null,
        stolenSteps: [],
        broadcasts: [],
        recentAsks: [],
        logs: [],
      });
      // MCP에 워커 등록
      this.mcp?.registerWorker(task.id, task.role, task.mission);
    }
    this.emit("state");

    const results: WorkerResult[] = [];
    const running = new Set<Promise<void>>();

    const runOne = async (task: SubTask) => {
      const w = this.state.workers.get(task.id)!;
      w.status = "running";
      w.startTime = Date.now();
      w.logs.push({ time: Date.now(), type: "init", message: `시작 — ${task.role}: ${task.mission}` });
      this.askPmAgentToChat(
        `[EVENT] 워커 ${task.id}(${task.role})가 작업을 시작했습니다. 미션: ${task.mission}. 사용자에게 한 줄로 알리세요.`
      );
      this.emit("state");

      const predecessorOutputs = new Map<string, string>();
      for (const depId of task.dependsOn) {
        const depResult = results.find((r) => r.taskId === depId);
        if (depResult?.success) {
          predecessorOutputs.set(depId, depResult.output);
        }
      }

      const result = await runWorker({
        task,
        config: this.config,
        workingDirectory: this.workingDirectory,
        mcpConfigPath: this.mcp?.configPath,
        predecessorOutputs: predecessorOutputs.size > 0 ? predecessorOutputs : undefined,
        onEvent: (taskId, event) => this.handleWorkerEvent(taskId, event),
      });

      results.push(result);
      w.status = result.success ? "done" : "failed";
      w.costUsd = result.costUsd;
      w.durationMs = result.durationMs;
      w.filesChanged = result.filesChanged;
      if (result.usage) {
        w.inputTokens = result.usage.inputTokens;
        w.outputTokens = result.usage.outputTokens;
      }
      w.currentTool = null;
      this.mcp?.markWorkerStatus(task.id, result.success ? "done" : "failed");

      this.state.totalCostUsd = [...this.state.workers.values()].reduce((s, ww) => s + ww.costUsd, 0);

      if (result.success) {
        w.logs.push({
          time: Date.now(),
          type: "done",
          message: `완료 (${(result.durationMs / 1000).toFixed(1)}초, $${result.costUsd.toFixed(4)}, 변경 파일 ${result.filesChanged.length}개)`,
        });
        if (result.output && result.output.length > 10) {
          this.addChat("worker", result.output.slice(0, 3000), "result", task.id);
        }
        const filesInfo = result.filesChanged.length > 0 ? ` 변경 파일: ${result.filesChanged.join(", ")}` : "";
        this.askPmAgentToChat(
          `[EVENT] 워커 ${task.id}(${task.role})가 완료했습니다 (${(result.durationMs / 1000).toFixed(1)}초, $${result.costUsd.toFixed(4)}).${filesInfo}\n핵심 결정: ${result.decisions.join(" | ") || "없음"}\n\n사용자에게 어떤 작업이 끝났는지 한두 문장으로 알리세요.`
        );
      } else {
        w.logs.push({
          time: Date.now(),
          type: "error",
          message: `실패: ${result.output.slice(0, 300)}`,
        });
        this.askPmAgentToChat(
          `[EVENT] 워커 ${task.id}(${task.role})가 실패했습니다. 에러: ${result.output.slice(0, 300)}\n사용자에게 상황 알리고, 다음에 어떻게 할지 짧게 제안하세요.`
        );
      }
      this.emit("state");
    };

    // 의존성 인지 병렬 실행
    const completed = new Set<string>();
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const remaining = new Set(tasks.map((t) => t.id));

    while (remaining.size > 0) {
      const ready: SubTask[] = [];
      for (const id of remaining) {
        const task = taskMap.get(id)!;
        const depsReady = task.dependsOn.every((d) => completed.has(d) || !remaining.has(d));
        if (depsReady && running.size < this.config.concurrency) {
          ready.push(task);
        }
      }

      if (ready.length === 0 && running.size === 0) {
        // 데드락/순환 — 나머지 전부 강제 실행
        for (const id of remaining) ready.push(taskMap.get(id)!);
      }

      if (ready.length === 0) {
        await Promise.race([...running]);
        continue;
      }

      for (const task of ready) {
        remaining.delete(task.id);
        const p = runOne(task).then(() => {
          completed.add(task.id);
          running.delete(p);
        });
        running.add(p);
      }

      if (running.size >= this.config.concurrency || remaining.size === 0) {
        await Promise.race([...running]);
      }
    }

    await Promise.all([...running]);
    await this.summarizeResults(results);
  }

  // ─── 워커 스트림 이벤트 (Claude CLI에서 직접 오는 것) ───
  private handleWorkerEvent(taskId: string, event: StreamEvent) {
    const w = this.state.workers.get(taskId);
    if (!w) return;

    if (event.type === "tool_use") {
      w.currentTool = String(event.tool);
      const toolName = String(event.tool);
      // MCP 툴 호출은 별도 이벤트로 이미 처리되므로 로그 생략
      if (!toolName.startsWith("mcp__furyclaw__")) {
        w.logs.push({ time: Date.now(), type: "tool", message: `툴: ${toolName}` });
      }
    }
    if (event.type === "progress") {
      w.logs.push({
        time: Date.now(),
        type: "text",
        message: event.text.length > 500 ? event.text.slice(0, 500) + "…" : event.text,
      });
    }
    if (event.type === "cost") {
      w.costUsd = event.costUsd;
      this.state.totalCostUsd = [...this.state.workers.values()].reduce((s, ww) => s + ww.costUsd, 0);
    }
    if (event.type === "usage") {
      w.inputTokens += event.inputTokens;
      w.outputTokens += event.outputTokens;
      w.cacheReadTokens += event.cacheReadTokens;
      w.cacheCreationTokens += event.cacheCreationTokens;
      if (event.model) w.model = event.model;
      if (w.status === "running") {
        w.costUsd = estimateCost(w);
        this.state.totalCostUsd = [...this.state.workers.values()].reduce((s, ww) => s + ww.costUsd, 0);
      }
    }
    if (event.type === "rate_limit") {
      w.logs.push({ time: Date.now(), type: "warn", message: "레이트 리밋 대기…" });
    }
    this.emit("state");
  }

  // ─── MCP 이벤트 → 상태 업데이트 & PM 반응 ───
  private wireMCPEvents(mcp: MCPServer) {
    mcp.events.on("event", (ev: MCPEvent) => this.handleMCPEvent(mcp, ev));
  }

  private handleMCPEvent(mcp: MCPServer, ev: MCPEvent) {
    switch (ev.type) {
      case "plan": {
        const w = this.state.workers.get(ev.taskId);
        if (w) {
          w.plan = ev.steps.map((title, i) => ({ index: i + 1, title, status: "pending" as const }));
          w.logs.push({
            time: Date.now(),
            type: "plan",
            message: `플랜 선언 (${ev.steps.length}단계):\n${ev.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`,
          });
        }
        this.askPmAgentToChat(
          `[EVENT] 워커 ${ev.taskId}가 플랜을 선언했습니다 (${ev.steps.length}단계):\n${ev.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}\n\n사용자에게 어떤 플랜인지 한두 문장으로 요약해서 알리세요.`
        );
        this.emit("state");
        break;
      }
      case "step": {
        const w = this.state.workers.get(ev.taskId);
        if (w) {
          // plan 엔트리 동기화
          let step = w.plan.find((s) => s.index === ev.index);
          if (!step) {
            // 플랜이 먼저 선언되지 않은 경우 즉석 추가
            while (w.plan.length < ev.total) {
              w.plan.push({ index: w.plan.length + 1, title: `(미선언 스텝 ${w.plan.length + 1})`, status: "pending" });
            }
            step = w.plan.find((s) => s.index === ev.index) ?? {
              index: ev.index,
              title: ev.title,
              status: "pending",
            };
            if (!w.plan.find((s) => s.index === ev.index)) w.plan.push(step);
          }
          // 이전 running 스텝을 done으로
          for (const s of w.plan) {
            if (s.status === "running" && s.index !== ev.index) s.status = "done";
          }
          step.title = ev.title;
          step.status = "running";
          w.currentStepIndex = ev.index;
          w.currentStepTitle = ev.title;
          w.logs.push({
            time: Date.now(),
            type: "step",
            message: `스텝 ${ev.index}/${ev.total} 진입: ${ev.title}`,
          });
        }
        this.emit("state");
        break;
      }
      case "step_done": {
        const w = this.state.workers.get(ev.taskId);
        if (w) {
          const step = w.plan.find((s) => s.index === ev.index);
          if (step) step.status = "done";
          w.logs.push({
            time: Date.now(),
            type: "step_done",
            message: `스텝 ${ev.index} 완료: ${ev.title}`,
          });
        }
        this.emit("state");
        break;
      }
      case "task_done": {
        // 워커가 스스로 완료 신호 — 실제 종료는 runWorker 반환 시 처리되므로 여기선 로그만
        const w = this.state.workers.get(ev.taskId);
        if (w) {
          w.logs.push({
            time: Date.now(),
            type: "task_done",
            message: ev.summary ? `작업 완료 신호: ${ev.summary}` : "작업 완료 신호",
          });
        }
        this.emit("state");
        break;
      }
      case "broadcast": {
        const w = this.state.workers.get(ev.from);
        if (w) {
          w.broadcasts.push({ at: Date.now(), message: ev.message });
          w.logs.push({
            time: Date.now(),
            type: "broadcast",
            message: `📢 ${ev.message}`,
          });
        }
        this.addChat("worker", `📢 ${ev.message}`, "broadcast", ev.from);
        this.askPmAgentToChat(
          `[BROADCAST from ${ev.from}] ${ev.message}\n\n이 공유가 사용자에게 의미 있으면 한 줄로 전달, 아니면 무시하세요.`
        );
        this.emit("state");
        break;
      }
      case "ask_pm": {
        const w = this.state.workers.get(ev.from);
        if (w) {
          w.recentAsks.push({ at: Date.now(), type: "ask_pm", question: ev.question });
          w.logs.push({
            time: Date.now(),
            type: "ask_pm",
            message: `→ PM: ${ev.question}`,
          });
        }
        this.addChat("worker", `❓ PM에게 질문: ${ev.question}`, "ask", ev.from);
        this.emit("state");

        const context = this.buildContextBlock();
        const prompt = `${context}\n\n[WORKER ${ev.from} ASK_PM] ${ev.question}\n\n워커에게 줄 답변을 바로 한국어로 작성하세요. 1-3문장 권장, 추측 시 그 사실을 명시.`;
        this.pmAgent.ask(prompt)
          .then((answer) => {
            const finalAnswer = answer.trim() || "PM 응답 없음";
            mcp.resolveAskPm(ev.id, finalAnswer);
            // 로그/상태 업데이트
            const wrk = this.state.workers.get(ev.from);
            if (wrk) {
              const last = wrk.recentAsks[wrk.recentAsks.length - 1];
              if (last && last.type === "ask_pm" && !last.answer) last.answer = finalAnswer;
              wrk.logs.push({ time: Date.now(), type: "ask_pm_answer", message: `← PM: ${finalAnswer.slice(0, 200)}` });
            }
            this.addChat("pm", `→ ${ev.from}: ${finalAnswer}`, "message");
            this.emit("state");
          })
          .catch((err) => {
            mcp.resolveAskPm(ev.id, `PM 응답 실패: ${err instanceof Error ? err.message : err}`);
          });
        break;
      }
      case "ask_worker": {
        const w = this.state.workers.get(ev.from);
        if (w) {
          w.recentAsks.push({ at: Date.now(), type: "ask_worker", target: ev.target, question: ev.question });
          w.logs.push({
            time: Date.now(),
            type: "ask_worker",
            message: `→ ${ev.target}: ${ev.question}`,
          });
        }
        this.addChat("worker", `❓ ${ev.from} → ${ev.target}: ${ev.question}`, "ask", ev.from);
        this.emit("state");

        const targetRuntime = mcp.getWorker(ev.target);
        const targetIsActive =
          targetRuntime && targetRuntime.status === "running";
        const context = this.buildContextBlock();
        const prompt = `${context}\n\n[WORKER ${ev.from} ASK_WORKER ${ev.target}${targetIsActive ? ", Y IS RUNNING" : ""}] ${ev.question}\n\n${targetIsActive ? "대상 워커가 진행 중이라 당신이 대리로 답변합니다. [CONTEXT]에 있는 대상 워커의 플랜·현재 스텝을 바탕으로 합리적으로 답하세요." : "대상 워커가 진행 중이 아니므로 [CONTEXT] 정보로 가능한 범위에서 답하거나 모른다고 솔직히 말하세요."}`;
        this.pmAgent.ask(prompt)
          .then((answer) => {
            const finalAnswer = answer.trim() || "응답 없음";
            mcp.resolveAskWorker(ev.id, finalAnswer);
            const wrk = this.state.workers.get(ev.from);
            if (wrk) {
              const last = wrk.recentAsks[wrk.recentAsks.length - 1];
              if (last && last.type === "ask_worker" && !last.answer) last.answer = finalAnswer;
              wrk.logs.push({ time: Date.now(), type: "ask_worker_answer", message: `← ${ev.target}(대리): ${finalAnswer.slice(0, 200)}` });
            }
            this.addChat("pm", `→ ${ev.from} (${ev.target} 대리): ${finalAnswer}`, "message");
            this.emit("state");
          })
          .catch((err) => {
            mcp.resolveAskWorker(ev.id, `대리 응답 실패: ${err instanceof Error ? err.message : err}`);
          });
        break;
      }
      case "claim_step": {
        const fromW = this.state.workers.get(ev.from);
        const targetW = this.state.workers.get(ev.target);
        const verb = ev.granted ? "가져감" : "거절됨";
        if (fromW) {
          fromW.logs.push({
            time: Date.now(),
            type: "claim",
            message: `${ev.target} 스텝 ${ev.stepIndex}(${ev.stepTitle}) ${verb}${ev.reason ? ` — ${ev.reason}` : ""}`,
          });
          if (ev.granted) {
            fromW.stolenSteps.push({ from: ev.target, index: ev.stepIndex, title: ev.stepTitle, at: Date.now() });
          }
        }
        if (targetW && ev.granted) {
          const step = targetW.plan.find((s) => s.index === ev.stepIndex);
          if (step) {
            step.status = "stolen";
            step.claimedBy = ev.from;
          }
          targetW.logs.push({
            time: Date.now(),
            type: "stolen",
            message: `스텝 ${ev.stepIndex}(${ev.stepTitle})를 ${ev.from}가 가져감`,
          });
        }
        if (ev.granted) {
          this.askPmAgentToChat(
            `[EVENT] 워커 ${ev.from}가 ${ev.target}의 스텝 ${ev.stepIndex}(${ev.stepTitle})를 가져갔습니다 (work-stealing). 사용자에게 짧게 알리세요.`
          );
        }
        this.emit("state");
        break;
      }
    }
  }

  // ─── PMAgent에 넘길 [CONTEXT] 블록 ───
  private buildContextBlock(): string {
    const workers = [...this.state.workers.values()];
    if (workers.length === 0) {
      return `[CONTEXT]\n현재 실행 중인 워커 없음. 상태=${this.state.status}.`;
    }

    const counts = {
      running: workers.filter((w) => w.status === "running").length,
      done: workers.filter((w) => w.status === "done").length,
      failed: workers.filter((w) => w.status === "failed").length,
      pending: workers.filter((w) => w.status === "pending").length,
      waiting: workers.filter((w) => w.status === "waiting").length,
    };

    const lines: string[] = [];
    lines.push("[CONTEXT]");
    lines.push(
      `전체 진행도: 실행 ${counts.running} / 완료 ${counts.done} / 실패 ${counts.failed} / 대기 ${counts.pending} (총 ${workers.length}개)`
    );
    lines.push(`PM 상태: ${this.state.status}. 누적 비용: $${this.state.totalCostUsd.toFixed(4)}.`);
    lines.push("");

    for (const w of workers) {
      const head = `## 워커 ${w.taskId} [${w.role}] — ${w.status}`;
      lines.push(head);
      lines.push(`미션: ${w.mission}`);

      if (w.plan.length > 0) {
        const progress =
          w.currentStepIndex !== null
            ? `현재 ${w.currentStepIndex}/${w.plan.length}: ${w.currentStepTitle ?? ""}`
            : w.status === "done"
              ? `완료 (${w.plan.length}/${w.plan.length})`
              : `${w.plan.filter((s) => s.status === "done").length}/${w.plan.length} 완료`;
        lines.push(`진행: ${progress}`);
        lines.push("플랜:");
        for (const s of w.plan) {
          const marker =
            s.status === "done" ? "✅" : s.status === "running" ? "▶️" : s.status === "stolen" ? `🫳${s.claimedBy}` : "⬜";
          lines.push(`  ${marker} ${s.index}. ${s.title}`);
        }
      } else {
        lines.push(`플랜: (아직 선언 안 됨)`);
      }

      if (w.stolenSteps.length > 0) {
        lines.push(`훔쳐온 스텝: ${w.stolenSteps.map((s) => `${s.from}#${s.index}`).join(", ")}`);
      }

      // 최근 로그 (스텝/툴/broadcast/ask 중심으로 최근 8개)
      const relevantLogs = w.logs
        .filter((l) =>
          [
            "step",
            "step_done",
            "tool",
            "broadcast",
            "ask_pm",
            "ask_worker",
            "ask_pm_answer",
            "ask_worker_answer",
            "claim",
            "stolen",
            "done",
            "error",
            "task_done",
          ].includes(l.type)
        )
        .slice(-8);
      if (relevantLogs.length > 0) {
        lines.push("최근 활동:");
        for (const l of relevantLogs) {
          lines.push(`  - [${l.type}] ${l.message.replace(/\n/g, " ").slice(0, 240)}`);
        }
      }

      // 최근 broadcast 따로 노출 (사용자가 "어떤 공유가 있었어?" 물을 수 있음)
      if (w.broadcasts.length > 0) {
        const recent = w.broadcasts.slice(-3);
        lines.push("최근 broadcast:");
        for (const b of recent) {
          lines.push(`  - ${b.message.slice(0, 200)}`);
        }
      }

      if (w.filesChanged.length > 0) {
        lines.push(`변경 파일: ${w.filesChanged.join(", ")}`);
      }
      lines.push("");
    }

    return lines.join("\n").trim();
  }

  // ─── 사용자에게 질문 (외부에서 호출 가능) ───
  async askUser(question: string, choices?: string[]): Promise<string> {
    const msg: ChatMessage = {
      id: Date.now().toString(36),
      time: Date.now(),
      from: "pm",
      text: question,
      type: "question",
      choices,
      requiresResponse: true,
    };
    this.state.chat.push(msg);
    this.state.pendingQuestion = msg;
    this.state.status = "waiting_user";
    this.emit("state");

    return new Promise((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  // ─── 최종 요약 ───
  private async summarizeResults(results: WorkerResult[]) {
    const allSucceeded = results.every((r) => r.success);

    const lines: string[] = [];
    for (const r of results) {
      const task = this.state.plan?.tasks.find((t) => t.id === r.taskId);
      const status = r.success ? "✓" : "✗";
      lines.push(
        `${status} ${r.taskId} (${task?.role ?? "?"}): 변경 파일 ${r.filesChanged.length}개${
          r.filesChanged.length > 0 ? ` [${r.filesChanged.join(", ")}]` : ""
        }`
      );
      if (r.notes.length > 0) {
        lines.push(`    메모: ${r.notes.join(" | ")}`);
      }
    }

    const systemSummary = allSucceeded
      ? `🎉 ${results.length}개 워커 모두 성공\n${lines.join("\n")}`
      : `⚠️ 일부 실패\n${lines.join("\n")}`;
    this.addChat("system", systemSummary, "result");

    this.state.status = "done";
    this.emit("state");

    // PMAgent가 사람용 최종 브리핑
    this.askPmAgentToChat(
      `[EVENT] 전체 작업이 마무리됐습니다. 결과:\n${lines.join("\n")}\n총 비용 $${this.state.totalCostUsd.toFixed(4)}.\n\n사용자에게 무엇이 끝났고 결과적으로 뭐가 된 건지 자연스럽게 정리 (2-4문장). 다음 할 일이 있으면 1문장으로 제안.`
    );
  }

  // ─── 헬퍼 ───
  private addChat(
    from: ChatMessage["from"],
    text: string,
    type: ChatMessage["type"],
    workerId?: string
  ): string {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    this.state.chat.push({
      id,
      time: Date.now(),
      from,
      workerId,
      text,
      type,
    });
    this.emit("state");
    return id;
  }
}
