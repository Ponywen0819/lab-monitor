import type { AgentReportMessage } from "@labmon/shared";

const RECONNECT_DELAY_MS = 5_000;

export class WsClient {
  private readonly url: string;
  private ws: WebSocket | null = null;
  private closedByUs = false;

  constructor(url: string) {
    this.url = url;
  }

  start(): void {
    this.closedByUs = false;
    this.connect();
  }

  stop(): void {
    this.closedByUs = true;
    this.ws?.close();
  }

  send(message: AgentReportMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private connect(): void {
    console.log(`[ws-client] connecting to ${this.url}`);
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      console.log("[ws-client] connected");
    });

    ws.addEventListener("close", () => {
      if (this.closedByUs) return;
      console.log(`[ws-client] disconnected, retrying in ${RECONNECT_DELAY_MS}ms`);
      setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    });

    ws.addEventListener("error", (event) => {
      console.error(`[ws-client] connection error: ${(event as ErrorEvent).message ?? event}`);
    });
  }
}
