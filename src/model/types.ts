/**
 * Normalized records.
 *
 * The three tables mirror agent-traces (MIT) so a corpus export stays
 * compatible later, but the tree layer is ours: agent-traces stores `parentId`
 * as a column and never resolves the active branch, which is exactly the part
 * Puerta 1 has to prove.
 */

export type AgentId = "pi" | "claude-code" | "codex" | "copilot";

export type Role = "human" | "agent" | "tool" | "system" | "unknown";

/**
 * Structural kinds are emitted by T1. `tool_call`, `tool_result` and
 * `reasoning` are reserved for T2, which splits message parts; T1 keeps the
 * entry intact in `raw` rather than guessing.
 */
export type EventKind =
  | "session_header"
  | "message"
  | "custom"
  | "custom_message"
  | "compaction"
  | "branch_summary"
  | "context_edit"
  | "label"
  | "model_change"
  | "thinking_level_change"
  | "tool_call"
  | "tool_result"
  | "reasoning"
  | "unknown";

/** Where a piece of content came from, so `raw` stays the source of truth. */
export interface RawRef {
  readonly lineNumber: number;
  readonly sha256: string;
}

export interface SessionRecord {
  readonly id: string;
  readonly agent: AgentId;
  /** Format version declared by the file header, when it declares one. */
  readonly formatVersion: number | null;
  /** Working directory recorded by the agent, verbatim. */
  readonly cwd: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly models: readonly string[];
}

export interface EventRecord {
  readonly id: string;
  readonly sessionId: string;
  /** `null` for a real root; absent in the source means "not a tree node". */
  readonly parentId: string | null;
  readonly timestamp: string | null;
  readonly role: Role;
  readonly kind: EventKind;
  readonly toolName: string | null;
  readonly isError: boolean;
  readonly onActiveBranch: boolean;
  readonly customType: string | null;
  readonly raw: RawRef;
}

export interface ContentRecord {
  /** One record per event, even when `text` is empty, so recovery is total. */
  readonly eventId: string;
  readonly text: string;
  /** Set by the redaction stage, never by the parser. */
  readonly redacted: boolean;
  readonly raw: RawRef;
}

export type DriftScope = "entry" | "message";

export interface DriftFinding {
  readonly lineNumber: number;
  readonly scope: DriftScope;
  readonly type: string;
  readonly unknownKeys: readonly string[];
  readonly missingKeys: readonly string[];
}

export interface ParentFinding {
  readonly lineNumber: number;
  readonly id: string;
  /** Absent `parentId` is reported as `<absent>`, never as `null`. */
  readonly parentId: string;
  readonly reason: "unresolved" | "absent";
}

export interface ParseReport {
  /** Every line that is not blank, and only those. */
  readonly totalLines: number;
  /** Lines that produced an event. Entries with drift are counted here. */
  readonly parsed: number;
  /** JSON that parsed but declared no usable `type`, so it stays raw-only. */
  readonly rawOnly: number;
  readonly malformed: number;
  readonly blankLines: number;
  /** Entry types seen that have no verified contract yet. */
  readonly unverifiedTypes: readonly string[];
  readonly drift: readonly DriftFinding[];
  readonly parentFindings: readonly ParentFinding[];
  readonly activeBranchLength: number;
}

export interface RawLine {
  readonly lineNumber: number;
  readonly text: string;
  readonly sha256: string;
}

export interface ParsedSession {
  readonly session: SessionRecord;
  readonly events: readonly EventRecord[];
  readonly content: readonly ContentRecord[];
  /** Every non-blank line, verbatim, whether it parsed or not. */
  readonly raw: readonly RawLine[];
  readonly report: ParseReport;
}
