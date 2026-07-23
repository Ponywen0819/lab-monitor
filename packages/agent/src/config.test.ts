import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

const ORIGINAL_ENV = process.env.LABMON_AGENT_CONFIG;
let dir: string;

function configPath(name = "config.json"): string {
  return join(dir, name);
}

describe("loadConfig", () => {
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.LABMON_AGENT_CONFIG;
    else process.env.LABMON_AGENT_CONFIG = ORIGINAL_ENV;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads and parses a valid config file at LABMON_AGENT_CONFIG", () => {
    dir = mkdtempSync(join(tmpdir(), "labmon-agent-config-"));
    const path = configPath();
    writeFileSync(
      path,
      JSON.stringify({ hostId: "host-1", collectorWsUrl: "ws://collector:9000" }),
    );
    process.env.LABMON_AGENT_CONFIG = path;

    const config = loadConfig();

    expect(config).toEqual({ hostId: "host-1", collectorWsUrl: "ws://collector:9000" });
  });

  it("throws an error naming the path when the config file is missing", () => {
    dir = mkdtempSync(join(tmpdir(), "labmon-agent-config-"));
    const path = configPath("does-not-exist.json");
    process.env.LABMON_AGENT_CONFIG = path;

    expect(() => loadConfig()).toThrow(`[config] failed to read config file at ${path}`);
  });

  it("throws a clear error when the config file has malformed JSON", () => {
    dir = mkdtempSync(join(tmpdir(), "labmon-agent-config-"));
    const path = configPath();
    writeFileSync(path, "{ not valid json");
    process.env.LABMON_AGENT_CONFIG = path;

    expect(() => loadConfig()).toThrow(`[config] ${path} is not valid JSON`);
  });

  it("throws when hostId is missing from otherwise-valid JSON", () => {
    dir = mkdtempSync(join(tmpdir(), "labmon-agent-config-"));
    const path = configPath();
    writeFileSync(path, JSON.stringify({ collectorWsUrl: "ws://collector:9000" }));
    process.env.LABMON_AGENT_CONFIG = path;

    expect(() => loadConfig()).toThrow(
      `[config] ${path} must contain {hostId: string, collectorWsUrl: string}`,
    );
  });

  it("throws when collectorWsUrl is missing from otherwise-valid JSON", () => {
    dir = mkdtempSync(join(tmpdir(), "labmon-agent-config-"));
    const path = configPath();
    writeFileSync(path, JSON.stringify({ hostId: "host-1" }));
    process.env.LABMON_AGENT_CONFIG = path;

    expect(() => loadConfig()).toThrow(
      `[config] ${path} must contain {hostId: string, collectorWsUrl: string}`,
    );
  });
});
