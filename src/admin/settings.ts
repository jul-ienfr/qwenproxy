/**
 * Allowlisted runtime settings for the dashboard.
 *
 * Only descriptors in this file can be read or written; anything else is
 * rejected. Each descriptor states whether the running process applies the
 * change immediately (all current entries are hot).
 */

import {
  config,
  getRuntimeChatMode,
  setRuntimeChatMode,
} from "../core/config.ts";
import { parseProxyUrl } from "../core/proxy-config.ts";
import { updateEnvVariable } from "../core/local-auth.ts";
import { saveTuiSettings } from "../tui/settings.ts";

export type SettingType = "string" | "number" | "boolean" | "select";

export interface SettingDescriptor {
  key: string;
  label: string;
  group: string;
  type: SettingType;
  value: string | number | boolean;
  options?: string[];
  restartRequired: boolean;
  help: string;
}

const APPLIED_SETTINGS = [
  "chat_mode",
  "global_proxy_url",
  "chat_request_log",
  "rate_limit_requests",
  "rate_limit_tokens",
  "user_default_rpm",
  "user_default_concurrency",
] as const;

type AppliedSetting = (typeof APPLIED_SETTINGS)[number];

function parseNonNegativeInteger(value: unknown, name: string): number {
  const number =
    typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(number) || number < 0 || !Number.isInteger(number)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return number;
}

function parseBoolean(value: unknown, name: string): boolean {
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "off") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

export function listSettings(): SettingDescriptor[] {
  return [
    {
      key: "chat_mode",
      label: "Chat mode",
      group: "Runtime",
      type: "select",
      value: getRuntimeChatMode(),
      options: ["thread", "thread-temp", "stateless", "stateless-temp"],
      restartRequired: false,
      help: "Controls whether conversations reuse Qwen threads.",
    },
    {
      key: "global_proxy_url",
      label: "Global outbound proxy",
      group: "Network",
      type: "string",
      value: config.proxy.url,
      restartRequired: false,
      help: "Fallback proxy (http/https/socks5). Per-account proxy wins.",
    },
    {
      key: "chat_request_log",
      label: "Verbose chat request logging",
      group: "Logging",
      type: "boolean",
      value: config.logging.chatRequests,
      restartRequired: false,
      help: "Log full chat request payloads at debug level.",
    },
    {
      key: "rate_limit_requests",
      label: "Advertised request limit",
      group: "Rate-limit headers",
      type: "number",
      value: config.server.rateLimit.requests,
      restartRequired: false,
      help: "Value used in x-ratelimit-limit-requests response headers.",
    },
    {
      key: "rate_limit_tokens",
      label: "Advertised token limit",
      group: "Rate-limit headers",
      type: "number",
      value: config.server.rateLimit.tokens,
      restartRequired: false,
      help: "Value used in x-ratelimit-limit-tokens response headers.",
    },
    {
      key: "user_default_rpm",
      label: "Default user RPM",
      group: "Users",
      type: "number",
      value: config.users.defaultRpm,
      restartRequired: false,
      help: "Default requests/minute for newly created API-key users. 0 = unlimited.",
    },
    {
      key: "user_default_concurrency",
      label: "Default user concurrency",
      group: "Users",
      type: "number",
      value: config.users.defaultConcurrency,
      restartRequired: false,
      help: "Default concurrent streams for newly created API-key users. 0 = unlimited.",
    },
  ];
}

export function applySetting(
  key: string,
  rawValue: unknown,
): SettingDescriptor {
  if (!(APPLIED_SETTINGS as readonly string[]).includes(key)) {
    throw new Error(`Unknown setting: ${key}`);
  }
  const settingKey = key as AppliedSetting;

  switch (settingKey) {
    case "chat_mode": {
      const mode = setRuntimeChatMode(String(rawValue));
      saveTuiSettings({ chat: { mode } });
      break;
    }
    case "global_proxy_url": {
      const value = String(rawValue ?? "").trim();
      if (value) parseProxyUrl(value);
      config.proxy.url = value;
      updateEnvVariable("PROXY_URL", value);
      break;
    }
    case "chat_request_log": {
      const value = parseBoolean(rawValue, "chat_request_log");
      config.logging.chatRequests = value;
      updateEnvVariable("CHAT_REQUEST_LOG", value ? "true" : "false");
      break;
    }
    case "rate_limit_requests": {
      const value = parseNonNegativeInteger(
        rawValue,
        "rate_limit_requests",
      );
      config.server.rateLimit.requests = value;
      updateEnvVariable("RATE_LIMIT_REQUESTS", String(value));
      break;
    }
    case "rate_limit_tokens": {
      const value = parseNonNegativeInteger(rawValue, "rate_limit_tokens");
      config.server.rateLimit.tokens = value;
      updateEnvVariable("RATE_LIMIT_TOKENS", String(value));
      break;
    }
    case "user_default_rpm": {
      const value = parseNonNegativeInteger(rawValue, "user_default_rpm");
      config.users.defaultRpm = value;
      updateEnvVariable("USER_RATE_LIMIT_RPM", String(value));
      break;
    }
    case "user_default_concurrency": {
      const value = parseNonNegativeInteger(
        rawValue,
        "user_default_concurrency",
      );
      config.users.defaultConcurrency = value;
      updateEnvVariable("USER_MAX_CONCURRENCY", String(value));
      break;
    }
  }

  const updated = listSettings().find((entry) => entry.key === settingKey);
  if (!updated) throw new Error(`Setting disappeared: ${settingKey}`);
  return updated;
}

export function applySettings(
  values: Record<string, unknown>,
): SettingDescriptor[] {
  const keys = Object.keys(values);
  if (keys.length === 0) throw new Error("No settings supplied");
  for (const key of keys) {
    applySetting(key, values[key]);
  }
  return listSettings();
}

export function isKnownSetting(key: string): boolean {
  return (APPLIED_SETTINGS as readonly string[]).includes(key);
}
