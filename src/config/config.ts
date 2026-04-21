import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_CONFIG, type FuryClawConfig } from "../types/config.js";

export function loadConfig(workingDirectory: string, overrides?: Partial<FuryClawConfig>): FuryClawConfig {
  const configPath = resolve(workingDirectory, ".furyclaw.json");
  let fileConfig: Partial<FuryClawConfig> = {};

  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch (err) {
      console.warn(`Warning: Invalid .furyclaw.json at ${configPath}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...overrides,
    roles: {
      ...DEFAULT_CONFIG.roles,
      ...fileConfig.roles,
      ...overrides?.roles,
    },
  };
}
