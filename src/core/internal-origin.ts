/**
 * Origin used for loopback/self-fetch calls between protocol adapters and the
 * chat pipeline.
 *
 * `INTERNAL_HOST` exists for deployments where the server binds a specific
 * interface (or where loopback is not reachable from the process). When it is
 * left at its default, derive the best reachable address from `HOST` instead
 * of assuming 127.0.0.1: a server bound to a LAN address is not listening on
 * loopback, so adapter self-fetches would otherwise fail with ECONNREFUSED.
 */

import { config } from "./config.js";
import { isLoopbackHost, isWildcardBind } from "./local-auth.js";

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function getInternalOrigin(): string {
  const bound = (config.server.host || "").trim();
  const internal = (config.server.internalHost || "").trim();

  let connectHost: string;
  if (internal && !isWildcardBind(internal) && !isLoopbackHost(internal)) {
    connectHost = internal;
  } else if (bound && !isWildcardBind(bound)) {
    // The server is listening on a concrete address (including a specific
    // loopback family such as ::1), so prefer it over the default INTERNAL_HOST.
    connectHost = bound;
  } else if (internal && !isWildcardBind(internal)) {
    connectHost = internal;
  } else {
    connectHost = "127.0.0.1";
  }

  return `http://${formatHost(connectHost)}:${config.server.port}`;
}
