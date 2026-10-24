import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parsePiSessionText } from "../src/adapters/pi/parse.ts";
import type { ParsedSession } from "../src/model/types.ts";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/pi/${name}`, import.meta.url)), "utf8");
}

function minimal(): ParsedSession {
  return parsePiSessionText(fixture("minimal.jsonl"));
}

function activeIds(parsed: ParsedSession): string[] {
  return parsed.events
    .filter((event) => event.onActiveBranch)
    .map((event) => event.id)
    .sort();
}

describe("S4 rama activa", () => {
  it("recorre la cadena completa cuando no hay ramificacion", () => {
    const parsed = minimal();

    expect(parsed.report.activeBranchLength).toBe(11);
    expect(parsed.events).toHaveLength(12);
  });

  it("deja la cabecera fuera del arbol", () => {
    const parsed = minimal();
    const header = parsed.events.find((event) => event.kind === "session_header");

    expect(header?.onActiveBranch).toBe(false);
    expect(header?.parentId).toBeNull();
    expect(parsed.report.parentFindings).toHaveLength(0);
  });

  it("incluye la raiz y la ultima hoja en la rama", () => {
    const parsed = minimal();
    const root = parsed.events.find((event) => event.id.endsWith(":m1"));
    const last = parsed.events.find((event) => event.id.endsWith(":a2"));

    expect(root?.onActiveBranch).toBe(true);
    expect(last?.onActiveBranch).toBe(true);
  });

  it("ignora la rama abandonada y elige la hoja mas reciente", () => {
    const parsed = parsePiSessionText(fixture("branching.jsonl"));
    const abandoned = parsed.events.find((event) => event.id.endsWith(":a1"));
    const active = parsed.events.find((event) => event.id.endsWith(":a2"));

    expect(parsed.report.activeBranchLength).toBe(4);
    expect(abandoned?.onActiveBranch).toBe(false);
    expect(active?.onActiveBranch).toBe(true);
  });

  it("reporta un parentId que no resuelve y lo saca de la rama", () => {
    const parsed = parsePiSessionText(fixture("branching.jsonl"));

    expect(parsed.report.parentFindings).toEqual([
      { lineNumber: 7, id: "ev:pi:test-session-branch:x1", parentId: "ghost", reason: "unresolved" },
    ]);
    expect(parsed.events.find((event) => event.id.endsWith(":x1"))?.onActiveBranch).toBe(false);
  });
});

describe("S4 estabilidad ante el orden del archivo", () => {
  it("da el mismo conjunto de eventos y de rama con las lineas invertidas", () => {
    const original = fixture("branching.jsonl");
    const reversed = original.split("\n").reverse().join("\n");

    const forward = parsePiSessionText(original);
    const backward = parsePiSessionText(reversed);

    expect(activeIds(backward)).toEqual(activeIds(forward));
    expect(backward.report.activeBranchLength).toBe(forward.report.activeBranchLength);
    expect(backward.events.map((event) => event.id).sort()).toEqual(
      forward.events.map((event) => event.id).sort(),
    );
  });

  it("elige la misma hoja aunque la ultima linea del archivo no sea la mas reciente", () => {
    const lines = fixture("branching.jsonl").split("\n").filter((line) => line.trim() !== "");
    const reordered = [...lines.slice(0, -1), lines[0] as string, lines[lines.length - 1] as string].join("\n");

    const parsed = parsePiSessionText(reordered);

    expect(parsed.events.find((event) => event.id.endsWith(":a2"))?.onActiveBranch).toBe(true);
    expect(parsed.report.activeBranchLength).toBe(4);
  });
});

describe("S3 arbol integro", () => {
  it("no repite ids dentro de una sesion", () => {
    const parsed = parsePiSessionText(fixture("branching.jsonl"));
    const ids = parsed.events.map((event) => event.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("no reporta padres sin resolver cuando el arbol esta completo", () => {
    const parsed = minimal();

    expect(parsed.report.parentFindings).toHaveLength(0);
  });
});
