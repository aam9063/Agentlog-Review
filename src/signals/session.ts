import type { ParsedSession } from "../model/types.ts";
import type {
  CharStats,
  NotCapturableEntry,
  SessionSignals,
} from "./types.ts";

/**
 * Versioned pattern list for verification commands (S16): test runners,
 * builds, lint and typecheck. Sources are matched case-insensitively against
 * the full command string. Bump the version whenever the list changes so a
 * reported number stays auditable against the list that produced it.
 */
export const VERIFICATION_PATTERNS_VERSION = 1;
export const VERIFICATION_PATTERNS: readonly string[] = [
  "\\btest\\b",
  "\\bvitest\\b",
  "\\bjest\\b",
  "\\bpytest\\b",
  "\\bbuild\\b",
  "\\bcompile\\b",
  "\\blint\\b",
  "\\beslint\\b",
  "\\btypecheck\\b",
  "\\btype-check\\b",
  "\\btsc\\b",
  "\\bmypy\\b",
  "\\bcheck\\b",
];

/**
 * Versioned pattern list for challenge markers (S19).
 *
 * HEURISTIC ESTIMATE, NOT A SCORE: a human turn matching one of these is
 * evidence that the human questioned the agent's work; it is reported as a
 * countable estimate together with the pattern list itself so anyone can audit
 * what was matched. It never feeds a quality level in this task (S20).
 *
 * The list covers Spanish and English so the signal does not punish the
 * language the candidate writes in.
 */
export const CHALLENGE_PATTERNS_VERSION = 2;
export const CHALLENGE_PATTERNS: readonly string[] = [
  "\\bseguro que\\b",
  "\\best[aá]s seguro\\b",
  "\\bdudas? que\\b",
  "no me convence",
  "\\bde verdad\\b",
  "are you sure",
  "\\bi (?:doubt|question) (?:that|this|it)\\b",
  "\\bnot convinced\\b",
  "¿",
  "\\?",
  "por qu[eé]",
  "\\bpero\\b",
  "\\bsino\\b",
  "\\ben realidad\\b",
  "\\brevis[aá]\\b",
  "\\bmir[aá]\\b",
  "\\besper[aá]\\b",
  "\\bpara\\b",
  "no funciona",
  "no anda",
  "est[aá] mal",
  "\\barregl[aá]\\b",
  "\\bcambi[aá]\\b",
  "\\bde nuevo\\b",
  "\\botra vez\\b",
  "\\bwhy\\b",
  "\\bbut\\b",
  "\\binstead\\b",
  "\\bactually\\b",
  "\\bcheck\\b",
  "\\bwait\\b",
  "does not work",
  "\\bbroken\\b",
  "\\bwrong\\b",
  "\\bagain\\b",
];

const VERIFICATION_REGEXES = VERIFICATION_PATTERNS.map((source) => new RegExp(source, "i"));
const CHALLENGE_REGEXES = CHALLENGE_PATTERNS.map((source) => new RegExp(source, "i"));

/**
 * S17: pi session files carry no exit code anywhere (verified on real data:
 * zero occurrences of any exit-code field). The only failure signal the format
 * emits is `message.isError`, exposed by T2 as `EventRecord.isError` on
 * `tool_result` events, so command outcomes are read from there and nothing is
 * ever scored for a missing exit code.
 */
const EXIT_CODE_REASON =
  "el formato de sesion de pi no tiene ningun campo de codigo de salida; el unico senal de fallo que emite es message.isError, asi que el resultado de cada comando se informa unicamente como isError";

/** The `tool_call` content text is the canonical JSON of the part's arguments. */
function commandFromArguments(text: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const command = record["command"];
  return typeof command === "string" ? command : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function charStats(lengths: readonly number[]): CharStats {
  if (lengths.length === 0) {
    return { mean: 0, median: 0, longest: 0 };
  }
  const sorted = [...lengths].sort((a, b) => a - b);
  const total = sorted.reduce((sum, length) => sum + length, 0);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  return { mean: round1(total / sorted.length), median, longest: sorted[sorted.length - 1] ?? 0 };
}

/**
 * First argument after `git` that is not a flag.
 *
 * The global git options that can precede the subcommand (`-C`, `-c`,
 * `--git-dir`, `--work-tree`) all take a separate value, so the token right
 * after a flag is skipped together with the flag; that is what makes
 * `git -C /x status` count as `status`. A lone `git` yields `"<none>"`.
 */
function gitSubcommand(command: string): string {  const tokens = command.trim().split(/\s+/);
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      break;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    return token;
  }
  return "<none>";
}

/**
 * Git invocations inside one command string.
 *
 * Real sessions rarely run git alone: they write `cd /repo && git status`.
 * The head-of-command rule of the first brief misses all of those, so the
 * command is split on the shell separators `&&`, `||`, `;` and `|` and each
 * segment is tested with the original rule. Splitting is a declared heuristic:
 * a `|` inside a quoted message is split too, and a non-git segment can never
 * pass the `git ...` test anyway.
 */
function gitInvocations(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment === "git" || segment.startsWith("git "));
}

function sortedCounts(counts: ReadonlyMap<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of [...counts.keys()].sort()) {
    const value = counts.get(key);
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Computes the deterministic signals of one parsed session.
 *
 * Everything is derived from the normalized model: events, the content table
 * and the parse report. Pairing a call with its result is by `toolCallId`; the
 * format guarantees at most one result per call (S18), and the first one wins
 * if a file ever carries a duplicate.
 */
export function computeSessionSignals(parsed: ParsedSession): SessionSignals {
  const textOf = new Map(parsed.content.map((record) => [record.eventId, record.text]));

  let activeEvents = 0;
  let agentTurns = 0;
  let toolErrors = 0;
  let compactions = 0;
  const humanTexts: string[] = [];
  const toolCounts = new Map<string, number>();
  /** First `tool_result` per `toolCallId`, as its `isError` value. */
  const resultErrorByCallId = new Map<string, boolean>();

  for (const event of parsed.events) {
    if (event.onActiveBranch) {
      activeEvents += 1;
    }
    if (event.role === "human") {
      humanTexts.push(textOf.get(event.id) ?? "");
    }
    if (event.role === "agent" && event.kind === "message") {
      // Part events inherit the message role (T2) but are not turns; counting
      // them inflated the signal (1013 vs 35 on a real session).
      agentTurns += 1;
    }
    if (event.kind === "tool_result") {
      if (event.isError) {
        toolErrors += 1;
      }
      if (event.toolCallId !== null && !resultErrorByCallId.has(event.toolCallId)) {
        resultErrorByCallId.set(event.toolCallId, event.isError);
      }
    }
    if (event.kind === "compaction") {
      compactions += 1;
    }
    if (event.kind === "tool_call" && event.toolName !== null) {
      toolCounts.set(event.toolName, (toolCounts.get(event.toolName) ?? 0) + 1);
    }
  }

  let shellCommands = 0;
  let unusableCommandCalls = 0;
  let unpairedToolCalls = 0;
  let gitTotal = 0;
  const gitBySubcommand = new Map<string, number>();
  const verification = { total: 0, failed: 0, passed: 0, unknown: 0 };

  for (const event of parsed.events) {
    if (event.kind !== "tool_call") {
      continue;
    }
    if (event.toolCallId === null || !resultErrorByCallId.has(event.toolCallId)) {
      unpairedToolCalls += 1;
    }
    if (event.toolName !== "bash") {
      continue;
    }
    const command = commandFromArguments(textOf.get(event.id) ?? "");
    if (command === null) {
      // Missing, non-string or unparseable: the call still counts in
      // `toolCallsByTool`, just not as a shell command.
      unusableCommandCalls += 1;
      continue;
    }
    shellCommands += 1;

    const trimmed = command.trim();
    for (const invocation of gitInvocations(trimmed)) {
      gitTotal += 1;
      const subcommand = gitSubcommand(invocation);
      gitBySubcommand.set(subcommand, (gitBySubcommand.get(subcommand) ?? 0) + 1);
    }

    if (VERIFICATION_REGEXES.some((regex) => regex.test(trimmed))) {
      verification.total += 1;
      const failed = event.toolCallId === null ? undefined : resultErrorByCallId.get(event.toolCallId);
      if (failed === undefined) {
        verification.unknown += 1;
      } else if (failed) {
        verification.failed += 1;
      } else {
        verification.passed += 1;
      }
    }
  }

  const challengeTurns = humanTexts.filter((text) =>
    CHALLENGE_REGEXES.some((regex) => regex.test(text)),
  ).length;

  const notCapturable: NotCapturableEntry[] = [{ signal: "exitCode", reason: EXIT_CODE_REASON }];

  return {
    parsedLines: parsed.report.parsedLines,
    totalEvents: parsed.events.length,
    partEvents: parsed.report.partEvents,
    activeEvents,
    humanTurns: humanTexts.length,
    humanTurnChars: charStats(humanTexts.map((text) => text.length)),
    agentTurns,
    toolCallsByTool: sortedCounts(toolCounts),
    shellCommands,
    unusableCommandCalls,
    gitCommands: { total: gitTotal, bySubcommand: sortedCounts(gitBySubcommand) },
    verificationCommands: { ...verification },
    toolErrors,
    unpairedToolCalls,
    compactions,
    challengeMarkers: { turns: challengeTurns, patterns: CHALLENGE_PATTERNS },
    notCapturable,
  };
}
