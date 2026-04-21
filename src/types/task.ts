import { z } from "zod";

export const SubTaskSchema = z.object({
  id: z.string(),
  role: z.string(),
  mission: z.string(),
  description: z.string(),
  scope: z.object({
    ownFiles: z.array(z.string()),
    readonlyFiles: z.array(z.string()).default([]),
    forbiddenFiles: z.array(z.string()).default([]),
  }),
  requirements: z.array(z.string()),
  constraints: z.array(z.string()).default([]),
  suggestedApproach: z.string().optional(),
  interfaceContracts: z
    .array(
      z.object({
        type: z.enum(["provides", "consumes"]),
        counterpart: z.string(),
        contract: z.string(),
      })
    )
    .default([]),
  dependsOn: z.array(z.string()).default([]),
  model: z.enum(["opus", "sonnet", "haiku"]).default("opus"),
  maxBudgetUsd: z.number().optional(),
});

export type SubTask = z.infer<typeof SubTaskSchema>;

export const TaskPlanSchema = z.object({
  summary: z.string(),
  tasks: z.array(SubTaskSchema),
  executionOrder: z.array(z.array(z.string())).optional().default([]),
});

export type TaskPlan = z.infer<typeof TaskPlanSchema>;

export interface WorkerResult {
  taskId: string;
  success: boolean;
  output: string;
  filesChanged: string[];
  decisions: string[];
  notes: string[];
  costUsd: number;
  durationMs: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface OrchestratorResult {
  success: boolean;
  summary: string;
  workerResults: WorkerResult[];
  totalCostUsd: number;
  totalDurationMs: number;
}
