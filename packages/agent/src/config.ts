import { readFileSync } from "node:fs";

export interface AgentConfig {
  hostId: string;
  collectorWsUrl: string;
}

const DEFAULT_CONFIG_PATH = "/etc/labmon-agent/config.json";

export function loadConfig(): AgentConfig {
  const path = process.env.LABMON_AGENT_CONFIG ?? DEFAULT_CONFIG_PATH;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `[config] failed to read config file at ${path}: ${(err as Error).message}. ` +
        `Expected the Remote Installer to have written {hostId, collectorWsUrl} there.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[config] ${path} is not valid JSON: ${(err as Error).message}`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).hostId !== "string" ||
    typeof (parsed as Record<string, unknown>).collectorWsUrl !== "string"
  ) {
    throw new Error(`[config] ${path} must contain {hostId: string, collectorWsUrl: string}`);
  }

  return parsed as AgentConfig;
}
