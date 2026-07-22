const AGENT_INSTALL_PATH = "/opt/labmon-agent/agent";

export function renderSystemdUnit(): string {
  return `[Unit]
Description=Labmon Agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${AGENT_INSTALL_PATH}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}
