import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

export interface CollectorKeyPair {
  privateKeyPath: string;
  /** Full "ssh-ed25519 AAAA... comment" line, ready to append to authorized_keys. */
  publicKey: string;
}

/**
 * Generates the Collector's own persistent identity keypair on first use if
 * privateKeyPath doesn't exist yet, otherwise reuses it. Shells out to
 * ssh-keygen rather than Node's crypto module: crypto.generateKeyPairSync only
 * emits PKCS8 PEM for ed25519, but ssh2's key parser (and OpenSSH itself)
 * requires the OpenSSH armored private-key format, which ssh-keygen produces
 * directly.
 */
export function ensureCollectorKeyPair(privateKeyPath: string): CollectorKeyPair {
  const publicKeyPath = `${privateKeyPath}.pub`;

  if (!existsSync(privateKeyPath)) {
    mkdirSync(dirname(privateKeyPath), { recursive: true });
    execFileSync("ssh-keygen", [
      "-t",
      "ed25519",
      "-f",
      privateKeyPath,
      "-N",
      "",
      "-C",
      "labmon-collector",
      "-q",
    ]);
  }

  chmodSync(privateKeyPath, 0o600);

  return {
    privateKeyPath,
    publicKey: readFileSync(publicKeyPath, "utf8").trim(),
  };
}
