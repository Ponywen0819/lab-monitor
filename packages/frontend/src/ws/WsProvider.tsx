import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  CollectorToFrontendMessage,
  DashboardSubscribeMessage,
  HostSnapshot,
  InstallProgressEvent,
} from "@labmon/shared";
import { fetchHosts } from "../api/client";

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:8080";
const RECONNECT_DELAY_MS = 3000;

interface WsContextValue {
  hosts: Map<string, HostSnapshot>;
  connected: boolean;
  // Keyed by installId so the Remote Install page can subscribe to just the
  // install it kicked off; events accumulate in arrival order per install.
  installEvents: Map<string, InstallProgressEvent[]>;
}

const WsContext = createContext<WsContextValue | null>(null);

export function WsProvider({ children }: { children: ReactNode }) {
  const [hosts, setHosts] = useState<Map<string, HostSnapshot>>(new Map());
  const [connected, setConnected] = useState(false);
  const [installEvents, setInstallEvents] = useState<Map<string, InstallProgressEvent[]>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    // Seeds the map from the REST snapshot so the dashboard isn't blank
    // while waiting for the first WS push (blueprint 4.2). Only fills in
    // hosts the WS channel hasn't already reported, so a fast host_update
    // that races ahead of this response is never clobbered.
    fetchHosts()
      .then((initialHosts) => {
        if (!mountedRef.current) return;
        setHosts((prev) => {
          const next = new Map(prev);
          for (const host of initialHosts) {
            if (!next.has(host.id)) next.set(host.id, host);
          }
          return next;
        });
      })
      .catch((err) => console.error("[ws] failed to seed initial hosts:", err));

    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function connect(): void {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      const subscribe: DashboardSubscribeMessage = { type: "dashboard_subscribe" };
      ws.send(JSON.stringify(subscribe));
    };

    ws.onmessage = (event) => {
      let message: CollectorToFrontendMessage;
      try {
        message = JSON.parse(event.data as string) as CollectorToFrontendMessage;
      } catch {
        return;
      }
      handleMessage(message);
    };

    ws.onclose = () => scheduleReconnect();
    ws.onerror = () => ws.close();
  }

  function scheduleReconnect(): void {
    setConnected(false);
    if (!mountedRef.current) return;
    reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
  }

  function handleMessage(message: CollectorToFrontendMessage): void {
    if (message.type === "host_update") {
      setHosts((prev) => {
        const next = new Map(prev);
        next.set(message.host.id, message.host);
        return next;
      });
      return;
    }

    if (message.type === "host_status") {
      setHosts((prev) => {
        const existing = prev.get(message.hostId);
        if (!existing) return prev;
        const next = new Map(prev);
        next.set(message.hostId, { ...existing, status: message.status });
        return next;
      });
      return;
    }

    if (message.type === "install_progress") {
      const { installId } = message.event;
      setInstallEvents((prev) => {
        const next = new Map(prev);
        next.set(installId, [...(next.get(installId) ?? []), message.event]);
        return next;
      });
      return;
    }
  }

  const value = useMemo<WsContextValue>(
    () => ({ hosts, connected, installEvents }),
    [hosts, connected, installEvents],
  );

  return <WsContext.Provider value={value}>{children}</WsContext.Provider>;
}

export function useHosts(): WsContextValue {
  const ctx = useContext(WsContext);
  if (!ctx) throw new Error("useHosts must be used within a WsProvider");
  return ctx;
}
