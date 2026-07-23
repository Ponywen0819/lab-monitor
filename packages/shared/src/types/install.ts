export interface InstallRequest {
  targetIp: string;
  sshPort: number;
  username: string;
  /** Used once to establish trust, never persisted. See blueprint 1.6/3.6. */
  password: string;
  /** Piped to `sudo -S` over the same SSH session, never persisted. Always
   *  collected up front rather than only on demand, so the install never
   *  pauses mid-flow waiting on a prompt. */
  sudoPassword: string;
}

export type InstallStage =
  | "connecting"
  | "deploying_key"
  | "uploading_agent"
  | "starting_service"
  | "waiting_for_connection"
  | "done"
  | "failed";

export interface InstallProgressEvent {
  installId: string;
  stage: InstallStage;
  message: string;
  hostId?: string;
  success?: boolean;
  timestamp: number;
}
