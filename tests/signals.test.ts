import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parsePiSessionText } from "../src/adapters/pi/parse.ts";
import {
  CHALLENGE_PATTERNS,
  CHALLENGE_PATTERNS_VERSION,
  computeSessionSignals,
  VERIFICATION_PATTERNS,
} from "../src/signals/session.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/pi/${name}`, import.meta.url)), "utf8");
}

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/pi/${name}`, import.meta.url));
}

function signalsOf(name: string) {
  return computeSessionSignals(parsePiSessionText(fixture(name)));
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: readonly string[]): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("S16 forma de las senales", () => {
  it("expone exactamente las claves del contrato y ninguna mas", () => {
    const signals = signalsOf("signals.jsonl");

    expect(Object.keys(signals).sort()).toEqual(
      [
        "activeEvents",
        "agentTurns",
        "challengeMarkers",
        "compactions",
        "gitCommands",
        "humanTurnChars",
        "humanTurns",
        "notCapturable",
        "parsedLines",
        "partEvents",
        "shellCommands",
        "toolCallsByTool",
        "toolErrors",
        "totalEvents",
        "unpairedToolCalls",
        "unusableCommandCalls",
        "verificationCommands",
      ].sort(),
    );
  });

  it("cuenta lineas parseadas, eventos, partes y rama activa del fichero", () => {
    const signals = signalsOf("signals.jsonl");

    // A mano: 12 entradas, 7 eventos de parte (3 en a1, 2 en a2, 2 en a3),
    // 19 eventos en total. La hoja mas reciente es r_r1, asi que la rama activa
    // cubre m1, u1, u2, a1, r_n1, a2, r_b1, a3, r_r1 (9) mas sus 7 partes.
    expect(signals.parsedLines).toBe(12);
    expect(signals.totalEvents).toBe(19);
    expect(signals.partEvents).toBe(7);
    expect(signals.activeEvents).toBe(16);
  });

  it("cuenta turnos humanos con su longitud media, mediana y maxima", () => {
    const signals = signalsOf("signals.jsonl");

    // A mano: "hola" (4) y "¿seguro que eso funciona?" (25 caracteres).
    expect(signals.humanTurns).toBe(2);
    expect(signals.humanTurnChars).toEqual({ mean: 14.5, median: 14.5, longest: 25 });
  });

  it("cuenta solo los mensajes agente, no los eventos de parte", () => {
    const signals = signalsOf("signals.jsonl");

    // A mano: a1, a2, a3. Las 7 partes heredan el rol agent (T2) pero no son
    // turnos; el recuento por roles del fichero da 10 y queda excluido.
    expect(signals.agentTurns).toBe(3);
  });

  it("excluye las partes del recuento de turnos en el fixture parts", () => {
    const parsed = parsePiSessionText(fixture("parts.jsonl"));
    const signals = computeSessionSignals(parsed);
    const agentRoleEvents = parsed.events.filter((event) => event.role === "agent").length;

    // a1 mas sus 3 partes (reasoning, tool_call, attachment) llevan rol agent.
    expect(agentRoleEvents).toBe(4);
    expect(signals.agentTurns).toBe(1);
    expect(signals.agentTurns).toBeLessThan(agentRoleEvents);
  });
});

describe("S16 herramientas y comandos", () => {
  it("cuenta llamadas por herramienta ordenadas por clave ascendente", () => {
    const signals = signalsOf("signals.jsonl");

    // A mano: 5 llamadas bash (git status, npm test, npm run build, {} sin
    // comando, pnpm lint) y 1 read.
    expect(signals.toolCallsByTool).toEqual({ bash: 5, read: 1 });
    expect(Object.keys(signals.toolCallsByTool)).toEqual(["bash", "read"]);
  });

  it("cuenta comandos de shell usables y separa las llamadas sin comando", () => {
    const signals = signalsOf("signals.jsonl");

    // A mano: 4 comandos usables; la llamada bash con arguments {} no parsea a
    // ningun .command string, cuenta en bash pero no aqui, y suma 1 a
    // unusableCommandCalls. La llamada read no es bash y no entra en la cuenta.
    expect(signals.shellCommands).toBe(4);
    expect(signals.unusableCommandCalls).toBe(1);
  });

  it("clasifica los comandos de git por subcomando", () => {
    const signals = signalsOf("signals.jsonl");

    expect(signals.gitCommands).toEqual({ total: 1, bySubcommand: { status: 1 } });
  });

  it("detecta invocaciones de git dentro de comandos compuestos", () => {
    const text = [
      '{"type":"session","version":3,"id":"s-comp","timestamp":"2026-03-04T09:00:00.000Z"}',
      '{"type":"message","id":"a1","timestamp":"2026-03-04T09:00:01.000Z","message":{"role":"assistant","content":[' +
        '{"type":"toolCall","toolName":"bash","toolCallId":"c1","arguments":{"command":"cd /x && git status --short | head -5"}},' +
        '{"type":"toolCall","toolName":"bash","toolCallId":"c2","arguments":{"command":"git add . && git commit -m \'mensaje\'"}},' +
        '{"type":"toolCall","toolName":"bash","toolCallId":"c3","arguments":{"command":"cd /x; git log --oneline"}},' +
        '{"type":"toolCall","toolName":"bash","toolCallId":"c4","arguments":{"command":"echo hola"}}' +
        "]}}",
      "",
    ].join("\n");
    const signals = computeSessionSignals(parsePiSessionText(text));

    // A mano: status, add, commit y log dentro de compuestos; echo hola no es
    // git. Sin este caso, una sesion real que solo usa "cd X && git ..."
    // contaba 0 comandos de git.
    expect(signals.shellCommands).toBe(4);
    expect(signals.gitCommands.total).toBe(4);
    expect(signals.gitCommands.bySubcommand).toEqual({ add: 1, commit: 1, log: 1, status: 1 });
  });

  it("salta el valor de las banderas globales de git al elegir el subcomando", () => {
    const text = [
      '{"type":"session","version":3,"id":"s-git","timestamp":"2026-03-02T09:00:00.000Z"}',
      '{"type":"message","id":"a1","timestamp":"2026-03-02T09:00:01.000Z","message":{"role":"assistant","content":[' +
        '{"type":"toolCall","toolName":"bash","toolCallId":"c1","arguments":{"command":"git -C /x status"}},' +
        '{"type":"toolCall","toolName":"bash","toolCallId":"c2","arguments":{"command":"git"}},' +
        '{"type":"toolCall","toolName":"bash","toolCallId":"c3","arguments":{"command":"git status --porcelain"}},' +
        '{"type":"toolCall","toolName":"bash","toolCallId":"c4","arguments":{"command":"git -c x=y log"}}' +
        "]}}",
      "",
    ].join("\n");
    const signals = computeSessionSignals(parsePiSessionText(text));

    // A mano: "git" sin argumentos da "<none>"; "git -C /x status" y
    // "git status --porcelain" dan status; "git -c x=y log" salta la bandera y
    // su valor y da log.
    expect(signals.gitCommands.total).toBe(4);
    expect(signals.gitCommands.bySubcommand).toEqual({ "<none>": 1, log: 1, status: 2 });
    expect(signals.shellCommands).toBe(4);
    expect(signals.verificationCommands.total).toBe(0);
    expect(signals.unpairedToolCalls).toBe(4);
  });
});

describe("S16/S18 verificacion y emparejamiento", () => {
  it("clasifica cada comando de verificacion con el isError de su resultado", () => {
    const signals = signalsOf("signals.jsonl");

    // A mano: npm test falla (isError true), pnpm lint pasa (isError false),
    // npm run build no tiene resultado. git status no es verificacion.
    expect(signals.verificationCommands).toEqual({ total: 3, failed: 1, passed: 1, unknown: 1 });
  });

  it("declara la lista de patrones de verificacion versionada", () => {
    const signals = signalsOf("signals.jsonl");

    expect(VERIFICATION_PATTERNS.length).toBeGreaterThan(0);
    // Cubre las cuatro familias del contrato: test, build, lint, typecheck.
    expect(VERIFICATION_PATTERNS.some((source) => source.includes("test"))).toBe(true);
    expect(VERIFICATION_PATTERNS.some((source) => source.includes("build"))).toBe(true);
    expect(VERIFICATION_PATTERNS.some((source) => source.includes("lint"))).toBe(true);
    expect(VERIFICATION_PATTERNS.some((source) => source.includes("typecheck") || source.includes("tsc"))).toBe(true);
    expect(signals.verificationCommands.total).toBe(3);
  });

  it("cuenta errores de herramienta, llamadas sin resultado y compactaciones", () => {
    const signals = signalsOf("signals.jsonl");

    // A mano: solo r_n1 lleva isError true; call_u1 (npm run build) no tiene
    // tool_result; no hay entradas compaction en el fichero.
    expect(signals.toolErrors).toBe(1);
    expect(signals.unpairedToolCalls).toBe(1);
    expect(signals.compactions).toBe(0);
  });
});

describe("S19 marcas de cuestionamiento", () => {
  it("cuenta los turnos humanos que tocan un patron y reporta la lista", () => {
    const signals = signalsOf("signals.jsonl");

    // A mano: solo u2 ("¿seguro que eso funciona?") toca un patron.
    expect(signals.challengeMarkers.turns).toBe(1);
    expect(signals.challengeMarkers.patterns).toEqual(CHALLENGE_PATTERNS);
  });

  it("incluye patrones en espanol y en ingles para no castigar el idioma", () => {
    expect(CHALLENGE_PATTERNS.some((source) => source.includes("seguro"))).toBe(true);
    expect(CHALLENGE_PATTERNS.some((source) => source.includes("are you sure"))).toBe(true);
  });

  it("cuenta un turno humano con signo de interrogacion", () => {
    const text = [
      '{"type":"session","version":3,"id":"s-q","timestamp":"2026-03-03T09:00:00.000Z"}',
      '{"type":"message","id":"u1","timestamp":"2026-03-03T09:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"¿esto funciona?"}]}}',
      "",
    ].join("\n");

    expect(computeSessionSignals(parsePiSessionText(text)).challengeMarkers.turns).toBe(1);
  });

  it("no cuenta un imperativo plano sin ninguna marca", () => {
    const text = [
      '{"type":"session","version":3,"id":"s-n","timestamp":"2026-03-03T09:00:00.000Z"}',
      '{"type":"message","id":"u1","timestamp":"2026-03-03T09:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"crea el README del proyecto"}]}}',
      "",
    ].join("\n");

    expect(computeSessionSignals(parsePiSessionText(text)).challengeMarkers.turns).toBe(0);
  });

  it("expone la lista versionada v2 junto al resultado", () => {
    const signals = signalsOf("signals.jsonl");

    expect(CHALLENGE_PATTERNS_VERSION).toBe(2);
    expect(signals.challengeMarkers.patterns).toEqual(CHALLENGE_PATTERNS);
  });
});

describe("S17 no capturable", () => {
  it("declara exitCode como senal no capturable por su motivo", () => {
    const signals = signalsOf("signals.jsonl");

    expect(signals.notCapturable).toHaveLength(1);
    expect(signals.notCapturable[0]?.signal).toBe("exitCode");
    expect(signals.notCapturable[0]?.reason).toContain("isError");
    expect(signals.notCapturable[0]?.reason).toContain("codigo de salida");
  });
});

describe("CLI signals", () => {
  it("imprime un hecho por linea con etiquetas ASCII estables y sale con 0", () => {
    const result = run(["signals", fixturePath("signals.jsonl")]);
    const expected = [
      "lineas: 12 | eventos: 19 (7 partes) | rama activa: 16",
      "turnos humanos: 2 (media 14.5, mediana 14.5, mas largo 25)",
      "turnos agente: 3",
      "herramientas: bash=5, read=1",
      "comandos shell: 4 (sin comando util: 1)",
      "git: 1 (status=1)",
      "verificacion: 3 (pasan 1, fallan 1, sin resultado 1)",
      "errores de herramienta: 1",
      "llamadas sin resultado: 1",
      "compactaciones: 0",
      `marcas de cuestionamiento: 1 (patrones v${String(CHALLENGE_PATTERNS_VERSION)}: ${String(CHALLENGE_PATTERNS.length)})`,
      "no capturable: exitCode",
      "",
    ].join("\n");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(expected);
    expect(result.stdout).toMatch(/^[\u0020-\u007E\n]*$/);
  });

  it("emite sesion, informe y senales como JSON con --json", () => {
    const result = run(["signals", fixturePath("signals.jsonl"), "--json"]);
    const payload = JSON.parse(result.stdout) as {
      session: { id: string };
      report: { parsedLines: number };
      signals: {
        shellCommands: number;
        unusableCommandCalls: number;
        verificationCommands: { total: number; failed: number; passed: number; unknown: number };
        notCapturable: { signal: string; reason: string }[];
      };
    };

    expect(result.status).toBe(0);
    expect(payload.session.id).toBe("test-session-signals");
    expect(payload.report.parsedLines).toBe(12);
    expect(payload.signals.shellCommands).toBe(4);
    expect(payload.signals.unusableCommandCalls).toBe(1);
    expect(payload.signals.verificationCommands).toEqual({ total: 3, failed: 1, passed: 1, unknown: 1 });
    expect(payload.signals.notCapturable).toHaveLength(1);
    expect(payload.signals.notCapturable[0]?.signal).toBe("exitCode");
    expect(payload.signals.notCapturable[0]?.reason).toContain("isError");
  });

  it("sale con 3 cuando --strict encuentra lineas malformadas o deriva", () => {
    const result = run(["signals", fixturePath("drift.jsonl"), "--strict"]);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("estricto: 1 linea(s) malformada(s)");
    expect(result.stderr).toContain("estricto: 2 hallazgo(s) de deriva");
  });

  it("sale con 0 con la misma entrada si no se pide --strict", () => {
    const result = run(["signals", fixturePath("drift.jsonl")]);

    expect(result.status).toBe(0);
  });

  it("sale con 0 en estricto cuando el fichero esta limpio", () => {
    const result = run(["signals", fixturePath("signals.jsonl"), "--strict"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("sale con 2 cuando el archivo no se puede leer", () => {
    const result = run(["signals", fixturePath("no-existe.jsonl")]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no se pudo leer");
  });

  it("sale con 1 y muestra el uso cuando faltan argumentos", () => {
    const result = run(["signals"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("uso: evaluador signals");
  });
});
