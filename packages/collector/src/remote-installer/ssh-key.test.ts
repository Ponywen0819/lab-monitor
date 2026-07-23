import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureCollectorKeyPair } from "./ssh-key.js";

describe("ensureCollectorKeyPair", () => {
  let dir: string;
  let keyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "labmon-ssh-key-"));
    keyPath = join(dir, "nested", "collector_id_ed25519");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("generates a keypair on first use", () => {
    const keyPair = ensureCollectorKeyPair(keyPath);

    expect(keyPair.privateKeyPath).toBe(keyPath);
    expect(statSync(keyPath).isFile()).toBe(true);

    const mode = statSync(keyPath).mode & 0o777;
    expect(mode).toBe(0o600);

    expect(statSync(`${keyPath}.pub`).isFile()).toBe(true);
    expect(keyPair.publicKey.startsWith("ssh-ed25519")).toBe(true);
  });

  it("reuses an existing keypair instead of regenerating it", () => {
    const first = ensureCollectorKeyPair(keyPath);
    const privateKeyContentBefore = readFileSync(keyPath, "utf8");

    const second = ensureCollectorKeyPair(keyPath);

    expect(second.publicKey).toBe(first.publicKey);
    expect(readFileSync(keyPath, "utf8")).toBe(privateKeyContentBefore);
  });
});
