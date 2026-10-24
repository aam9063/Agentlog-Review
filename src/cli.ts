#!/usr/bin/env node
import { parseArgs } from "node:util";

import { parsePiSessionFile } from "./adapters/pi/parse.ts";
import {
  CHALLENGE_PATTERNS,
  CHALLENGE_PATTERNS_VERSION,
  computeSessionSignals,
} from "./signals/session.ts";
import type { SessionSignals } from "./signals/types.ts";
import type { ParsedSession } from "./model/types.ts";

const USAGE = `uso: evaluador parse <sesion.jsonl> [--json] [--strict]
uso: evaluador signals <sesion.jsonl> [--json] [--strict]

  --json    imprime el informe completo como JSON
  --strict  sale con 3 si hay deriva, lineas malformadas o tipos sin contrato

codigos de salida: 0 exito, 1 uso incorrecto, 2 archivo ilegible, 3 fallo estricto`;

function summarize(parsed: ParsedSession): string {
  const { session, report } = parsed;
  const version = session.formatVersion === null ? "sin version" : `v${String(session.formatVersion)}`;
  const lines = [
    `sesion: ${session.id} (${session.agent} formato ${version})`,
    `directorio: ${session.cwd ?? "<sin cwd>"}`,
    `eventos: ${String(parsed.events.length)} (${String(report.partEvents)} partes) | rama activa: ${String(report.activeBranchLength)}`,
    `modelos: ${session.models.length === 0 ? "<ninguno>" : session.models.join(", ")}`,
    `deriva: ${String(report.drift.length)} | tipos sin contrato: ${String(report.unverifiedTypes.length)} | padres sin resolver: ${String(report.parentFindings.length)}`,
    `lineas: ${String(report.totalLines)} = ${String(report.parsedLines)} parseadas + ${String(report.rawOnly)} solo-raw + ${String(report.malformed)} malformadas + ${String(report.blankLines)} vacias`,
  ];
  return lines.join("\n");
}

function strictFailures(parsed: ParsedSession): string[] {
  const { report } = parsed;
  const failures: string[] = [];
  if (report.malformed > 0) {
    failures.push(`${String(report.malformed)} linea(s) malformada(s)`);
  }
  if (report.drift.length > 0) {
    failures.push(`${String(report.drift.length)} hallazgo(s) de deriva`);
  }
  if (report.unverifiedTypes.length > 0) {
    failures.push(`tipos sin contrato: ${report.unverifiedTypes.join(", ")}`);
  }
  return failures;
}

/** One countable fact per line, ASCII labels only, in the `parse` summary style. */
function summarizeSignals(signals: SessionSignals): string {
  const tools = Object.entries(signals.toolCallsByTool)
    .map(([name, count]) => `${name}=${String(count)}`)
    .join(", ");
  const gitSubcommands = Object.entries(signals.gitCommands.bySubcommand)
    .map(([subcommand, count]) => `${subcommand}=${String(count)}`)
    .join(", ");
  const { verificationCommands: verification } = signals;
  const lines = [
    `lineas: ${String(signals.parsedLines)} | eventos: ${String(signals.totalEvents)} (${String(signals.partEvents)} partes) | rama activa: ${String(signals.activeEvents)}`,
    `turnos humanos: ${String(signals.humanTurns)} (media ${String(signals.humanTurnChars.mean)}, mediana ${String(signals.humanTurnChars.median)}, mas largo ${String(signals.humanTurnChars.longest)})`,
    `turnos agente: ${String(signals.agentTurns)}`,
    `herramientas: ${tools === "" ? "<ninguna>" : tools}`,
    `comandos shell: ${String(signals.shellCommands)} (sin comando util: ${String(signals.unusableCommandCalls)})`,
    `git: ${String(signals.gitCommands.total)}${gitSubcommands === "" ? "" : ` (${gitSubcommands})`}`,
    `verificacion: ${String(verification.total)} (pasan ${String(verification.passed)}, fallan ${String(verification.failed)}, sin resultado ${String(verification.unknown)})`,
    `errores de herramienta: ${String(signals.toolErrors)}`,
    `llamadas sin resultado: ${String(signals.unpairedToolCalls)}`,
    `compactaciones: ${String(signals.compactions)}`,
    `marcas de cuestionamiento: ${String(signals.challengeMarkers.turns)} (patrones v${String(CHALLENGE_PATTERNS_VERSION)}: ${String(CHALLENGE_PATTERNS.length)})`,
  ];
  for (const entry of signals.notCapturable) {
    lines.push(`no capturable: ${entry.signal}`);
  }
  return lines.join("\n");
}

async function main(argv: readonly string[]): Promise<number> {
  let parsedArgs;
  try {
    parsedArgs = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        strict: { type: "boolean", default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "argumentos invalidos"}\n\n${USAGE}\n`);
    return 1;
  }

  const { values, positionals } = parsedArgs;
  const [command, target] = positionals;
  if ((command !== "parse" && command !== "signals") || target === undefined) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }

  let parsed: ParsedSession;
  try {
    parsed = await parsePiSessionFile(target);
  } catch (error) {
    process.stderr.write(`no se pudo leer ${target}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (command === "signals") {
    const signals = computeSessionSignals(parsed);
    if (values.json) {
      const payload = { session: parsed.session, report: parsed.report, signals };
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stdout.write(`${summarizeSignals(signals)}\n`);
    }

    // --strict mirrors `parse` on the two conditions the signals layer can
    // inherit from the parse report; unverified types stay parse-specific.
    if (values.strict) {
      const failures: string[] = [];
      if (parsed.report.malformed > 0) {
        failures.push(`${String(parsed.report.malformed)} linea(s) malformada(s)`);
      }
      if (parsed.report.drift.length > 0) {
        failures.push(`${String(parsed.report.drift.length)} hallazgo(s) de deriva`);
      }
      if (failures.length > 0) {
        for (const failure of failures) {
          process.stderr.write(`estricto: ${failure}\n`);
        }
        return 3;
      }
    }
    return 0;
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify({ session: parsed.session, report: parsed.report }, null, 2)}\n`);
  } else {
    process.stdout.write(`${summarize(parsed)}\n`);
  }

  if (values.strict) {
    const failures = strictFailures(parsed);
    if (failures.length > 0) {
      for (const failure of failures) {
        process.stderr.write(`estricto: ${failure}\n`);
      }
      return 3;
    }
  }

  return 0;
}

process.exitCode = await main(process.argv.slice(2));
