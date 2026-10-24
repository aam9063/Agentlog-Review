import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parsePiSessionText } from "../src/adapters/pi/parse.ts";
import type { ParsedSession } from "../src/model/types.ts";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/pi/${name}`, import.meta.url)), "utf8");
}

function drift(): ParsedSession {
  return parsePiSessionText(fixture("drift.jsonl"));
}

describe("S7 deriva ruidosa", () => {
  it("reporta una clave desconocida en la entrada", () => {
    const parsed = drift();
    const finding = parsed.report.drift.find((item) => item.scope === "entry");

    expect(finding).toEqual({
      lineNumber: 2,
      scope: "entry",
      type: "model_change",
      unknownKeys: ["futureField"],
      missingKeys: [],
    });
  });

  it("reporta una clave desconocida dentro del mensaje", () => {
    const parsed = drift();
    const finding = parsed.report.drift.find((item) => item.scope === "message");

    expect(finding).toEqual({
      lineNumber: 3,
      scope: "message",
      type: "message",
      unknownKeys: ["brandNewField"],
      missingKeys: [],
    });
  });

  it("no descarta la entrada con deriva: queda como evento", () => {
    const parsed = drift();

    expect(parsed.report.parsed).toBe(4);
    expect(parsed.events.find((event) => event.id.endsWith(":m1"))).toBeDefined();
    expect(parsed.events.find((event) => event.id.endsWith(":u1"))).toBeDefined();
  });

  it("reporta un tipo de entrada sin contrato verificado sin inventarle forma", () => {
    const parsed = drift();

    expect(parsed.report.unverifiedTypes).toEqual(["hologram"]);
    expect(parsed.events.find((event) => event.id.endsWith(":h1"))?.kind).toBe("unknown");
  });

  it("conserva en raw la linea que no declara type", () => {
    const parsed = drift();
    const rawOnly = parsed.report.rawOnly;

    expect(rawOnly).toBe(1);
    expect(parsed.raw.map((line) => line.text)).toContain('{"hello":"world"}');
  });

  it("cuenta la linea malformada y la conserva en raw", () => {
    const parsed = drift();

    expect(parsed.report.malformed).toBe(1);
    expect(
      parsed.raw.some((line) => {
        try {
          JSON.parse(line.text);
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
  });

  it("cierra la identidad de conteo con deriva, solo-raw y malformadas", () => {
    const parsed = drift();
    const { report } = parsed;

    expect(report.totalLines).toBe(6);
    expect(report.parsed).toBe(4);
    expect(report.rawOnly).toBe(1);
    expect(report.malformed).toBe(1);
    expect(report.parsed + report.rawOnly + report.malformed).toBe(report.totalLines);
  });

  it("no inventa deriva cuando el formato coincide con el contrato", () => {
    const parsed = parsePiSessionText(fixture("minimal.jsonl"));

    expect(parsed.report.drift).toHaveLength(0);
    expect(parsed.report.unverifiedTypes).toHaveLength(0);
  });
});
