/**
 * Static contract for Qwen's specialized web modes.
 *
 * The Qwen web client selects these modes with `chat_type` +
 * `feature_config`, not with a model-catalog entry. The public model IDs below
 * are therefore virtual: they are routed to a real Qwen chat type inside the
 * completion payload and are advertised by `/v1/models` as capabilities.
 *
 * Verified against qwen-chat-fe 0.3.38:
 * - deep research: `deep_research`, `feature_config.research_mode` normal|advance
 * - web dev: `web_dev`
 * - full stack: `web_dev` (the web client has no separate full-stack chat type)
 * - slides: `slides`
 */

import type { ReasoningMode } from "./model-alias.ts";
import { SpecializedCapabilityError } from "./errors.ts";
import { isSafeCitationUrl } from "./safe-remote-url.ts";

export type SpecializedModeKind = "research" | "artifact" | "slides";

export interface SpecializedModelDefinition {
  id: string;
  label: string;
  kind: SpecializedModeKind;
  /** Upstream `chat_type`. */
  chatType: string;
  /** Upstream `sub_chat_type`. */
  subChatType: string;
  supportsAsync: boolean;
  supportsCitations: boolean;
  supportsArtifacts: boolean;
  /** Optional instruction that makes the shared engine behave as the mode. */
  promptPrefix?: string;
  description: string;
}

const DEFINITIONS: SpecializedModelDefinition[] = [
  {
    id: "qwen-deep-research",
    label: "Qwen Deep Research",
    kind: "research",
    chatType: "deep_research",
    subChatType: "deep_research",
    supportsAsync: true,
    supportsCitations: true,
    supportsArtifacts: true,
    description:
      "Runs Qwen Deep Research and returns a cited report plus report/PDF artifacts. Supports normal and advance research.",
  },
  {
    id: "qwen-web-dev",
    label: "Qwen Web Dev",
    kind: "artifact",
    chatType: "web_dev",
    subChatType: "web_dev",
    supportsAsync: true,
    supportsCitations: false,
    supportsArtifacts: true,
    description:
      "Generates interactive web components and pages (HTML/CSS/JavaScript) with a preview artifact.",
  },
  {
    id: "qwen-full-stack",
    label: "Qwen Full-Stack",
    kind: "artifact",
    chatType: "web_dev",
    subChatType: "web_dev",
    supportsAsync: true,
    supportsCitations: false,
    supportsArtifacts: true,
    promptPrefix:
      "Build a complete, runnable full-stack application. Present frontend and backend artifacts as separate, clearly labelled files or sections, including the entry point and setup instructions.",
    description:
      "Builds a complete application and returns separate frontend and backend artifacts.",
  },
  {
    id: "qwen-slides",
    label: "Qwen Slides",
    kind: "slides",
    chatType: "slides",
    subChatType: "slides",
    supportsAsync: true,
    supportsCitations: false,
    supportsArtifacts: true,
    description:
      "Generates a slide deck with preview images and a downloadable PDF artifact.",
  },
];

const BY_ID = new Map(DEFINITIONS.map((definition) => [definition.id, definition]));

/** Extra spellings accepted for convenience; they are not advertised. */
const ALIASES = new Map<string, string>([
  ["qwen-deepresearch", "qwen-deep-research"],
  ["deep-research", "qwen-deep-research"],
  ["qwen-webdev", "qwen-web-dev"],
  ["web-dev", "qwen-web-dev"],
  ["qwen-fullstack", "qwen-full-stack"],
  ["full-stack", "qwen-full-stack"],
  ["qwen-slide", "qwen-slides"],
  ["slides", "qwen-slides"],
]);

export function listSpecializedModels(): SpecializedModelDefinition[] {
  return DEFINITIONS.map((definition) => ({ ...definition }));
}

export function resolveSpecializedModel(
  modelId: unknown,
): SpecializedModelDefinition | undefined {
  if (typeof modelId !== "string") return undefined;
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return undefined;
  const id = ALIASES.get(normalized) ?? normalized;
  const definition = BY_ID.get(id);
  return definition ? { ...definition } : undefined;
}

export function isSpecializedModel(modelId: unknown): boolean {
  return resolveSpecializedModel(modelId) !== undefined;
}

export function resolveResearchMode(
  value: unknown,
  reasoningMode?: ReasoningMode,
): "normal" | "advance" {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["advance", "advanced", "deep", "high", "max"].includes(normalized)) {
      return "advance";
    }
    if (["normal", "standard", "default", "low", "minimal", "none"].includes(normalized)) {
      return "normal";
    }
  }
  // A request that explicitly asks Qwen to think on a research model maps to
  // advance research; auto and fast keep the cheaper normal pipeline.
  return reasoningMode === "thinking" ? "advance" : "normal";
}

export function buildSpecializedFeatureConfig(
  definition: SpecializedModelDefinition,
  reasoningMode: ReasoningMode | undefined,
  researchMode: "normal" | "advance",
): Record<string, unknown> {
  const mode = reasoningMode ?? "fast";
  const thinkingEnabled = mode !== "fast";
  const thinkingMode =
    mode === "thinking" ? "Thinking" : mode === "fast" ? "Fast" : "Auto";

  return {
    thinking_enabled: thinkingEnabled,
    output_schema: "phase",
    research_mode: definition.kind === "research" ? researchMode : "normal",
    auto_thinking: mode === "auto",
    thinking_mode: thinkingMode,
    ...(thinkingEnabled ? { thinking_format: "summary" } : {}),
    // The specialized modes must never silently enable web chat search.
    auto_search: false,
  };
}

export interface ExtractedArtifact {
  type: "report" | "pdf" | "image" | "code" | "link";
  url: string;
  title?: string;
}

const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|svg|avif)(?:$|[?#])/i;
const CODE_EXTENSIONS = /\.(?:html?|css|js|jsx|ts|tsx|mjs|cjs|zip|json|yaml|yml|md)(?:$|[?#])/i;

function classifyArtifact(url: string): ExtractedArtifact["type"] {
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "link";
  }
  if (/\.pdf$/i.test(pathname)) return "pdf";
  if (IMAGE_EXTENSIONS.test(pathname)) return "image";
  if (CODE_EXTENSIONS.test(pathname)) return "code";
  if (/(?:^|\/)(?:report|research|deep-research)(?:[./-]|$)/i.test(pathname)) {
    return "report";
  }
  return "link";
}

/**
 * True for a safe, absolute http(s) URL. Reuses the citation policy: no
 * embedded credentials and no local/private/metadata hosts. Nothing is fetched,
 * so no DNS resolution is attempted here.
 */
export function isSafeArtifactUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096) return false;
  return isSafeCitationUrl(trimmed);
}

/**
 * Extract report/citation/artifact URLs from the final assistant content.
 * Nothing is fetched or executed: this is presentation metadata only.
 */
export function extractArtifacts(content: unknown): ExtractedArtifact[] {
  if (typeof content !== "string" || !content) return [];
  const found = new Map<string, ExtractedArtifact>();

  const add = (url: string, title?: string) => {
    const cleaned = url.replace(/[)\],.;]+$/g, "");
    if (!isSafeArtifactUrl(cleaned)) return;
    if (!found.has(cleaned)) {
      found.set(cleaned, {
        type: classifyArtifact(cleaned),
        url: cleaned,
        ...(title && title.trim() ? { title: title.trim().slice(0, 300) } : {}),
      });
    }
  };

  // Markdown links and images: [title](url) / ![alt](url)
  const markdown = /!?\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  for (const match of content.matchAll(markdown)) {
    add(match[2], match[1]);
  }

  // Bare URLs not already captured (citations are often plain links).
  const bare = /https?:\/\/[^\s<>"'`]+/g;
  for (const match of content.matchAll(bare)) {
    add(match[0]);
  }

  return [...found.values()];
}

export function specializedCapabilityError(
  message: string,
  code: "capability_unavailable" | "capability_unsupported" = "capability_unsupported",
): SpecializedCapabilityError {
  return new SpecializedCapabilityError(message, code);
}

export function isSpecializedCapabilityFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /(?:model|feature|mode|chat[_\s-]?type)[^\n]{0,80}(?:not\s+(?:found|supported|available|enabled)|unsupported|invalid|unavailable|forbidden)|not\s+authori[sz]ed|permission\s+denied|no\s+permission/i.test(
    message,
  );
}
