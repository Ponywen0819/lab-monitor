import { afterEach, describe, expect, it, vi } from "vitest";

// EventEmitter isn't used here -- referencing an import other than `vi`
// inside vi.hoisted() hits a TDZ, since vi.hoisted runs before the rest of
// this file's imports are linked. A tiny inline pub/sub sidesteps that.
const { FakeClient, clientInstances } = vi.hoisted(() => {
  class MiniEmitter {
    private readonly listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

    on(event: string, cb: (...args: unknown[]) => void): this {
      (this.listeners[event] ??= []).push(cb);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      this.listeners[event]?.forEach((cb) => cb(...args));
    }
  }

  class FakeStream extends MiniEmitter {
    readonly stderr = new MiniEmitter();
    written: string[] = [];
    ended = false;

    write(data: string): boolean {
      this.written.push(data);
      return true;
    }

    end(data?: string): void {
      if (data !== undefined) this.written.push(data);
      this.ended = true;
    }

    closeChannel(code: number | null): void {
      this.emit("close", code);
    }
  }

  const clientInstances: FakeClient[] = [];

  class FakeClient extends MiniEmitter {
    execCalls: Array<{ command: string; stream: FakeStream }> = [];

    constructor() {
      super();
      clientInstances.push(this);
    }

    connect(): void {
      queueMicrotask(() => this.emit("ready"));
    }

    exec(command: string, callback: (err: Error | null, stream: FakeStream) => void): void {
      const stream = new FakeStream();
      this.execCalls.push({ command, stream });
      callback(null, stream);
    }

    end(): void {}
    destroy(): void {}
  }

  return { FakeClient, clientInstances };
});

vi.mock("ssh2", () => ({ Client: FakeClient }));

import { SshSession } from "./ssh-session.js";

afterEach(() => {
  clientInstances.length = 0;
});

async function connectFakeSession() {
  const session = await SshSession.connect(
    { host: "10.0.0.1", port: 22, username: "root" },
    { method: "password", password: "hunter2" },
    1000
  );
  return { session, client: clientInstances[clientInstances.length - 1] };
}

describe("SshSession.exec", () => {
  it("resolves with the exit code, stdout, and stderr once the channel closes", async () => {
    const { session, client } = await connectFakeSession();

    const resultPromise = session.exec("echo hi");
    const { stream } = client.execCalls[0];
    stream.emit("data", Buffer.from("hi\n"));
    stream.stderr.emit("data", Buffer.from("warn\n"));
    stream.closeChannel(0);

    await expect(resultPromise).resolves.toEqual({ code: 0, stdout: "hi\n", stderr: "warn\n" });
  });

  it("does not write anything to the remote command's stdin when none is given", async () => {
    const { session, client } = await connectFakeSession();

    const resultPromise = session.exec("mkdir -p /tmp/x");
    const { stream } = client.execCalls[0];
    expect(stream.written).toEqual([]);
    expect(stream.ended).toBe(false);

    stream.closeChannel(0);
    await resultPromise;
  });

  it("writes and closes stdin with the given content, e.g. a sudo -S password", async () => {
    const { session, client } = await connectFakeSession();

    const resultPromise = session.exec("sudo -S -p '' true", "hunter2\n");
    const { stream } = client.execCalls[0];
    expect(stream.written).toEqual(["hunter2\n"]);
    expect(stream.ended).toBe(true);

    stream.closeChannel(0);
    await resultPromise;
  });
});
