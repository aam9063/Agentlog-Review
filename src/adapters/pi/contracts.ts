import type { KeyContract } from "../drift.ts";

/**
 * pi session format v3, verified against a real session file on 2026-10-23.
 *
 * Every key set below comes from observed data, not from documentation: the
 * format is unversioned beyond the header `version` field, so the observed
 * shape is the only contract we can honestly declare. Types that pi v3 is
 * documented to emit but that the fixture never showed are deliberately left
 * out; the parser reports them as `unverifiedTypes` instead of pretending to
 * know their shape.
 */

const ENTRY_BASE = ["type", "id", "parentId", "timestamp"] as const;

export const PI_ENTRY_CONTRACTS: Readonly<Record<string, KeyContract>> = {
  session: {
    keys: ["type", "version", "id", "timestamp", "cwd"],
    required: ["type", "id", "timestamp"],
  },
  model_change: {
    keys: [...ENTRY_BASE, "provider", "modelId"],
    required: [...ENTRY_BASE, "modelId"],
  },
  thinking_level_change: {
    keys: [...ENTRY_BASE, "thinkingLevel"],
    required: [...ENTRY_BASE, "thinkingLevel"],
  },
  message: {
    keys: [...ENTRY_BASE, "message"],
    required: [...ENTRY_BASE, "message"],
  },
  custom: {
    keys: [...ENTRY_BASE, "customType", "data"],
    required: [...ENTRY_BASE, "customType", "data"],
  },
  custom_message: {
    keys: [...ENTRY_BASE, "customType", "content", "display", "details"],
    required: [...ENTRY_BASE, "customType", "content"],
  },
};

/**
 * Union of every key observed on a `message` payload. The payload is
 * role-dependent, so this is an unknown-key check only: `missing` is not
 * meaningful here and `PI_MESSAGE_REQUIRED` covers the two that always exist.
 */
export const PI_MESSAGE_KEYS: readonly string[] = [
  "role",
  "content",
  "sections",
  "timestamp",
  "toolsAdded",
  "toolsRemoved",
  "api",
  "provider",
  "model",
  "usage",
  "stopReason",
  "rawStopReason",
  "errorMessage",
  "responseId",
  "toolCallId",
  "toolName",
  "isError",
  "details",
  "thinkingLevel",
  "durationMs",
];

export const PI_MESSAGE_REQUIRED: readonly string[] = ["role", "content"];

/**
 * Message part types observed in the fixture. Parts are kept verbatim in `raw`
 * by T1 and split into their own events by T2.
 */
export const PI_MESSAGE_PART_TYPES: readonly string[] = ["text", "thinking", "toolCall", "image"];

/** gentle-pi `customType` values verified against the fixture. */
export const PI_CUSTOM_TYPES: readonly string[] = [
  "gentle-pi.session-worktree/v1",
  "gentle-pi.session-change/v1",
  "gentle-pi.review-reminder-receipt/v1",
];

/**
 * Receipt kinds declared by the current emitters. `nudged` and `acknowledged`
 * never appeared in the fixture, so the adapter has to tolerate them without
 * a sample to compare against.
 */
export const PI_RECEIPT_KINDS: readonly string[] = ["mutation", "nudged", "acknowledged"];
