import type { Context } from "hono";
import { config } from "./config.ts";
import { isLoopbackHost, isWildcardBind } from "./local-auth.ts";

export interface ParsedAuthority {
  hostname: string;
  port: string | null;
}

function isValidPort(port: string): boolean {
  if (!/^\d+$/.test(port)) return false;
  const value = Number(port);
  return value >= 1 && value <= 65535;
}

function canonicalPort(port: string | null): string | null {
  if (port === null) return null;
  const value = Number(port);
  return value === 80 ? null : String(value);
}

export function parseAuthority(raw: string): ParsedAuthority | null {
  const value = raw.trim().toLowerCase();
  if (!value || /[\s/@?#\\]/.test(value)) return null;

  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (bracketed) {
    const port = bracketed[2] ?? null;
    if (port !== null && !isValidPort(port)) return null;
    return { hostname: bracketed[1], port: canonicalPort(port) };
  }

  const colons = (value.match(/:/g) || []).length;
  if (colons >= 2) {
    return { hostname: value, port: null };
  }
  if (colons === 1) {
    const idx = value.indexOf(":");
    const hostname = value.slice(0, idx);
    const port = value.slice(idx + 1);
    if (!hostname || !isValidPort(port)) return null;
    return { hostname, port: canonicalPort(port) };
  }
  return { hostname: value, port: null };
}

export function isTrustedAuthority(raw: string): boolean {
  const parsed = parseAuthority(raw);
  if (!parsed) return false;
  const { hostname, port } = parsed;

  if (isLoopbackHost(hostname)) return true;

  const bound = (config.server.host || "").trim();
  if (bound && !isWildcardBind(bound)) {
    const boundParsed = parseAuthority(bound);
    const boundHostname = boundParsed
      ? boundParsed.hostname
      : bound.toLowerCase().replace(/^\[|\]$/g, "");
    if (hostname === boundHostname) return true;
  }

  for (const entry of config.server.trustedHosts) {
    const trusted = parseAuthority(entry);
    if (!trusted || trusted.hostname !== hostname) continue;
    if (trusted.port === null || trusted.port === port) return true;
  }
  return false;
}

export function isLoopbackAddress(address: string): boolean {
  let value = address.trim().toLowerCase();
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  if (value.startsWith("::ffff:")) value = value.slice(7);
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return true;
  return isLoopbackHost(value);
}

export function requestPeerAddress(c: Context): string {
  const socket = (
    c.env as
      | { incoming?: { socket?: { remoteAddress?: string } } }
      | undefined
  )?.incoming?.socket;
  return typeof socket?.remoteAddress === "string"
    ? socket.remoteAddress.trim()
    : "";
}

export function getRequestAuthorities(c: Context): string[] {
  const authorities = new Set<string>();
  const host = c.req.header("host")?.trim();
  if (host) authorities.add(host.toLowerCase());
  try {
    const url = new URL(c.req.url);
    if (url.host) authorities.add(url.host.toLowerCase());
  } catch {}
  return [...authorities];
}

export function authorityLogLabel(raw: string): string {
  const parsed = parseAuthority(raw);
  if (!parsed) return "invalid";
  return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
}
