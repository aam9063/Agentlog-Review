import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/pi/${name}`, import.meta.url));
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

describe("CLI parse", () => {
  it("resume una sesion valida y sale con 0", () => {
    const result = run(["parse", fixture("minimal.jsonl")]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("sesion: test-session-01 (pi formato v3)");
    expect(result.stdout).toContain("eventos: 12 | rama activa: 11");
    expect(result.stdout).toContain("lineas: 12 = 12 parseadas + 0 solo-raw + 0 malformadas + 1 vacias");
  });

  it("emite el informe como JSON con --json", () => {
    const result = run(["parse", fixture("minimal.jsonl"), "--json"]);
    const payload = JSON.parse(result.stdout) as {
      session: { id: string };
      report: { totalLines: number; activeBranchLength: number };
    };

    expect(result.status).toBe(0);
    expect(payload.session.id).toBe("test-session-01");
    expect(payload.report.totalLines).toBe(12);
    expect(payload.report.activeBranchLength).toBe(11);
  });

  it("sale con 3 y explica el motivo cuando --strict encuentra deriva", () => {
    const result = run(["parse", fixture("drift.jsonl"), "--strict"]);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("estricto: 2 hallazgo(s) de deriva");
    expect(result.stderr).toContain("estricto: tipos sin contrato: hologram");
  });

  it("sale con 0 con la misma entrada si no se pide --strict", () => {
    const result = run(["parse", fixture("drift.jsonl")]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("deriva: 2");
  });

  it("sale con 2 cuando el archivo no se puede leer", () => {
    const result = run(["parse", fixture("no-existe.jsonl")]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no se pudo leer");
  });

  it("sale con 1 y muestra el uso cuando faltan argumentos", () => {
    const result = run(["parse"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("uso: evaluador parse");
  });
});
