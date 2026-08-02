import { describe, expect, it } from "vitest";
import { isIpAllowed, parseCidrList } from "./ip-allowlist.js";

describe("parseCidrList", () => {
  it("returns [] for undefined or empty input", () => {
    expect(parseCidrList(undefined)).toEqual([]);
    expect(parseCidrList("")).toEqual([]);
    expect(parseCidrList("   ")).toEqual([]);
  });

  it("splits on commas and trims whitespace", () => {
    expect(parseCidrList("192.168.1.0/24, 10.0.0.0/16 ,172.16.0.0/12")).toEqual([
      "192.168.1.0/24",
      "10.0.0.0/16",
      "172.16.0.0/12",
    ]);
  });
});

describe("isIpAllowed", () => {
  it("allows anything when no allowlist is configured", () => {
    expect(isIpAllowed("8.8.8.8", [])).toBe(true);
    expect(isIpAllowed(undefined, [])).toBe(true);
  });

  it("matches an address inside a /24", () => {
    expect(isIpAllowed("192.168.1.42", ["192.168.1.0/24"])).toBe(true);
  });

  it("rejects an address outside the /24", () => {
    expect(isIpAllowed("192.168.2.1", ["192.168.1.0/24"])).toBe(false);
  });

  it("matches a bare IP with no /prefix as a /32", () => {
    expect(isIpAllowed("10.0.0.5", ["10.0.0.5"])).toBe(true);
    expect(isIpAllowed("10.0.0.6", ["10.0.0.5"])).toBe(false);
  });

  it("matches /0 against anything", () => {
    expect(isIpAllowed("1.2.3.4", ["0.0.0.0/0"])).toBe(true);
  });

  it("strips the ::ffff: IPv4-mapped-IPv6 prefix before matching", () => {
    expect(isIpAllowed("::ffff:192.168.1.42", ["192.168.1.0/24"])).toBe(true);
  });

  it("matches against any entry in a multi-CIDR list", () => {
    const cidrs = ["10.0.0.0/8", "192.168.1.0/24"];
    expect(isIpAllowed("10.5.5.5", cidrs)).toBe(true);
    expect(isIpAllowed("192.168.1.5", cidrs)).toBe(true);
    expect(isIpAllowed("172.16.0.1", cidrs)).toBe(false);
  });

  it("rejects when the address is missing or unparseable (e.g. real IPv6)", () => {
    expect(isIpAllowed(undefined, ["10.0.0.0/8"])).toBe(false);
    expect(isIpAllowed("::1", ["10.0.0.0/8"])).toBe(false);
    expect(isIpAllowed("not-an-ip", ["10.0.0.0/8"])).toBe(false);
  });

  it("rejects a malformed CIDR entry rather than throwing", () => {
    expect(isIpAllowed("10.0.0.5", ["not-a-cidr"])).toBe(false);
    expect(isIpAllowed("10.0.0.5", ["10.0.0.0/99"])).toBe(false);
  });
});
