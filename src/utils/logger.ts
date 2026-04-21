/**
 * FuryClaw 런타임 로거.
 *
 * 파일: <tmpdir>/furyclaw/runtime.log 에 append.
 * 경고/에러는 stderr 에도 미러링.
 * Planner/Worker 같은 Claude CLI 호출이 실패했을 때 raw stdout/stderr 를
 * dumpToFile() 로 별도 파일에 저장하고 경로를 에러 메시지에 포함시켜
 * 사용자/개발자가 사후에 무슨 일이 났는지 볼 수 있게 한다.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const LOG_DIR = join(tmpdir(), "furyclaw");
export const LOG_FILE_PATH = join(LOG_DIR, "runtime.log");

try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // ignore — tmpdir 생성 실패 시 stderr fallback
}

export type LogLevel = "debug" | "info" | "warn" | "error";

function formatLine(level: LogLevel, component: string, message: string): string {
  const ts = new Date().toISOString();
  return `[${ts}] [${level.toUpperCase().padEnd(5)}] [${component}] ${message}\n`;
}

export function log(
  level: LogLevel,
  component: string,
  message: string,
  extra?: unknown
): void {
  let fullMsg = message;
  if (extra !== undefined) {
    try {
      const serialized =
        typeof extra === "string"
          ? extra
          : extra instanceof Error
            ? `${extra.name}: ${extra.message}${extra.stack ? "\n" + extra.stack : ""}`
            : JSON.stringify(extra, null, 2);
      fullMsg += "\n  " + serialized.replace(/\n/g, "\n  ");
    } catch {
      fullMsg += " [unserializable]";
    }
  }
  const line = formatLine(level, component, fullMsg);
  try {
    appendFileSync(LOG_FILE_PATH, line, "utf-8");
  } catch {
    // stderr fallback
    process.stderr.write(line);
  }
  if (level === "error" || level === "warn") {
    process.stderr.write(line);
  }
}

export const logger = {
  debug: (component: string, msg: string, extra?: unknown) => log("debug", component, msg, extra),
  info: (component: string, msg: string, extra?: unknown) => log("info", component, msg, extra),
  warn: (component: string, msg: string, extra?: unknown) => log("warn", component, msg, extra),
  error: (component: string, msg: string, extra?: unknown) => log("error", component, msg, extra),
};

/**
 * 큰 덩어리 텍스트(예: Planner의 raw stdout/stderr)를 별도 파일로 저장.
 * 반환값: 저장된 절대 경로.
 */
export function dumpToFile(component: string, suffix: string, content: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${component}-${suffix}-${ts}.txt`;
  const path = join(LOG_DIR, filename);
  try {
    appendFileSync(path, content, "utf-8");
  } catch {
    return "";
  }
  return path;
}
