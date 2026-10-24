import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { findDrift } from "../drift.ts";
import { PI_ENTRY_CONTRACTS, PI_MESSAGE_KEYS, PI_MESSAGE_REQUIRED } from "./contracts.ts";
import type {
  AgentId,
  ContentRecord,
  DriftFinding,
  EventKind,
  EventRecord,
  ParentFinding,
  ParsedSession,
  ParseReport,
  RawLine,
  Role,
  SessionRecord,
} from "../../model/types.ts";

/** A line that produced an event candidate, before the tree is resolved. */
interface Candidate {
  readonly lineNumber: number;
  readonly hash: string;
  readonly entry: Record<string, unknown>;
  readonly type: string;
  /** The entry's own `id` field, which is what children point at. */
  readonly sourceId: string | null;
  readonly id: string;
}

export interface ParseOptions {
  /** Agent label recorded on the session; defaults to `pi`. */
  readonly agent?: AgentId;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Stable JSON with sorted keys, so a content-derived id never depends on the
 * key order the writer happened to use.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${fields.join(",")}}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

const ROLE_BY_MESSAGE_ROLE: Readonly<Record<string, Role>> = {
  system: "system",
  user: "human",
  assistant: "agent",
  toolResult: "tool",
};

const KIND_BY_TYPE: Readonly<Record<string, EventKind>> = {
  session: "session_header",
  message: "message",
  custom: "custom",
  custom_message: "custom_message",
  compaction: "compaction",
  branch_summary: "branch_summary",
  context_edit: "context_edit",
  label: "label",
  model_change: "model_change",
  thinking_level_change: "thinking_level_change",
};

function roleOf(entry: Record<string, unknown>, type: string): Role {
  if (type !== "message") {
    return type === "unknown" ? "unknown" : "system";
  }
  const message = asRecord(entry["message"]);
  const role = message === null ? null : asString(message["role"]);
  if (role === null) {
    return "unknown";
  }
  return ROLE_BY_MESSAGE_ROLE[role] ?? "unknown";
}

function kindOf(entry: Record<string, unknown>, type: string): EventKind {
  if (type === "message") {
    const message = asRecord(entry["message"]);
    if (message !== null && asString(message["role"]) === "toolResult") {
      return "tool_result";
    }
    return "message";
  }
  return KIND_BY_TYPE[type] ?? "unknown";
}

/**
 * Text parts only. `thinking` and `toolCall` parts are deliberately excluded
 * from `content`: reasoning is stored but never scored, and both stay
 * recoverable from `raw`.
 */
function messageContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of content) {
    const record = asRecord(part);
    if (record === null || asString(record["type"]) !== "text") {
      continue;
    }
    const text = asString(record["text"]);
    if (text !== null) {
      parts.push(text);
    }
  }
  return parts.join("\n");
}

function textOf(entry: Record<string, unknown>, type: string): string {
  if (type === "message") {
    const message = asRecord(entry["message"]);
    return message === null ? "" : messageContentText(message["content"]);
  }
  if (type === "custom_message") {
    return asString(entry["content"]) ?? "";
  }
  if (type === "custom") {
    return canonicalJson(entry["data"] ?? null);
  }
  return "";
}

function toolNameOf(entry: Record<string, unknown>, type: string): string | null {
  if (type !== "message") {
    return null;
  }
  const message = asRecord(entry["message"]);
  if (message === null) {
    return null;
  }
  const direct = asString(message["toolName"]);
  if (direct !== null) {
    return direct;
  }
  const content = message["content"];
  if (!Array.isArray(content)) {
    return null;
  }
  for (const part of content) {
    const record = asRecord(part);
    if (record !== null && asString(record["type"]) === "toolCall") {
      const name = asString(record["toolName"]);
      if (name !== null) {
        return name;
      }
    }
  }
  return null;
}

function toolCallIdOf(entry: Record<string, unknown>, type: string): string | null {
  if (type !== "message") {
    return null;
  }
  const message = asRecord(entry["message"]);
  if (message === null) {
    return null;
  }
  const direct = asString(message["toolCallId"]);
  if (direct !== null) {
    return direct;
  }
  const content = message["content"];
  if (!Array.isArray(content)) {
    return null;
  }
  for (const part of content) {
    const record = asRecord(part);
    if (record !== null && asString(record["type"]) === "toolCall") {
      const id = asString(record["toolCallId"]);
      if (id !== null) {
        return id;
      }
    }
  }
  return null;
}

function isErrorOf(entry: Record<string, unknown>, type: string): boolean {
  if (type !== "message") {
    return false;
  }
  const message = asRecord(entry["message"]);
  return message !== null && message["isError"] === true;
}

/**
 * Derived child events for the non-text parts of a message, in source order.
 *
 * Text stays in the message's own content; `thinking`, `toolCall` and `image`
 * parts split into `reasoning`, `tool_call` and `attachment` events. Images are
 * referenced, never inlined: their event text is empty (S15). Part types with
 * no verified contract are not invented here; they stay recoverable in `raw`.
 */
interface PartEventSpec {
  readonly partIndex: number;
  readonly kind: EventKind;
  readonly toolName: string | null;
  readonly toolCallId: string | null;
  readonly text: string;
}

function partSpecsOf(entry: Record<string, unknown>, type: string): PartEventSpec[] {
  if (type !== "message") {
    return [];
  }
  const message = asRecord(entry["message"]);
  const content = message === null ? null : message["content"];
  if (!Array.isArray(content)) {
    return [];
  }
  const specs: PartEventSpec[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const record = asRecord(content[index]);
    if (record === null) {
      continue;
    }
    const partType = asString(record["type"]);
    if (partType === "thinking") {
      specs.push({
        partIndex: index,
        kind: "reasoning",
        toolName: null,
        toolCallId: null,
        text: asString(record["thinking"]) ?? "",
      });
    } else if (partType === "toolCall") {
      const arguments_ = record["arguments"];
      specs.push({
        partIndex: index,
        kind: "tool_call",
        toolName: asString(record["toolName"]),
        toolCallId: asString(record["toolCallId"]),
        text: arguments_ === undefined ? "" : canonicalJson(arguments_),
      });
    } else if (partType === "image") {
      specs.push({
        partIndex: index,
        kind: "attachment",
        toolName: null,
        toolCallId: null,
        text: "",
      });
    }
  }
  return specs;
}

function timestampOf(entry: Record<string, unknown>): string | null {
  return asString(entry["timestamp"]);
}

/** Later timestamp wins; equal timestamps are broken by id, never by position. */
function isLater(a: Candidate, b: Candidate): boolean {
  const left = timestampOf(a.entry) ?? "";
  const right = timestampOf(b.entry) ?? "";
  if (left !== right) {
    return left > right;
  }
  return a.id > b.id;
}

interface TreeResult {
  readonly onBranch: ReadonlySet<string>;
  /** Child event id to parent event id, only for resolved parents. */
  readonly parentOf: ReadonlyMap<string, string>;
  readonly findings: readonly ParentFinding[];
}

/**
 * Resolves the active branch by walking from the latest leaf to the root.
 *
 * `parentId` in the file points at the entry's own `id`, while events carry
 * normalized ids, so the raw reference is translated through the source-id map
 * first. Without that translation nothing resolves and every node looks like a
 * leaf.
 *
 * The format is a tree, so a reader that treats every line as an event counts
 * abandoned branches as work. The leaf is chosen by timestamp and id so the
 * answer does not change when the file's lines are shuffled.
 */
function resolveTree(candidates: readonly Candidate[]): TreeResult {
  const byId = new Map<string, Candidate>();
  const eventIdBySourceId = new Map<string, string>();
  for (const candidate of candidates) {
    byId.set(candidate.id, candidate);
    if (candidate.sourceId !== null && !eventIdBySourceId.has(candidate.sourceId)) {
      eventIdBySourceId.set(candidate.sourceId, candidate.id);
    }
  }

  const parentOf = new Map<string, string>();
  const children = new Map<string, Candidate[]>();
  const findings: ParentFinding[] = [];

  for (const candidate of candidates) {
    if (!("parentId" in candidate.entry)) {
      if (candidate.type !== "session") {
        findings.push({
          lineNumber: candidate.lineNumber,
          id: candidate.id,
          parentId: "<absent>",
          reason: "absent",
        });
      }
      continue;
    }

    const rawParent: unknown = candidate.entry["parentId"];
    if (rawParent === null) {
      continue;
    }
    const rawParentKey = typeof rawParent === "string" ? rawParent : String(rawParent);
    const parentEventId = eventIdBySourceId.get(rawParentKey);
    if (parentEventId === undefined) {
      findings.push({
        lineNumber: candidate.lineNumber,
        id: candidate.id,
        parentId: rawParentKey,
        reason: "unresolved",
      });
      continue;
    }
    parentOf.set(candidate.id, parentEventId);
    const siblings = children.get(parentEventId);
    if (siblings === undefined) {
      children.set(parentEventId, [candidate]);
    } else {
      siblings.push(candidate);
    }
  }

  const nodes = candidates.filter((candidate) => "parentId" in candidate.entry);
  const leaves = nodes.filter((node) => !children.has(node.id));
  const onBranch = new Set<string>();
  if (leaves.length === 0) {
    return { onBranch, parentOf, findings };
  }

  let leaf = leaves[0] as Candidate;
  for (const candidate of leaves) {
    if (isLater(candidate, leaf)) {
      leaf = candidate;
    }
  }

  let cursor: Candidate | undefined = leaf;
  while (cursor !== undefined && !onBranch.has(cursor.id)) {
    onBranch.add(cursor.id);
    const next: string | undefined = parentOf.get(cursor.id);
    cursor = next === undefined ? undefined : byId.get(next);
  }

  return { onBranch, parentOf, findings };
}

function assignIds(
  parsed: readonly { lineNumber: number; hash: string; entry: Record<string, unknown>; type: string }[],
  sessionId: string,
  agent: AgentId,
): Candidate[] {
  const sourceIdUse = new Map<string, number>();
  const contentUse = new Map<string, number>();
  const candidates: Candidate[] = [];

  for (const item of parsed) {
    const sourceId = asString(item.entry["id"]);
    let base: string;
    let counter: number;
    if (sourceId !== null && sourceId !== "") {
      base = `ev:${agent}:${sessionId}:${sourceId}`;
      counter = sourceIdUse.get(base) ?? 0;
      sourceIdUse.set(base, counter + 1);
    } else {
      base = `ev:${agent}:${sessionId}:h${item.hash.slice(0, 16)}`;
      counter = contentUse.get(base) ?? 0;
      contentUse.set(base, counter + 1);
    }
    candidates.push({ ...item, sourceId, id: counter === 0 ? base : `${base}~${counter}` });
  }

  return candidates;
}

function collectModels(candidates: readonly Candidate[]): string[] {
  const models: string[] = [];
  const seen = new Set<string>();
  const add = (model: string | null): void => {
    if (model === null || model === "" || seen.has(model)) {
      return;
    }
    seen.add(model);
    models.push(model);
  };
  for (const candidate of candidates) {
    if (candidate.type === "model_change") {
      add(asString(candidate.entry["modelId"]));
    }
    if (candidate.type === "message") {
      const message = asRecord(candidate.entry["message"]);
      if (message !== null) {
        add(asString(message["model"]));
      }
    }
  }
  return models;
}

/**
 * Parses one pi session file body.
 *
 * Every non-blank line lands in exactly one bucket: an event, a raw-only line,
 * or a malformed line. Nothing is dropped and nothing is silently ignored.
 */
export function parsePiSessionText(text: string, options: ParseOptions = {}): ParsedSession {
  const agent = options.agent ?? "pi";
  const raw: RawLine[] = [];
  const drift: DriftFinding[] = [];
  const unverified = new Set<string>();
  const parsedEntries: {
    lineNumber: number;
    hash: string;
    entry: Record<string, unknown>;
    type: string;
  }[] = [];
  let malformed = 0;
  let rawOnly = 0;
  let blankLines = 0;

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index] ?? "";
    const lineNumber = index + 1;
    if (lineText.trim() === "") {
      blankLines += 1;
      continue;
    }
    const hash = sha256(lineText);
    raw.push({ lineNumber, text: lineText, sha256: hash });

    let value: unknown;
    try {
      value = JSON.parse(lineText);
    } catch {
      malformed += 1;
      continue;
    }

    const entry = asRecord(value);
    if (entry === null) {
      malformed += 1;
      continue;
    }

    const type = asString(entry["type"]);
    if (type === null) {
      rawOnly += 1;
      continue;
    }

    parsedEntries.push({ lineNumber, hash, entry, type });

    const contract = PI_ENTRY_CONTRACTS[type];
    if (contract === undefined) {
      unverified.add(type);
    } else {
      const finding = findDrift(lineNumber, "entry", type, Object.keys(entry), contract);
      if (finding !== null) {
        drift.push(finding);
      }
    }

    if (type === "message") {
      const message = asRecord(entry["message"]);
      if (message !== null) {
        const finding = findDrift(lineNumber, "message", type, Object.keys(message), {
          keys: PI_MESSAGE_KEYS,
          required: PI_MESSAGE_REQUIRED,
        });
        if (finding !== null) {
          drift.push(finding);
        }
      }
    }
  }

  const header = parsedEntries.find((item) => item.type === "session");
  const sessionId =
    header === undefined
      ? `unknown-${sha256(text).slice(0, 16)}`
      : (asString(header.entry["id"]) ?? `unknown-${sha256(text).slice(0, 16)}`);

  const candidates = assignIds(parsedEntries, sessionId, agent);
  const tree = resolveTree(candidates);

  let endedAt: string | null = null;
  for (const candidate of candidates) {
    const stamp = timestampOf(candidate.entry);
    if (stamp !== null && (endedAt === null || stamp > endedAt)) {
      endedAt = stamp;
    }
  }

  const headerVersion = header === undefined ? null : header.entry["version"];
  const session: SessionRecord = {
    id: sessionId,
    agent,
    formatVersion: typeof headerVersion === "number" ? headerVersion : null,
    cwd: header === undefined ? null : asString(header.entry["cwd"]),
    startedAt: header === undefined ? null : timestampOf(header.entry),
    endedAt,
    models: collectModels(candidates),
  };

  const events: EventRecord[] = [];
  const content: ContentRecord[] = [];
  let partEvents = 0;

  for (const candidate of candidates) {
    const ref = { lineNumber: candidate.lineNumber, sha256: candidate.hash };
    const role = roleOf(candidate.entry, candidate.type);
    const kind = kindOf(candidate.entry, candidate.type);
    events.push({
      id: candidate.id,
      sessionId,
      parentId: tree.parentOf.get(candidate.id) ?? null,
      timestamp: timestampOf(candidate.entry),
      role,
      kind,
      toolName: toolNameOf(candidate.entry, candidate.type),
      toolCallId: toolCallIdOf(candidate.entry, candidate.type),
      partIndex: null,
      isError: isErrorOf(candidate.entry, candidate.type),
      onActiveBranch: tree.onBranch.has(candidate.id),
      customType: asString(candidate.entry["customType"]),
      raw: ref,
    });
    content.push({
      eventId: candidate.id,
      text: textOf(candidate.entry, candidate.type),
      redacted: false,
      raw: ref,
    });

    // Part expansion happens after tree resolution, so the tree never sees
    // derived children: they inherit the message's own branch membership.
    for (const spec of partSpecsOf(candidate.entry, candidate.type)) {
      const childId = `${candidate.id}#p${String(spec.partIndex)}`;
      events.push({
        id: childId,
        sessionId,
        parentId: candidate.id,
        timestamp: timestampOf(candidate.entry),
        role,
        kind: spec.kind,
        toolName: spec.toolName,
        toolCallId: spec.toolCallId,
        partIndex: spec.partIndex,
        isError: false,
        onActiveBranch: tree.onBranch.has(candidate.id),
        customType: null,
        raw: ref,
      });
      content.push({
        eventId: childId,
        text: spec.text,
        redacted: false,
        raw: ref,
      });
      partEvents += 1;
    }
  }

  const report: ParseReport = {
    totalLines: raw.length,
    parsedLines: parsedEntries.length,
    partEvents,
    rawOnly,
    malformed,
    blankLines,
    unverifiedTypes: [...unverified].sort(),
    drift,
    parentFindings: tree.findings,
    activeBranchLength: tree.onBranch.size,
  };

  return { session, events, content, raw, report };
}

export async function parsePiSessionFile(
  path: string,
  options: ParseOptions = {},
): Promise<ParsedSession> {
  const text = await readFile(path, "utf8");
  return parsePiSessionText(text, options);
}
