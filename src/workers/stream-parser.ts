import type { ClaudeStreamMessage } from "../types/claude-output.js";

export type StreamEvent =
  | { type: "init"; sessionId: string }
  | { type: "progress"; text: string }
  | { type: "tool_use"; tool: string; input: unknown }
  | { type: "cost"; costUsd: number }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      model?: string;
    }
  | { type: "result"; result: string; costUsd: number; usage?: { inputTokens: number; outputTokens: number } }
  | { type: "error"; message: string }
  | { type: "rate_limit"; retryAfter?: number };

export function parseStreamLine(line: string): StreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let msg: ClaudeStreamMessage;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return [];
  }

  switch (msg.type) {
    case "system":
      if (msg.subtype === "init" && msg.session_id) {
        return [{ type: "init", sessionId: msg.session_id }];
      }
      return [];

    case "assistant": {
      if (!msg.message?.content) return [];
      const out: StreamEvent[] = [];

      const parts: string[] = [];
      for (const block of msg.message.content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        }
        if (block.type === "tool_use") {
          out.push({ type: "tool_use", tool: block.name as string, input: block.input });
        }
      }
      if (parts.length > 0) {
        out.push({ type: "progress", text: parts.join("") });
      }

      const u = msg.message.usage;
      if (u) {
        out.push({
          type: "usage",
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
          model: msg.message.model,
        });
      }
      return out;
    }

    case "result":
      if (msg.is_error) {
        return [{ type: "error", message: msg.result ?? "Unknown error" }];
      }
      return [
        {
          type: "result",
          result: msg.result ?? "",
          costUsd: msg.total_cost_usd ?? 0,
          usage: msg.usage
            ? { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens }
            : undefined,
        },
      ];

    case "rate_limit_event":
      return [{ type: "rate_limit" }];

    default:
      return [];
  }
}

export function createStreamParser(onEvent: (event: StreamEvent) => void) {
  let buffer = "";

  return {
    feed(chunk: string) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        for (const event of parseStreamLine(line)) onEvent(event);
      }
    },
    flush() {
      if (buffer.trim()) {
        for (const event of parseStreamLine(buffer)) onEvent(event);
        buffer = "";
      }
    },
  };
}
