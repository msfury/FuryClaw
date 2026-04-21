/**
 * PMAgent — PM 자신의 Claude 세션.
 *
 * 리액티브 Q&A 모드: 사용자 메시지가 오거나 워커가 ask_pm으로 질의할 때만 호출됨.
 * 호출 시 [CONTEXT] 블록으로 현재 워커 스냅샷이 주입되어 상태 파악이 가능.
 * --resume으로 세션을 이어가 대화 맥락을 유지한다.
 */

import { execa } from "execa";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createStreamParser } from "../workers/stream-parser.js";
import type { FuryClawConfig } from "../types/config.js";
import { CLAUDE_MODEL_ID, KOREAN_LANGUAGE_DIRECTIVE } from "../config/models.js";

const PM_SYSTEM_PROMPT = `${KOREAN_LANGUAGE_DIRECTIVE}

당신은 FuryClaw 멀티 에이전트 시스템의 PM(Project Manager)입니다.
사용자와 직접 대화하는 유일한 에이전트이며, 실제 작업은 여러 워커(독립 Claude Code 인스턴스)가 수행합니다.

역할:
- 사용자 질문에 답변하고, 워커들의 진행 상황/결과를 사용자가 이해할 수 있게 종합해 전달합니다.
- 당신은 도구(Read/Edit/Bash 등)를 쓰지 않습니다. 오직 텍스트로만 말합니다.
- 계획 수립은 별도의 Planner가 하므로 계획 자체를 새로 짜려 하지 마세요. 결과 설명과 소통에 집중.

입력 형식:
- \`[CONTEXT] ...\` 블록: 현재 워커 목록과 각 워커의 플랜/진행 단계/최근 로그 스냅샷이 들어옵니다.
  이를 기반으로 답하되, 사용자에게 그대로 토해내지 말고 **자연어로 정리**해서 전달하세요.
- \`[USER] ...\`: 사용자가 직접 당신에게 한 말. 그에 대한 응답을 작성.
- \`[WORKER X ASK_PM] ...\`: 워커 X가 당신에게 물어봄. 짧고 실행 가능한 답변을 주세요 (1-3문장).
- \`[WORKER X ASK_WORKER Y, Y IS RUNNING] ...\`: 워커 X가 워커 Y에게 물어봤으나 Y가 진행 중이라 당신이 대리로 답합니다.
  Y의 현재 플랜/진행 상황을 [CONTEXT]에서 확인하고, Y의 입장에서 합리적으로 답하세요. 확실치 않으면 그렇게 말하세요.
- \`[EVENT] ...\`: 중요한 시스템 이벤트 (계획 완료, 전체 작업 완료, 에러 등). 사용자에게 상황을 알립니다.
- \`[BROADCAST from X] ...\`: 워커 X가 공유한 중요 정보. 사용자에게 관련이 있으면 전달.

출력 규칙:
- 사용자에게는 **항상 한국어**로 응답.
- 기본 1-3문장. 요약/완료 보고 등 필요 시 더 길어도 됨.
- 구체적으로. "x1이 foo.ts 리팩토링 중 (플랜 2/4단계)" 처럼 워커 ID와 실제 동작을 언급.
- 인사/메타 설명/자기소개 금지. 바로 본론.
- 모르면 모른다고 솔직하게. 판단이 필요하면 사용자에게 짧게 되물음.
- 사용자가 "지금 뭐해?", "진행 상황 알려줘" 같은 질문을 하면 [CONTEXT]의 워커 정보를 종합해 워커별로 현재 단계와 다음 단계를 요약.
- 여러 이벤트가 한 번에 오면 하나의 짧은 업데이트로 묶어서 전달.

워커가 ask_pm으로 물어볼 때는 코드 관련 구체적 질문이 많습니다. 추측이 필요하면 "일반적으론 X, 확신이 없으면 Y를 먼저 해라" 식으로.`;

export interface PMSpeakHandlers {
  onDelta?: (text: string) => void;
  onFinish: (fullText: string, costUsd: number) => void;
  onError?: (msg: string) => void;
}

interface QueueItem {
  message: string;
  handlers: PMSpeakHandlers;
}

export class PMAgent {
  private sessionId: string | null = null;
  private queue: QueueItem[] = [];
  private processing = false;
  private readonly cwd: string;
  // Reserved for future config-driven tuning (effort level, timeouts, etc.)
  private readonly config: FuryClawConfig;
  private readonly sysPromptFile: string;

  constructor(config: FuryClawConfig, cwd: string) {
    this.config = config;
    this.cwd = cwd;
    this.sysPromptFile = join(
      tmpdir(),
      "furyclaw",
      `pm-sysprompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
    );
    mkdirSync(dirname(this.sysPromptFile), { recursive: true });
    writeFileSync(this.sysPromptFile, PM_SYSTEM_PROMPT, "utf-8");
  }

  isBusy(): boolean {
    return this.processing || this.queue.length > 0;
  }

  /** Fire-and-forget: 이벤트를 주입하고 완료되면 handlers.onFinish 호출. */
  enqueue(message: string, handlers: PMSpeakHandlers): void {
    this.queue.push({ message, handlers });
    void this.process();
  }

  /** 동기 스타일 질의: 완료될 때까지 기다리고 응답 텍스트 반환. 워커의 ask_pm용. */
  async ask(message: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.enqueue(message, {
        onFinish: (text) => resolve(text),
        onError: (msg) => reject(new Error(msg)),
      });
    });
  }

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        // 하나씩 처리. --resume으로 같은 세션을 이어가므로 캐시 히트 덕에 비용·지연 모두 저렴.
        // (배치 묶음 처리는 ask_pm 응답이 엉뚱한 턴에 돌아가는 문제가 생겨 제거.)
        const item = this.queue.shift()!;
        await this.callOnce(item.message, item.handlers);
      }
    } finally {
      this.processing = false;
    }
  }

  private async callOnce(message: string, h: PMSpeakHandlers): Promise<void> {
    const args: string[] = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--model", CLAUDE_MODEL_ID,
      "--effort", this.config.effort || "medium",
      "--max-turns", "1",
      "--system-prompt-file", this.sysPromptFile,
    ];
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    let fullText = "";
    let costUsd = 0;
    let lastEmittedLen = 0;

    const parser = createStreamParser((ev) => {
      if (ev.type === "init") this.sessionId = ev.sessionId;
      if (ev.type === "progress") {
        const current = ev.text;
        if (current.length > lastEmittedLen) {
          const delta = current.slice(lastEmittedLen);
          lastEmittedLen = current.length;
          fullText = current;
          h.onDelta?.(delta);
        } else if (current && current !== fullText) {
          fullText = fullText ? `${fullText}\n${current}` : current;
          lastEmittedLen = current.length;
          h.onDelta?.(current);
        }
      }
      if (ev.type === "result") {
        if (ev.result) fullText = ev.result;
        costUsd = ev.costUsd;
      }
      if (ev.type === "error") {
        h.onError?.(ev.message);
      }
    });

    try {
      const proc = execa("claude", args, {
        cwd: this.cwd,
        reject: false,
        timeout: 5 * 60 * 1000,
        input: message,
        env: { ...process.env, FORCE_COLOR: "0" },
      });
      if (proc.stdout) {
        proc.stdout.on("data", (chunk: Buffer) => parser.feed(chunk.toString()));
      }
      const execResult = await proc;
      parser.flush();

      if (!fullText && execResult.exitCode !== 0) {
        h.onError?.(String(execResult.stderr || execResult.stdout || "PM 호출 실패"));
      }
      h.onFinish(fullText.trim(), costUsd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      h.onError?.(msg);
      h.onFinish("", 0);
    }
  }
}
