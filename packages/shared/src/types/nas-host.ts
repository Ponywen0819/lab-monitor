/** A NAS being monitored by ping only (no agent). Added/removed at runtime via the HTTP API. */
export interface NasHostConfig {
  id: string;
  name: string;
  ip: string;
}
