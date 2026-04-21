/**
 * Permission tier system for FuryClaw.
 *
 * Philosophy: auto-approve everything EXCEPT:
 *  - Financial actions (purchases, payments, credit card)
 *  - Personal data exfiltration (sending PII externally)
 *  - Irreversible destructive operations on production systems
 *
 * File read/write/delete, package install, build, test, git operations
 * within the local repo are all auto-approved.
 */

export type PermissionLevel = "auto" | "warn" | "require_human";

export interface PermissionCheck {
  level: PermissionLevel;
  reason?: string;
}

const FINANCIAL_PATTERNS = [
  /credit.?card/i,
  /payment/i,
  /purchase/i,
  /billing/i,
  /stripe/i,
  /paypal/i,
  /invoice/i,
  /subscription.*(?:create|cancel|upgrade)/i,
  /charge/i,
  /refund/i,
];

const PII_EXFIL_PATTERNS = [
  /curl.*(?:password|token|secret|api.?key)/i,
  /wget.*(?:password|token|secret|api.?key)/i,
  /ssh.*(?:password|key)/i,
  /scp\s/i,
  /rsync.*(?:remote|ssh)/i,
  /(?:upload|send|post).*(?:credentials|password|ssn|social.?security)/i,
  /\.env/i,
];

const DESTRUCTIVE_PROD_PATTERNS = [
  /drop\s+(?:database|table|schema)/i,
  /rm\s+-rf\s+\//i,
  /format\s+[a-z]:/i,
  /shutdown/i,
  /deploy.*prod/i,
  /push.*(?:--force|main|master)/i,
];

const SAFE_ALWAYS = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "Agent",
  "NotebookEdit",
];

export function checkPermission(
  toolName: string,
  command?: string
): PermissionCheck {
  if (SAFE_ALWAYS.includes(toolName)) {
    return { level: "auto" };
  }

  if (toolName === "Bash" && command) {
    for (const pat of FINANCIAL_PATTERNS) {
      if (pat.test(command)) {
        return {
          level: "require_human",
          reason: `Financial operation detected: ${command.slice(0, 80)}`,
        };
      }
    }

    for (const pat of PII_EXFIL_PATTERNS) {
      if (pat.test(command)) {
        return {
          level: "require_human",
          reason: `Potential PII exfiltration: ${command.slice(0, 80)}`,
        };
      }
    }

    for (const pat of DESTRUCTIVE_PROD_PATTERNS) {
      if (pat.test(command)) {
        return {
          level: "warn",
          reason: `Destructive operation: ${command.slice(0, 80)}`,
        };
      }
    }

    return { level: "auto" };
  }

  return { level: "auto" };
}

export function buildAllowedTools(
  role: string,
  tools: string[],
  permissionMode: "strict" | "auto" | "unrestricted"
): string[] {
  if (permissionMode === "unrestricted") {
    return tools;
  }

  if (permissionMode === "strict") {
    if (role === "reviewer") {
      return tools.filter((t) => ["Read", "Glob", "Grep", "Bash"].includes(t));
    }
  }

  return tools;
}

export function buildPermissionFlags(
  permissionMode: "strict" | "auto" | "unrestricted"
): string[] {
  switch (permissionMode) {
    case "unrestricted":
      return ["--dangerously-skip-permissions"];
    case "auto":
      return ["--permission-mode", "auto"];
    case "strict":
      return ["--permission-mode", "default"];
  }
}
