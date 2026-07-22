import { readFileSync, statfsSync } from "node:fs";
import type { DiskPartition } from "@labmon/shared";

const VIRTUAL_FS_TYPES = new Set([
  "tmpfs",
  "devtmpfs",
  "proc",
  "sysfs",
  "cgroup",
  "cgroup2",
  "overlay",
  "squashfs",
  "devpts",
  "securityfs",
  "pstore",
  "efivarfs",
  "bpf",
  "autofs",
  "debugfs",
  "tracefs",
  "hugetlbfs",
  "mqueue",
  "fusectl",
  "configfs",
  "binfmt_misc",
  "rpc_pipefs",
  "fuse.gvfsd-fuse",
  "ramfs",
  "nsfs",
]);

function realMountPoints(): string[] {
  const lines = readFileSync("/proc/mounts", "utf8").split("\n").filter(Boolean);
  const mounts: string[] = [];
  for (const line of lines) {
    const [, mountPoint, fsType] = line.split(/\s+/);
    if (!mountPoint || !fsType) continue;
    if (VIRTUAL_FS_TYPES.has(fsType)) continue;
    if (fsType.startsWith("fuse.")) continue;
    mounts.push(mountPoint);
  }
  return mounts;
}

export function collectDiskUsage(): DiskPartition[] {
  const partitions: DiskPartition[] = [];
  const seen = new Set<string>();

  for (const mount of realMountPoints()) {
    if (seen.has(mount)) continue;
    seen.add(mount);

    try {
      const stats = statfsSync(mount);
      const totalBytes = stats.blocks * stats.bsize;
      const usedBytes = (stats.blocks - stats.bfree) * stats.bsize;
      partitions.push({ mount, totalBytes, usedBytes });
    } catch {
      // Mount disappeared or is inaccessible between listing and statfs -- skip it,
      // one bad mount shouldn't fail the whole disk collector.
    }
  }

  if (partitions.length === 0) {
    throw new Error("no real filesystems found in /proc/mounts");
  }

  return partitions;
}
