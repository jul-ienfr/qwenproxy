/**
 * Normalisation of Qwen web-search metadata into client-facing citations.
 *
 * Qwen emits a delta with `name: "web_search"` whose
 * `extra.web_search_info` is an array of `{ title, url, hostname }`. This
 * module keeps the stable subset, drops unsafe URLs and builds the OpenAI
 * `annotations` shape plus the documented `search_results` extension.
 */

import { isSafeCitationUrl } from "./safe-remote-url.ts";
import { logger } from "./logger.ts";

export interface SearchSource {
  /** 1-based position in the final source list. */
  index: number;
  title: string;
  url: string;
  hostname: string;
}

export interface SearchResult {
  index: number;
  title: string;
  url: string;
  hostname: string;
}

export interface UrlCitationAnnotation {
  type: "url_citation";
  url_citation: {
    start_index: number;
    end_index: number;
    title: string;
    url: string;
  };
}

export interface SearchOutcome {
  requested: boolean;
  ran: boolean;
  source_count: number;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function sourceList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const record = asRecord(raw);
  for (const key of [
    "web_search_info",
    "search_results",
    "results",
    "sources",
    "items",
    "data",
  ]) {
    if (Array.isArray(record[key])) return record[key];
  }
  return [];
}

function hostnameFor(url: string, raw: Record<string, any>): string {
  const explicit = firstString(
    raw.hostname,
    raw.host,
    raw.site_name,
    raw.siteName,
    raw.domain,
    raw.source,
  );
  if (explicit) return explicit;
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Extract upstream search metadata carried by a delta or chunk.
 */
export function extractSearchInfo(delta: any, chunk?: any): unknown {
  return (
    delta?.extra?.web_search_info ??
    delta?.web_search_info ??
    chunk?.extra?.web_search_info ??
    chunk?.web_search_info ??
    chunk?.choices?.[0]?.delta?.extra?.web_search_info
  );
}

export function isSearchMetadataDelta(delta: any): boolean {
  return delta?.name === "web_search";
}

/**
 * Normalise one upstream source list. Unsafe or malformed URLs are dropped
 * with a warning; the rest are deduplicated by URL and re-indexed from 1.
 */
export function normalizeSearchSources(raw: unknown): SearchSource[] {
  const seen = new Set<string>();
  const sources: SearchSource[] = [];

  for (const item of sourceList(raw)) {
    const record =
      typeof item === "string" ? { url: item } : asRecord(item);
    const url = firstString(record.url, record.link, record.href, record.uri);
    if (!url) continue;
    if (!isSafeCitationUrl(url)) {
      logger.warn("[search] dropping unsafe citation URL", {
        hostname: hostnameFor(url, record) || null,
      });
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);

    const hostname = hostnameFor(url, record);
    const title =
      firstString(record.title, record.name, record.snippet, record.text) ||
      hostname ||
      url;
    sources.push({ index: sources.length + 1, title, url, hostname });
  }

  return sources;
}

/**
 * Append new sources to the ones already collected for this response, keeping
 * first-seen order and unique URLs.
 */
export function mergeSearchSources(
  existing: SearchSource[],
  raw: unknown,
): SearchSource[] {
  const incoming = normalizeSearchSources(raw);
  if (incoming.length === 0) return existing;

  const seen = new Set(existing.map((source) => source.url));
  const merged = [...existing];
  for (const source of incoming) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    merged.push({ ...source, index: merged.length + 1 });
  }
  return merged;
}

export function toSearchResults(sources: SearchSource[]): SearchResult[] {
  return sources.map(({ index, title, url, hostname }) => ({
    index,
    title,
    url,
    hostname,
  }));
}

function normalizeForCompare(url: string): string {
  return url.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findCitationSpan(
  content: string,
  source: SearchSource,
): { start: number; end: number } {
  // 1. Markdown link pointing at the source.
  const linkPattern = /\[[^\]]*\]\(([^)\s]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(content)) !== null) {
    if (normalizeForCompare(match[1]) === source.url) {
      return { start: match.index, end: match.index + match[0].length };
    }
  }

  // 2. Raw URL in the answer.
  const urlIndex = content.indexOf(source.url);
  if (urlIndex !== -1) {
    return { start: urlIndex, end: urlIndex + source.url.length };
  }

  // 3. Numeric marker such as [1] (not part of [12]).
  const markerPattern = new RegExp(
    `(?<!\\d)\\[${escapeRegExp(String(source.index))}\\](?!\\d)`,
  );
  const marker = markerPattern.exec(content);
  if (marker) {
    return { start: marker.index, end: marker.index + marker[0].length };
  }

  return { start: 0, end: 0 };
}

/**
 * Build one OpenAI-style annotation per unique source. When the answer does
 * not reference a source explicitly, offsets fall back to `0,0` and the full
 * source list remains available through `search_results`.
 */
export function buildUrlCitationAnnotations(
  content: string,
  sources: SearchSource[],
): UrlCitationAnnotation[] {
  if (sources.length === 0) return [];

  return sources.map((source) => {
    const span = findCitationSpan(content, source);
    return {
      type: "url_citation" as const,
      url_citation: {
        start_index: span.start,
        end_index: span.end,
        title: source.title,
        url: source.url,
      },
    };
  });
}

export function buildSearchOutcome(
  requested: boolean,
  sources: SearchSource[],
): SearchOutcome {
  return {
    requested,
    ran: sources.length > 0,
    source_count: sources.length,
  };
}

export function webSearchHeaderValue(
  requested: boolean,
  sources: SearchSource[] | null,
): "not_requested" | "requested" | "ran" | "no_results" {
  if (!requested) return "not_requested";
  if (sources === null) return "requested";
  return sources.length > 0 ? "ran" : "no_results";
}
