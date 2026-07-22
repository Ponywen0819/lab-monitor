export interface InstallRequest {
  targetIp: string;
  sshPort: number;
  username: string;
  /** Used once to establish trust, never persisted. See blueprint 1.6/3.6. */
  password: string;
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
