/**
 * FuryClaw MCP 허브
 *
 * 워커 간/워커-PM 소통, 플랜/스텝 추적, 조율(work-stealing)의 중앙 상태 저장소.
 * HTTP + JSON-RPC(MCP 호환) 서버로 동작하며, Claude Code CLI 워커가
 * `mcp__furyclaw__<tool>` 형태로 호출한다.
 *
 * 핵심 툴:
 *  - report_plan      워커가 착수 직후 자신의 상세 플랜(단계 배열) 선언
 *  - report_step      단계 진입 시 현재 위치(index/total/title) 보고
 *  - report_done      작업 완료 신호
 *  - ask_pm           PM에게 질의(블로킹). PM이 한국어로 답 주면 응답 반환.
 *  - ask_worker       다른 워커에게 질의(블로킹). 대상이 실행 중이면 PM이 대리 응답.
 *  - broadcast        팀 전체에 공유 (채팅/로그에 기록)
 *  - list_workers     다른 워커들의 플랜/현재 단계/상태를 조회 (중복 방지·조율용)
 *  - claim_step       다른 워커의 특정 스텝을 가져오기(work-stealing). 원자적 할당.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── 타입 ───

export interface PlanStep {
  index: number;       // 1-based
  title: string;
  status: "pending" | "running" | "done" | "stolen";
  claimedBy?: string;  // 다른 워커가 가져간 경우 그 워커의 taskId
  startedAt?: number;
  finishedAt?: number;
}

export interface WorkerRuntime {
  taskId: string;
  role: string;
  mission: string;
  status: "idle" | "running" | "done" | "failed";
  plan: PlanStep[];
  currentStepIndex: number | null;   // 1-based
  broadcasts: Array<{ at: number; message: string }>;
  lastActivityAt: number;
  // 작업 추가 기록: 다른 워커로부터 훔쳐온 스텝
  stolenSteps: Array<{ from: string; index: number; title: string; at: number }>;
}

export type MCPEvent =
  | { type: "plan"; taskId: string; steps: string[] }
  | { type: "step"; taskId: string; index: number; total: number; title: string }
  | { type: "step_done"; taskId: string; index: number; title: string }
  | { type: "task_done"; taskId: string; summary?: string }
  | { type: "broadcast"; from: string; message: string }
  | { type: "ask_pm"; id: string; from: string; question: string }
  | {
      type: "ask_worker";
      id: string;
      from: string;
      target: string;
      question: string;
    }
  | {
      type: "claim_step";
      from: string;
      target: string;
      stepIndex: number;
      stepTitle: string;
      granted: boolean;
      reason?: string;
    };

export interface MCPServer {
  port: number;
  configPath: string;
  events: EventEmitter; // emits "event" with MCPEvent
  registerWorker(taskId: string, role: string, mission: string): void;
  markWorkerStatus(taskId: string, status: WorkerRuntime["status"]): void;
  resolveAskPm(id: string, answer: string): void;
  resolveAskWorker(id: string, answer: string): void;
  snapshot(): WorkerRuntime[];
  getWorker(taskId: string): WorkerRuntime | undefined;
  /** 작업 간 상태 리셋 — 새 작업 시작 시 이전 워커 기록 제거. */
  reset(): void;
  stop(): Promise<void>;
}

// ─── 툴 정의 (단일 진실 원천) ───
// 워커 시스템 프롬프트·MCP tools/list 응답·워커 허용 목록이 모두 여기서 파생됨.
// 툴을 추가/변경하려면 이 배열만 수정 + 서버 switch의 처리 함수만 추가.

export interface ToolDef {
  name: string;
  /** MCP tools/list 및 워커 시스템 프롬프트에 노출되는 설명. 예시·호출 타이밍·주의사항 등 풍부하게. */
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** 블로킹 호출 여부 — 워커 프롬프트에서 강조됨 */
  blocking?: boolean;
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "report_plan",
    description:
      "작업 시작 직후 **가장 먼저** 호출. 수행할 단계를 구체적으로 3~7개로 분해해 배열(steps)로 선언. PM/다른 워커가 당신의 진행도를 실시간 추적할 수 있게 됨.\n" +
      "좋은 예: steps=[\"types/task.ts에서 SubTask 스키마 읽기\", \"ownFiles 필드 추가\", \"테스트 작성\", \"빌드 검증\"]\n" +
      "나쁜 예: steps=[\"작업하기\", \"마무리\"] — 너무 추상적.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "자신의 task id" },
        steps: {
          type: "array",
          items: { type: "string" },
          description: "수행할 단계 제목 배열 (3~7개 권장, 구체적으로)",
        },
      },
      required: ["task_id", "steps"],
    },
  },
  {
    name: "report_step",
    description:
      "각 스텝에 진입할 때 호출. current는 1-based. 이전 스텝은 자동 완료 처리됨.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        current: { type: "integer", description: "현재 스텝 번호 (1부터)" },
        total: { type: "integer", description: "전체 스텝 수" },
        title: { type: "string", description: "현재 스텝 제목" },
      },
      required: ["task_id", "current", "title"],
    },
  },
  {
    name: "report_done",
    description:
      "전체 작업이 끝나면 호출. 마지막 진행 중 스텝도 자동 완료 처리.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        summary: { type: "string", description: "선택: 결과 한 줄 요약" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "ask_pm",
    blocking: true,
    description:
      "PM에게 판단·정보 질의 (블로킹, 답이 올 때까지 대기). 애매한 결정, 누락된 요구사항, 외부 지식 필요 시 사용. 1~3문장으로 구체적으로.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "자신의 task id" },
        question: { type: "string", description: "구체적인 질문 (한국어)" },
      },
      required: ["from", "question"],
    },
  },
  {
    name: "ask_worker",
    blocking: true,
    description:
      "다른 워커에게 질의 (블로킹). 대상이 바쁘면 PM이 대상의 플랜·진행 상황을 바탕으로 대리 응답.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "자신의 task id" },
        target: { type: "string", description: "대상 워커의 task id" },
        question: { type: "string" },
      },
      required: ["from", "target", "question"],
    },
  },
  {
    name: "broadcast",
    description:
      "팀 전체(PM + 다른 워커)에 공유할 중요 결정·발견·차단 요인을 알림. 비블로킹.\n" +
      "예: \"api/user.ts의 User 타입이 바뀌어서 다른 곳도 영향 있을 수 있음\".",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        message: { type: "string" },
      },
      required: ["from", "message"],
    },
  },
  {
    name: "list_workers",
    description:
      "다른 워커들의 플랜·현재 스텝·상태를 조회. 다음 시점에 **반드시** 호출:\n" +
      "- report_plan 전 (중복 태스크 방지)\n" +
      "- 내 작업이 빨리 끝나서 여유가 있을 때 (훔쳐올 스텝 탐색)\n" +
      "- 내가 필요한 정보를 다른 워커가 이미 만들었을 가능성이 있을 때",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "claim_step",
    description:
      "다른 워커의 pending 스텝을 가져와 내가 대신 수행 (work-stealing). 원자적 할당.\n" +
      "사용 시점: 내 작업이 먼저 끝났고 다른 워커가 느리거나 스텝이 많을 때, list_workers로 pending 스텝 확인 → 이 툴로 가져오기.\n" +
      "granted=false면 포기하고 다른 방법 찾기. running/done 스텝은 거절됨.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "자신의 task id" },
        target: { type: "string", description: "가져올 스텝의 원래 워커" },
        step_index: { type: "integer", description: "가져올 스텝 번호 (1-based)" },
      },
      required: ["from", "target", "step_index"],
    },
  },
];

/** Claude Code 워커 allowlist용 `mcp__furyclaw__*` 풀네임 배열. */
export const MCP_TOOL_ALLOWLIST: string[] = TOOL_DEFS.map(
  (t) => `mcp__furyclaw__${t.name}`
);

/** 블로킹 호출로 취급되는 툴 이름 집합. HTTP 응답을 홀드해야 함. */
export const BLOCKING_TOOLS: Set<string> = new Set(
  TOOL_DEFS.filter((t) => t.blocking).map((t) => t.name)
);

// ─── 서버 ───

export async function startMCPServer(preferredPort = 39999): Promise<MCPServer> {
  const events = new EventEmitter();
  const workers = new Map<string, WorkerRuntime>();
  // 블로킹 ask_pm/ask_worker 요청의 HTTP 응답 라이터를 ID로 보관
  const pendingAsks = new Map<string, (answer: string) => void>();
  let askCounter = 0;

  function now() {
    return Date.now();
  }

  function ensureWorker(taskId: string, role = "unknown", mission = ""): WorkerRuntime {
    let w = workers.get(taskId);
    if (!w) {
      w = {
        taskId,
        role,
        mission,
        status: "running",
        plan: [],
        currentStepIndex: null,
        broadcasts: [],
        lastActivityAt: now(),
        stolenSteps: [],
      };
      workers.set(taskId, w);
    }
    return w;
  }

  function emit(ev: MCPEvent) {
    events.emit("event", ev);
  }

  // ─── 툴 구현 ───

  function reportPlan(input: Record<string, unknown>) {
    const taskId = String(input.task_id ?? "");
    const stepsRaw = Array.isArray(input.steps) ? (input.steps as unknown[]) : [];
    const steps = stepsRaw.map((s) => String(s)).filter(Boolean);
    if (!taskId || steps.length === 0) {
      return { ok: false, error: "task_id와 steps(배열)가 필요합니다" };
    }
    const w = ensureWorker(taskId);
    w.plan = steps.map<PlanStep>((title, i) => ({
      index: i + 1,
      title,
      status: "pending",
    }));
    w.currentStepIndex = null;
    w.lastActivityAt = now();
    emit({ type: "plan", taskId, steps });
    return { ok: true, received: steps.length };
  }

  function reportStep(input: Record<string, unknown>) {
    const taskId = String(input.task_id ?? "");
    const index = Number(input.current ?? input.index ?? 0);
    const total = Number(input.total ?? 0);
    const title = String(input.title ?? "");
    if (!taskId || !index) {
      return { ok: false, error: "task_id, current(1-based index), title 필요" };
    }
    const w = ensureWorker(taskId);

    // 이전 스텝을 완료 처리
    if (w.currentStepIndex && w.currentStepIndex !== index) {
      const prev = w.plan.find((s) => s.index === w.currentStepIndex);
      if (prev && prev.status === "running") {
        prev.status = "done";
        prev.finishedAt = now();
        emit({ type: "step_done", taskId, index: prev.index, title: prev.title });
      }
    }

    // 플랜이 report_plan 없이 온 경우, 스텝 엔트리를 즉석 생성
    let step = w.plan.find((s) => s.index === index);
    if (!step) {
      // total이 주어졌고 플랜보다 크면 플랜 확장
      if (total > w.plan.length) {
        for (let i = w.plan.length + 1; i <= total; i++) {
          w.plan.push({ index: i, title: i === index ? title : `(미선언 스텝 ${i})`, status: "pending" });
        }
      } else {
        w.plan.push({ index, title, status: "pending" });
      }
      step = w.plan.find((s) => s.index === index)!;
    }

    step.title = title || step.title;
    step.status = "running";
    step.startedAt = now();
    w.currentStepIndex = index;
    w.lastActivityAt = now();

    const totalForEmit = total || w.plan.length;
    emit({ type: "step", taskId, index, total: totalForEmit, title: step.title });
    return { ok: true };
  }

  function reportDone(input: Record<string, unknown>) {
    const taskId = String(input.task_id ?? "");
    const summary = input.summary ? String(input.summary) : undefined;
    if (!taskId) return { ok: false, error: "task_id 필요" };
    const w = ensureWorker(taskId);
    // 진행 중 스텝 완료 처리
    if (w.currentStepIndex) {
      const cur = w.plan.find((s) => s.index === w.currentStepIndex);
      if (cur && cur.status === "running") {
        cur.status = "done";
        cur.finishedAt = now();
      }
    }
    w.currentStepIndex = null;
    w.lastActivityAt = now();
    emit({ type: "task_done", taskId, summary });
    return { ok: true };
  }

  function broadcast(input: Record<string, unknown>) {
    const from = String(input.from ?? "unknown");
    const message = String(input.message ?? "").trim();
    if (!message) return { ok: false, error: "message 필요" };
    const w = ensureWorker(from);
    w.broadcasts.push({ at: now(), message });
    w.lastActivityAt = now();
    emit({ type: "broadcast", from, message });
    return { ok: true };
  }

  function listWorkers() {
    return {
      workers: [...workers.values()].map((w) => ({
        task_id: w.taskId,
        role: w.role,
        mission: w.mission,
        status: w.status,
        current_step: w.currentStepIndex
          ? {
              index: w.currentStepIndex,
              total: w.plan.length,
              title: w.plan.find((s) => s.index === w.currentStepIndex)?.title ?? "",
            }
          : null,
        plan: w.plan.map((s) => ({
          index: s.index,
          title: s.title,
          status: s.status,
          claimed_by: s.claimedBy,
        })),
      })),
    };
  }

  function claimStep(input: Record<string, unknown>) {
    const from = String(input.from ?? "");
    const target = String(input.target ?? input.target_task_id ?? "");
    const stepIndex = Number(input.step_index ?? input.index ?? 0);
    if (!from || !target || !stepIndex) {
      return { granted: false, error: "from, target, step_index 필요" };
    }
    const targetW = workers.get(target);
    if (!targetW) {
      return { granted: false, error: `대상 워커 '${target}' 미등록` };
    }
    const step = targetW.plan.find((s) => s.index === stepIndex);
    if (!step) {
      return { granted: false, error: `스텝 ${stepIndex} 없음` };
    }
    if (step.status === "done") {
      emit({
        type: "claim_step",
        from,
        target,
        stepIndex,
        stepTitle: step.title,
        granted: false,
        reason: "이미 완료된 스텝",
      });
      return { granted: false, error: "이미 완료된 스텝" };
    }
    if (step.status === "running") {
      emit({
        type: "claim_step",
        from,
        target,
        stepIndex,
        stepTitle: step.title,
        granted: false,
        reason: "대상 워커가 진행 중",
      });
      return { granted: false, error: "대상 워커가 이 스텝을 진행 중" };
    }
    if (step.status === "stolen") {
      return { granted: false, error: `이미 ${step.claimedBy}가 가져감` };
    }
    // grant
    step.status = "stolen";
    step.claimedBy = from;
    const claimer = ensureWorker(from);
    claimer.stolenSteps.push({ from: target, index: stepIndex, title: step.title, at: now() });
    emit({
      type: "claim_step",
      from,
      target,
      stepIndex,
      stepTitle: step.title,
      granted: true,
    });
    return { granted: true, step: { index: step.index, title: step.title } };
  }

  // ask_pm / ask_worker는 응답을 반환할 때까지 HTTP 응답을 홀드한다.
  function startAsk(
    type: "ask_pm" | "ask_worker",
    input: Record<string, unknown>,
    resolver: (answer: string) => void
  ) {
    askCounter++;
    const id = `${type}-${Date.now().toString(36)}-${askCounter}`;
    pendingAsks.set(id, resolver);
    const from = String(input.from ?? "unknown");
    ensureWorker(from);
    if (type === "ask_pm") {
      const question = String(input.question ?? "").trim();
      emit({ type: "ask_pm", id, from, question });
    } else {
      const target = String(input.target ?? input.target_worker_id ?? "");
      const question = String(input.question ?? "").trim();
      emit({ type: "ask_worker", id, from, target, question });
    }
    return id;
  }

  // ─── HTTP 처리 ───

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // GET /health — 개발용
    if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ ok: true, workers: workers.size, pendingAsks: pendingAsks.size })
      );
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let parsed: { id?: unknown; method?: string; params?: Record<string, unknown> };
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Invalid JSON" } }));
        return;
      }

      const jsonrpcId = parsed.id ?? null;

      if (parsed.method === "initialize") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: jsonrpcId,
            result: {
              protocolVersion: "2024-11-05",
              serverInfo: { name: "furyclaw", version: "0.1.0" },
              capabilities: { tools: {} },
            },
          })
        );
        return;
      }

      if (parsed.method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: jsonrpcId,
            result: { tools: TOOL_DEFS },
          })
        );
        return;
      }

      if (parsed.method === "tools/call") {
        const name = String(parsed.params?.name ?? "");
        const args = (parsed.params?.arguments ?? {}) as Record<string, unknown>;

        // 블로킹 툴 (TOOL_DEFS.blocking===true): 응답을 PM이 resolve할 때까지 홀드
        if (BLOCKING_TOOLS.has(name)) {
          const id = startAsk(name as "ask_pm" | "ask_worker", args, (answer) => {
            pendingAsks.delete(id);
            if (res.writableEnded || res.destroyed) return;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: jsonrpcId,
                result: {
                  content: [
                    { type: "text", text: JSON.stringify({ answer }) },
                  ],
                },
              })
            );
          });
          // 응답(res) 연결이 끊기면 pending 정리 (leak 방지).
          // req.on("close")는 body 수신 완료 시점에도 fire돼서 사용 불가.
          res.on("close", () => {
            if (pendingAsks.has(id)) pendingAsks.delete(id);
          });
          return;
        }

        // 즉시 응답 툴
        let toolResult: unknown;
        try {
          switch (name) {
            case "report_plan":
              toolResult = reportPlan(args);
              break;
            case "report_step":
              toolResult = reportStep(args);
              break;
            case "report_done":
              toolResult = reportDone(args);
              break;
            case "broadcast":
              toolResult = broadcast(args);
              break;
            case "list_workers":
              toolResult = listWorkers();
              break;
            case "claim_step":
              toolResult = claimStep(args);
              break;
            default:
              toolResult = { error: `알 수 없는 툴: ${name}` };
          }
        } catch (err) {
          toolResult = { error: String(err instanceof Error ? err.message : err) };
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: jsonrpcId,
            result: {
              content: [{ type: "text", text: JSON.stringify(toolResult) }],
            },
          })
        );
        return;
      }

      // notifications/initialized 등: 빈 응답
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: jsonrpcId, result: {} }));
    });
  });

  return new Promise((resolve) => {
    server.listen(preferredPort, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const configPath = writeMCPConfig(addr.port);

      const api: MCPServer = {
        port: addr.port,
        configPath,
        events,
        registerWorker(taskId, role, mission) {
          const w = ensureWorker(taskId, role, mission);
          w.role = role || w.role;
          w.mission = mission || w.mission;
          w.status = "running";
          w.lastActivityAt = now();
        },
        markWorkerStatus(taskId, status) {
          const w = workers.get(taskId);
          if (!w) return;
          w.status = status;
          w.lastActivityAt = now();
          if (status === "done" || status === "failed") {
            if (w.currentStepIndex) {
              const cur = w.plan.find((s) => s.index === w.currentStepIndex);
              if (cur && cur.status === "running") {
                cur.status = "done";
                cur.finishedAt = now();
              }
            }
            w.currentStepIndex = null;
          }
        },
        resolveAskPm(id, answer) {
          const fn = pendingAsks.get(id);
          if (fn) fn(answer);
        },
        resolveAskWorker(id, answer) {
          const fn = pendingAsks.get(id);
          if (fn) fn(answer);
        },
        snapshot() {
          return [...workers.values()].map((w) => ({
            ...w,
            plan: w.plan.map((s) => ({ ...s })),
            broadcasts: [...w.broadcasts],
            stolenSteps: [...w.stolenSteps],
          }));
        },
        getWorker(taskId) {
          const w = workers.get(taskId);
          if (!w) return undefined;
          return {
            ...w,
            plan: w.plan.map((s) => ({ ...s })),
            broadcasts: [...w.broadcasts],
            stolenSteps: [...w.stolenSteps],
          };
        },
        reset() {
          workers.clear();
          // 진행 중 ask는 중단 처리 — 새 작업과 섞이면 안 됨
          for (const [, fn] of pendingAsks) {
            try {
              fn("[작업 리셋] 이전 요청 취소");
            } catch {
              // ignore
            }
          }
          pendingAsks.clear();
        },
        stop: () =>
          new Promise<void>((res2) => {
            // pending ask 들 정리
            for (const [, fn] of pendingAsks) {
              try {
                fn("[서버 종료] 응답 불가");
              } catch {
                // ignore
              }
            }
            pendingAsks.clear();
            server.close(() => res2());
          }),
      };

      resolve(api);
    });
  });
}

function writeMCPConfig(port: number): string {
  const configDir = join(tmpdir(), "furyclaw");
  mkdirSync(configDir, { recursive: true });

  const configPath = join(configDir, `mcp-config-${port}.json`);
  const config = {
    mcpServers: {
      furyclaw: {
        type: "http",
        url: `http://127.0.0.1:${port}`,
      },
    },
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  return configPath;
}
