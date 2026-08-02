/**
 * IPv4 CIDR allowlist for the HTTP API (blueprint: internal-network-only
 * tool, but some deployments want to scope that to a specific subnet rather
 * than trusting the whole LAN). No third-party CIDR library -- matching a
 * /0-/32 IPv4 mask is a handful of lines, not worth a dependency for.
 */

export function parseCidrList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

// A trailing "::ffff:" prefix shows up when Node's dual-stack socket reports
// an IPv4 client's address in IPv4-mapped-IPv6 form.
function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
}

function cidrMatches(ipInt: number, cidr: string): boolean {
  const [base, prefixStr] = cidr.split("/");
  const baseInt = ipToInt(base);
  const prefix = prefixStr === undefined ? 32 : Number(prefixStr);
  if (baseInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;

  // JS shift operators take the shift amount mod 32, so "<< 32" for a /0
  // mask would silently become "<< 0" -- handled as an explicit case.
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/** An empty allowlist means "no restriction configured" -- everything is allowed. */
export function isIpAllowed(remoteAddress: string | undefined, allowedCidrs: string[]): boolean {
  if (allowedCidrs.length === 0) return true;
  if (!remoteAddress) return false;

  const ipInt = ipToInt(normalizeIp(remoteAddress));
  if (ipInt === null) return false;

  return allowedCidrs.some((cidr) => cidrMatches(ipInt, cidr));
}
