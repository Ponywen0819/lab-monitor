import { readFileSync } from "node:fs";
import { Client } from "ssh2";

export type SshAuth = { method: "password"; password: string } | { method: "privateKey"; privateKeyPath: string };

export interface SshTarget {
  host: string;
  port: number;
  username: string;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * General-purpose "connect and run fixed steps" primitive. Not exported from
 * remote-installer/index.ts: install-agent.ts is the only caller, and it only
 * ever feeds it commands it built itself, never a caller/front-end-supplied
 * string -- an open exec(anyCommand) API is the security hole this module is
 * explicitly not building.
 */
export class SshSession {
  private constructor(private readonly client: Client) {}

  static connect(target: SshTarget, auth: SshAuth, timeoutMs: number): Promise<SshSession> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        client.destroy();
        reject(new Error(`SSH connection to ${target.host}:${target.port} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      client
        .on("ready", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(new SshSession(client));
        })
        .on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        })
        .connect({
          host: target.host,
          port: target.port,
          username: target.username,
          readyTimeout: timeoutMs,
          ...(auth.method === "password"
            ? { password: auth.password }
            : { privateKey: readFileSync(auth.privateKeyPath) }),
        });
    });
  }

  // stdin, when given, is written and the write side closed immediately --
  // e.g. a sudo -S password (or several, one per chained sudo -S command).
  // Commands that never read stdin at all just ignore it; ending it early
  // doesn't affect them.
  exec(command: string, stdin?: string): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, stream) => {
        if (err) return reject(err);

        if (stdin !== undefined) stream.end(stdin);

        let stdout = "";
        let stderr = "";

        stream
          .on("close", (code: number | null) => resolve({ code, stdout, stderr }))
          .on("data", (data: Buffer) => {
            stdout += data.toString();
          })
          .stderr.on("data", (data: Buffer) => {
            stderr += data.toString();
          });
      });
    });
  }

  uploadFile(remotePath: string, content: Buffer | string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.writeFile(remotePath, content, (err2) => (err2 ? reject(err2) : resolve()));
      });
    });
  }

  uploadLocalFile(localPath: string, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.fastPut(localPath, remotePath, (err2) => (err2 ? reject(err2) : resolve()));
      });
    });
  }

  close(): void {
    this.client.end();
  }
}
