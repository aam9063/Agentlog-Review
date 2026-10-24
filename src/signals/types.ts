/**
 * Deterministic session signals (S16).
 *
 * Every field is a countable fact derived from an already parsed
 * `ParsedSession`: no LLM, no network, no repository access. Numbers only —
 * the conversion to Developing/Adequate/Strong levels belongs to a later task
 * and never happens here (S20).
 */

export interface CharStats {
  /** Mean turn length in characters, rounded to one decimal. */
  readonly mean: number;
  /** Median turn length in characters. */
  readonly median: number;
  /** Longest turn in characters. */
  readonly longest: number;
}

export interface GitCommands {
  /** Git invocations found in shell commands, including inside `cd x && git ...` compounds. */
  readonly total: number;
  /** First non-flag argument (or `"<none>"`), sorted by key ascending. */
  readonly bySubcommand: Readonly<Record<string, number>>;
}

export interface VerificationCommands {
  readonly total: number;
  /** The paired `tool_result` has `isError === true`. */
  readonly failed: number;
  /** The paired `tool_result` has `isError === false`. */
  readonly passed: number;
  /** No `tool_result` carries the call's `toolCallId`. */
  readonly unknown: number;
}

export interface ChallengeMarkers {
  /** Human turns whose text matches at least one pattern. */
  readonly turns: number;
  /** The versioned pattern sources used, reported for auditability. */
  readonly patterns: readonly string[];
}

export interface NotCapturableEntry {
  readonly signal: string;
  readonly reason: string;
}

export interface SessionSignals {
  /** Parsed ENTRIES (lines), same meaning as `ParseReport.parsedLines`. */
  readonly parsedLines: number;
  /** All normalized events, including derived part events. */
  readonly totalEvents: number;
  /** Derived child events split out of message parts. */
  readonly partEvents: number;
  /** Events with `onActiveBranch` true. */
  readonly activeEvents: number;
  /** Events with `role === "human"`. */
  readonly humanTurns: number;
  /** Turn lengths in characters over the text of the human turns. */
  readonly humanTurnChars: CharStats;
  /** Message events (`kind === "message"`) with `role === "agent"`; part events are excluded. */
  readonly agentTurns: number;
  /** `tool_call` events per `toolName`, sorted by key ascending. */
  readonly toolCallsByTool: Readonly<Record<string, number>>;
  /** `bash` calls whose arguments carry a usable `command` string. */
  readonly shellCommands: number;
  /** `bash` calls with no usable `command` string; they still count in `toolCallsByTool`. */
  readonly unusableCommandCalls: number;
  readonly gitCommands: GitCommands;
  readonly verificationCommands: VerificationCommands;
  /** `tool_result` events with `isError === true`. */
  readonly toolErrors: number;
  /** `tool_call` events with no `toolCallId` or no paired `tool_result`. */
  readonly unpairedToolCalls: number;
  /** `compaction` events. */
  readonly compactions: number;
  /**
   * Heuristic estimate, not a score (S19): a human turn mentioning a challenge
   * pattern is evidence of questioning, never a quality judgement.
   */
  readonly challengeMarkers: ChallengeMarkers;
  /** Facts the pi format does not carry at all (S17); nothing is scored for them. */
  readonly notCapturable: readonly NotCapturableEntry[];
}
