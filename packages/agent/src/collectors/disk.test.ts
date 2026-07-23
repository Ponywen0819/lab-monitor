import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, statfsSync } from "node:fs";
import { collectDiskUsage } from "./disk.js";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  statfsSync: vi.fn(),
}));

const MIXED_MOUNTS = [
  "/dev/sda1 / ext4 rw,relatime 0 0",
  "/dev/sdb1 /data xfs rw,relatime 0 0",
  "tmpfs /run tmpfs rw,nosuid,size=100000k 0 0",
  "proc /proc proc rw,nosuid 0 0",
  "sysfs /sys sysfs rw,nosuid 0 0",
  "devtmpfs /dev devtmpfs rw 0 0",
  "overlay /var/lib/docker/overlay2/abc/merged overlay rw 0 0",
  "squashfs /snap/core20/1234 squashfs ro 0 0",
  "cgroup2 /sys/fs/cgroup cgroup2 rw 0 0",
  "gvfsd-fuse /run/user/1000/gvfs fuse.gvfsd-fuse rw 0 0",
].join("\n");

describe("collectDiskUsage", () => {
  afterEach(() => {
    vi.mocked(readFileSync).mockReset();
    vi.mocked(statfsSync).mockReset();
  });

  it("keeps only real filesystems, filtering out virtual ones", () => {
    vi.mocked(readFileSync).mockReturnValue(MIXED_MOUNTS);
    vi.mocked(statfsSync).mockImplementation(
      () => ({ blocks: 1000, bfree: 500, bsize: 4096 }) as ReturnType<typeof statfsSync>,
    );

    const result = collectDiskUsage();

    expect(result.map((p) => p.mount).sort()).toEqual(["/", "/data"]);
    expect(readFileSync).toHaveBeenCalledWith("/proc/mounts", "utf8");
  });

  it("reports totalBytes/usedBytes derived from statfs blocks * bsize", () => {
    vi.mocked(readFileSync).mockReturnValue(
      ["/dev/sda1 / ext4 rw,relatime 0 0", "/dev/sdb1 /data xfs rw,relatime 0 0"].join("\n"),
    );
    vi.mocked(statfsSync).mockImplementation((path) => {
      if (path === "/") {
        return { blocks: 1_000_000, bfree: 400_000, bsize: 4096 } as ReturnType<
          typeof statfsSync
        >;
      }
      return { blocks: 2_000_000, bfree: 500_000, bsize: 4096 } as ReturnType<typeof statfsSync>;
    });

    const result = collectDiskUsage();
    const root = result.find((p) => p.mount === "/");
    const data = result.find((p) => p.mount === "/data");

    expect(root).toEqual({ mount: "/", totalBytes: 4_096_000_000, usedBytes: 2_457_600_000 });
    expect(data).toEqual({ mount: "/data", totalBytes: 8_192_000_000, usedBytes: 6_144_000_000 });
  });

  it("skips a mount that fails to stat without failing the whole collector", () => {
    vi.mocked(readFileSync).mockReturnValue(
      ["/dev/sda1 / ext4 rw,relatime 0 0", "/dev/sdb1 /mnt/broken ext4 rw,relatime 0 0"].join(
        "\n",
      ),
    );
    vi.mocked(statfsSync).mockImplementation((path) => {
      if (path === "/mnt/broken") {
        throw new Error("ENOENT: no such file or directory, statfs '/mnt/broken'");
      }
      return { blocks: 1000, bfree: 500, bsize: 4096 } as ReturnType<typeof statfsSync>;
    });

    const result = collectDiskUsage();

    expect(result).toHaveLength(1);
    expect(result[0].mount).toBe("/");
  });

  it("throws when every real mount fails to stat", () => {
    vi.mocked(readFileSync).mockReturnValue("/dev/sda1 / ext4 rw,relatime 0 0");
    vi.mocked(statfsSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(() => collectDiskUsage()).toThrow("no real filesystems found in /proc/mounts");
  });
});
