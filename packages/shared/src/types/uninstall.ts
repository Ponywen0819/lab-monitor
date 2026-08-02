export interface UninstallRequest {
  targetIp: string;
  sshPort: number;
  username: string;
  /** Used once to stop/remove the remote agent, never persisted. */
  password: string;
  /** Piped to `sudo -S` over the same SSH session, never persisted. */
  sudoPassword: string;
}

export type UninstallStage = "connecting" | "stopping_service" | "waiting_for_disconnect" | "done" | "failed";

export interface UninstallProgressEvent {
  uninstallId: string;
  hostId: string;
  stage: UninstallStage;
  message: string;
  success?: boolean;
  timestamp: number;
}
