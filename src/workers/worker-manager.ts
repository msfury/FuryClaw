import PQueue from "p-queue";
import { runWorker, type WorkerOptions } from "./worker.js";
import type { StreamEvent } from "./stream-parser.js";
import type { SubTask, WorkerResult, TaskPlan } from "../types/task.js";
import type { FuryClawConfig } from "../types/config.js";

export interface WorkerManagerOptions {
  plan: TaskPlan;
  config: FuryClawConfig;
  workingDirectory: string;
  mcpConfigPath?: string;
  onWorkerEvent?: (taskId: string, event: StreamEvent) => void;
  onWorkerComplete?: (result: WorkerResult) => void;
}

export async function executeplan(opts: WorkerManagerOptions): Promise<WorkerResult[]> {
  const { plan, config, workingDirectory, mcpConfigPath, onWorkerEvent, onWorkerComplete } = opts;

  const results = new Map<string, WorkerResult>();
  const taskMap = new Map<string, SubTask>();
  for (const task of plan.tasks) {
    taskMap.set(task.id, task);
  }

  const queue = new PQueue({ concurrency: config.concurrency });

  // Execute in dependency order: executionOrder is array of arrays
  // Each inner array is a set of tasks that can run in parallel
  for (const batch of plan.executionOrder) {
    const batchPromises: Promise<void>[] = [];

    for (const taskId of batch) {
      const task = taskMap.get(taskId);
      if (!task) continue;

      const promise = queue.add(async () => {
        // Gather predecessor outputs for context injection
        const predecessorOutputs = new Map<string, string>();
        for (const depId of task.dependsOn) {
          const depResult = results.get(depId);
          if (depResult?.success) {
            predecessorOutputs.set(depId, depResult.output);
          }
        }

        const workerOpts: WorkerOptions = {
          task,
          config,
          workingDirectory,
          mcpConfigPath,
          onEvent: onWorkerEvent,
          predecessorOutputs: predecessorOutputs.size > 0 ? predecessorOutputs : undefined,
        };

        const result = await runWorker(workerOpts);
        results.set(taskId, result);
        onWorkerComplete?.(result);
      });

      batchPromises.push(promise as Promise<void>);
    }

    // Wait for entire batch before moving to next
    await Promise.all(batchPromises);
  }

  // Return results in original task order, skip any missing
  return plan.tasks
    .map((t) => results.get(t.id))
    .filter((r): r is WorkerResult => r != null);
}

export function topologicalSort(tasks: SubTask[]): string[][] {
  const taskMap = new Map<string, SubTask>();
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  const allIds = new Set(tasks.map((t) => t.id));
  for (const task of tasks) {
    taskMap.set(task.id, task);
    // Filter out dependencies on non-existent tasks
    const validDeps = task.dependsOn.filter((d) => allIds.has(d));
    inDegree.set(task.id, validDeps.length);
    for (const dep of validDeps) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(task.id);
    }
  }

  const batches: string[][] = [];
  const remaining = new Set(tasks.map((t) => t.id));

  while (remaining.size > 0) {
    const batch: string[] = [];
    for (const id of remaining) {
      if ((inDegree.get(id) ?? 0) === 0) {
        batch.push(id);
      }
    }

    if (batch.length === 0) {
      // Circular dependency — force remaining into one batch
      batches.push([...remaining]);
      break;
    }

    for (const id of batch) {
      remaining.delete(id);
      for (const dep of dependents.get(id) ?? []) {
        inDegree.set(dep, (inDegree.get(dep) ?? 1) - 1);
      }
    }

    batches.push(batch);
  }

  return batches;
}
