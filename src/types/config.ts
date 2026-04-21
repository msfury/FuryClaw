export type ModelName = "opus" | "sonnet" | "haiku";
export type EffortLevel = "low" | "medium" | "high" | "max";

export interface FuryClawConfig {
  concurrency: number;
  defaultModel: ModelName;
  effort: EffortLevel;
  maxBudgetUsd?: number;
  permissionMode: "strict" | "auto" | "unrestricted";
  roles: Record<string, RoleTemplate>;
  mcpPort: number;
  workingDirectory?: string;
}

export interface RoleTemplate {
  description: string;
  systemPromptSuffix: string;
  allowedTools: string[];
  model?: ModelName;
}

// All tools — full computer access
const ALL_TOOLS = [
  "Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent",
  "NotebookEdit", "WebFetch", "WebSearch",
];

export const DEFAULT_CONFIG: FuryClawConfig = {
  concurrency: 3,
  defaultModel: "opus",
  effort: "max",
  permissionMode: "auto",
  mcpPort: 39999,
  roles: {
    // General purpose — can do anything on the computer
    general: {
      description: "General purpose agent with full computer access",
      systemPromptSuffix: "You have full access to the computer. Use Bash for system commands, file operations, network, processes, etc.",
      allowedTools: ALL_TOOLS,
    },
    // Code implementation
    implementer: {
      description: "Implements features, writes code, runs builds",
      systemPromptSuffix: "You implement code changes. You can run builds, install packages, execute scripts.",
      allowedTools: ALL_TOOLS,
    },
    // System operations — file management, process control, hardware info
    sysadmin: {
      description: "System operations — files, processes, network, hardware, drivers",
      systemPromptSuffix: "You handle system-level operations: file management, process control, network config, hardware info, driver queries, disk operations.",
      allowedTools: ALL_TOOLS,
    },
    // Testing
    tester: {
      description: "Writes and runs tests",
      systemPromptSuffix: "You write and run tests.",
      allowedTools: ALL_TOOLS,
    },
    // Code review (read-only)
    reviewer: {
      description: "Reviews code for bugs and quality (read-only)",
      systemPromptSuffix: "You review code for correctness and quality. You only read, never modify.",
      allowedTools: ["Read", "Glob", "Grep", "Bash"],
    },
    // Documentation
    documenter: {
      description: "Writes documentation",
      systemPromptSuffix: "You write documentation.",
      allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
    },
    // Research — web search, fetch, exploration
    researcher: {
      description: "Researches information from web and local sources",
      systemPromptSuffix: "You research and gather information from the web and local filesystem.",
      allowedTools: ["Read", "Glob", "Grep", "Bash", "Agent", "WebFetch", "WebSearch"],
    },
  },
};
