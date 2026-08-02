import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { AgentReportMessage, CollectorToFrontendMessage, WsMessage } from "@labmon/shared";
import { isIpAllowed } from "./ip-allowlist.js";

interface AgentConnection {
  ws: WebSocket;
  lastSeenAt: number;
}

export interface WsServerEvents {
  /** A well-formed agent_report was received. */
  agent_report: (message: AgentReportMessage) => void;
  /** An agent connection dropped (close/error) -- a liveness-down signal, not a status decision. */
  agent_down: (hostId: string) => void;
}

export declare interface WsServer {
  on<E extends keyof WsServerEvents>(event: E, listener: WsServerEvents[E]): this;
  emit<E extends keyof WsServerEvents>(event: E, ...args: Parameters<WsServerEvents[E]>): boolean;
}

/**
 * Transport layer only: parses/validates messages, tracks connections, and
 * emits events. Deliberately has no knowledge of the offline-detection state
 * machine or storage -- server.ts wires those in from the outside so this
 * class stays a reusable pure-transport building block.
 */
export class WsServer extends EventEmitter {
  private readonly port: number;
  private wss: WebSocketServer | null = null;

  private readonly agentConnections = new Map<string, AgentConnection>();
  private readonly agentHostByWs = new Map<WebSocket, string>();
  private readonly frontendConnections = new Set<WebSocket>();
  // Only populated long enough to gate a dashboard_subscribe -- a WeakMap so
  // entries fall out on their own once a socket is garbage collected.
  private readonly remoteAddressByWs = new WeakMap<WebSocket, string | undefined>();
  private readonly allowedCidrs: string[];

  constructor(options: { port: number; allowedCidrs?: string[] }) {
    super();
    this.port = options.port;
    this.allowedCidrs = options.allowedCidrs ?? [];
  }

  start(): void {
    this.wss = new WebSocketServer({ port: this.port });
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
  }

  stop(): void {
    for (const ws of this.frontendConnections) ws.close();
    for (const { ws } of this.agentConnections.values()) ws.close();
    this.wss?.close();
    this.wss = null;
  }

  broadcastToFrontends(message: CollectorToFrontendMessage): void {
    const payload = JSON.stringify(message);
    for (const ws of this.frontendConnections) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    this.remoteAddressByWs.set(ws, req.socket.remoteAddress);
    ws.on("message", (raw) => this.handleMessage(ws, raw));
    ws.on("close", () => this.handleDisconnect(ws));
    ws.on("error", () => this.handleDisconnect(ws));
  }

  private handleMessage(ws: WebSocket, raw: unknown): void {
    let message: WsMessage;
    try {
      message = JSON.parse(String(raw)) as WsMessage;
    } catch {
      return;
    }

    if (message.type === "agent_report") {
      this.agentHostByWs.set(ws, message.hostId);
      this.agentConnections.set(message.hostId, { ws, lastSeenAt: Date.now() });
      this.emit("agent_report", message);
      return;
    }

    if (message.type === "dashboard_subscribe") {
      // Agents are deliberately exempt -- they live on the monitored lab
      // machines, which is the whole point of this tool, and may well sit
      // outside whatever subnet an operator's browser is restricted to.
      // Only the dashboard's own subscribe is gated, using the same
      // ALLOWED_CIDRS as the HTTP API.
      if (!isIpAllowed(this.remoteAddressByWs.get(ws), this.allowedCidrs)) {
        ws.close(4403, "forbidden");
        return;
      }
      this.frontendConnections.add(ws);
      return;
    }
  }

  private handleDisconnect(ws: WebSocket): void {
    this.frontendConnections.delete(ws);

    const hostId = this.agentHostByWs.get(ws);
    if (hostId === undefined) return;

    this.agentHostByWs.delete(ws);
    // Only the most recent connection for a hostId owns liveness; a stale
    // connection closing after a reconnect must not clobber the new one --
    // that means the agent_down signal itself has to be inside this guard
    // too, not just the connection-table cleanup.
    if (this.agentConnections.get(hostId)?.ws === ws) {
      this.agentConnections.delete(hostId);
      this.emit("agent_down", hostId);
    }
  }
}
