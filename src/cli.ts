#!/usr/bin/env node
import { parseArgs } from "node:util";

import { parsePiSessionFile } from "./adapters/pi/parse.ts";
import type { ParsedSession } from "./model/types.ts";

const USAGE = `uso: evaluador parse <sesion.jsonl> [--json] [--strict]

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
  if (command !== "parse" || target === undefined) {
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
