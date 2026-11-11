import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";
import { Readable } from "node:stream";
import type { LookupAddress, LookupOptions } from "node:dns";

export class UnsafeRemoteUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeRemoteUrlError";
  }
}

export function isPrivateOrLocalIp(address: string): boolean {
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIP(normalized) === 4) {
    const parts = normalized.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIP(normalized) === 6) {
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("fe80:") || normalized.startsWith("ff")) return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (normalized.startsWith("::ffff:")) {
      return isPrivateOrLocalIp(normalized.slice("::ffff:".length));
    }
    return false;
  }
  return true;
}

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.goog",
]);

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (net.isIP(host) && isPrivateOrLocalIp(host)) return true;
  return false;
}

/**
 * Synchronous safety check for a citation URL. Citations are only rendered by
 * the client, never fetched by the proxy, so no DNS resolution is performed:
 * a hostname that resolves to a private address at click time is out of scope.
 */
export function isSafeCitationUrl(raw: string): boolean {
  if (typeof raw !== "string" || !raw.trim()) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) return false;
  return !isBlockedHostname(hostname);
}

/** Scheme/host/credential checks that do not require a DNS lookup. */
function parseRemoteMediaUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UnsafeRemoteUrlError("Remote media URL is not valid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnsafeRemoteUrlError(`Blocked media URL protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new UnsafeRemoteUrlError("Remote media URL must not include credentials");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHostname(hostname)) {
    throw new UnsafeRemoteUrlError(`Blocked media URL host: ${hostname}`);
  }
  return parsed;
}

async function resolvePublicAddresses(hostname: string): Promise<LookupAddress[]> {
  let records: LookupAddress[];
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw new UnsafeRemoteUrlError(`Could not resolve media URL host: ${hostname}`);
  }
  if (records.length === 0) {
    throw new UnsafeRemoteUrlError(`Could not resolve media URL host: ${hostname}`);
  }
  for (const record of records) {
    if (isPrivateOrLocalIp(record.address)) {
      throw new UnsafeRemoteUrlError(
        `Blocked media URL resolved to a private address (${record.address})`,
      );
    }
  }
  return records;
}

/**
 * Validates a URL used to download remote media (image edit sources, URL
 * attachments). Performs a full DNS check; `fetchSafeRemoteMedia` repeats the
 * validation at connection time to close the DNS-rebinding window.
 */
export async function assertSafeRemoteMediaUrl(raw: string): Promise<URL> {
  const parsed = parseRemoteMediaUrl(raw);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  await resolvePublicAddresses(hostname);
  return parsed;
}

export type SafeLookupResolver = (hostname: string) => Promise<LookupAddress[]>;

export type SafeLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void;

/**
 * DNS lookup used by the connection itself. Resolving here (rather than in a
 * separate pre-flight check) pins the address that is actually dialed, so an
 * attacker-controlled resolver cannot answer with a public address during
 * validation and a private one milliseconds later.
 */
export function createSafeLookup(
  resolver: SafeLookupResolver = (hostname) => resolvePublicAddresses(hostname),
): SafeLookup {
  return (hostname, options, callback) => {
    resolver(hostname).then(
      (addresses) => {
        if (!addresses || addresses.length === 0) {
          callback(
            new UnsafeRemoteUrlError(`Could not resolve media URL host: ${hostname}`),
            "",
            0,
          );
          return;
        }
        for (const record of addresses) {
          if (isPrivateOrLocalIp(record.address)) {
            callback(
              new UnsafeRemoteUrlError(
                `Blocked media URL resolved to a private address (${record.address})`,
              ),
              "",
              0,
            );
            return;
          }
        }
        if (options?.all) {
          callback(null, addresses);
        } else {
          const first = addresses[0]!;
          callback(null, first.address, first.family);
        }
      },
      (err: unknown) => {
        callback(
          err instanceof Error
            ? (err as NodeJS.ErrnoException)
            : new UnsafeRemoteUrlError(`Could not resolve media URL host: ${hostname}`),
          "",
          0,
        );
      },
    );
  };
}

export interface SafeRemoteFetchOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Socket inactivity timeout in milliseconds; defaults to 30s. */
  timeoutMs?: number;
}

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

type RemoteMediaFetcher = (
  raw: string,
  options?: SafeRemoteFetchOptions,
) => Promise<Response>;

let remoteMediaFetcher: RemoteMediaFetcher = fetchSafeRemoteMedia;

/**
 * @internal Test seam so route-level tests can stub media downloads without a
 * real network. Pass `null` to restore the SSRF-safe implementation.
 */
export function setRemoteMediaFetcherForTests(
  fetcher: RemoteMediaFetcher | null,
): void {
  remoteMediaFetcher = fetcher ?? fetchSafeRemoteMedia;
}

/** In-process indirection used by routes; production always hits the safe fetch. */
export function fetchRemoteMedia(
  raw: string,
  options: SafeRemoteFetchOptions = {},
): Promise<Response> {
  return remoteMediaFetcher(raw, options);
}

/**
 * Fetch a remote media URL with SSRF protection that survives DNS rebinding:
 * the hostname is resolved by the connection's own lookup hook, every returned
 * address is checked, and the request connects to the exact validated address.
 *
 * Redirects are rejected (matching the previous `redirect: "error"` callers),
 * `Accept-Encoding` is forced to `identity` so the byte cap sees raw bytes, and
 * non-2xx bodies are drained before returning.
 */
export async function fetchSafeRemoteMedia(
  raw: string,
  options: SafeRemoteFetchOptions = {},
): Promise<Response> {
  const url = parseRemoteMediaUrl(raw);
  const transport = url.protocol === "https:" ? https : http;
  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
    // Never negotiate compression: the byte cap must count the bytes the
    // caller will actually store, and no decompressor runs in this path.
    "accept-encoding": "identity",
  };

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    let req: http.ClientRequest;
    try {
      req = transport.request(
        url,
        {
          method: "GET",
          headers,
          lookup: createSafeLookup() as http.RequestOptions["lookup"],
          signal: options.signal,
        },
        (res) => {
          if (settled) {
            res.resume();
            return;
          }
          settled = true;

          const status = res.statusCode ?? 0;
          const responseHeaders = new Headers();
          for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
            responseHeaders.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
          }

          // Preserve the old `redirect: "error"` semantics: a redirect is a
          // hard failure, never followed.
          if (status >= 300 && status < 400) {
            res.resume();
            reject(
              new UnsafeRemoteUrlError(
                `Blocked media URL redirect (${status}); redirects are not followed`,
              ),
            );
            return;
          }

          // Non-success responses only expose status/headers to the caller;
          // drain the body so the socket can be reused/released.
          if (status < 200 || status >= 300) {
            res.resume();
            resolve(new Response(null, { status, headers: responseHeaders }));
            return;
          }

          const body = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
          resolve(new Response(body, { status, headers: responseHeaders }));
        },
      );
    } catch (err) {
      fail(err);
      return;
    }

    req.on("error", fail);
    const timeoutMs =
      options.timeoutMs === undefined ? DEFAULT_FETCH_TIMEOUT_MS : options.timeoutMs;
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Remote media request timed out after ${timeoutMs}ms`));
      });
    }
    req.end();
  });
}

export async function readResponseWithByteCap(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {}
    throw new Error(`Remote media too large: ${contentLength}`);
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error(`Remote media too large: ${buffer.length}`);
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > maxBytes) {
      try {
        await reader.cancel();
      } catch {}
      throw new Error(`Remote media too large: ${received}`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
