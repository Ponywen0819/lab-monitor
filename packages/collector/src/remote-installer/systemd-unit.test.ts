import { describe, expect, it } from "vitest";
import { renderSystemdUnit } from "./systemd-unit.js";

describe("renderSystemdUnit", () => {
  it("contains the [Unit], [Service] and [Install] sections", () => {
    const unit = renderSystemdUnit();
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
  });

  it("points ExecStart at the installed agent binary", () => {
    const unit = renderSystemdUnit();
    expect(unit).toContain("ExecStart=/opt/labmon-agent/agent");
  });

  it("restarts always and installs under multi-user.target", () => {
    const unit = renderSystemdUnit();
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=multi-user.target");
  });
});
