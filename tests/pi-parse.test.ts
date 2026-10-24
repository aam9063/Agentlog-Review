import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalJson, parsePiSessionText, sha256 } from "../src/adapters/pi/parse.ts";
import { computeSessionSignals } from "../src/signals/session.ts";
import type { ParsedSession } from "../src/model/types.ts";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/pi/${name}`, import.meta.url)), "utf8");
}

function minimal(): ParsedSession {
  return parsePiSessionText(fixture("minimal.jsonl"));
}

function nonBlankLineCount(text: string): number {
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

describe("S2 identidad de conteo", () => {
  it("reparte cada linea no vacia en exactamente un cubo", () => {
    const text = fixture("minimal.jsonl");
    const { report } = parsePiSessionText(text);

    expect(report.parsedLines).toBe(12);
    expect(report.partEvents).toBe(2);
    expect(report.rawOnly).toBe(0);
    expect(report.malformed).toBe(0);
    expect(report.totalLines).toBe(nonBlankLineCount(text));
    expect(report.parsedLines + report.rawOnly + report.malformed).toBe(report.totalLines);
  });

  it("cuenta lineas vacias aparte y no las trata como datos", () => {
    const { report } = minimal();

    expect(report.blankLines).toBe(1);
    expect(report.totalLines + report.blankLines).toBe(13);
  });
});

describe("S8 modelo de sesion", () => {
  it("lee la cabecera declarada por el archivo", () => {
    const { session } = minimal();

    expect(session.id).toBe("test-session-01");
    expect(session.agent).toBe("pi");
    expect(session.formatVersion).toBe(3);
    expect(session.cwd).toBe("C:\\demo");
    expect(session.startedAt).toBe("2026-01-01T10:00:00.000Z");
  });

  it("toma el fin de sesion del ultimo timestamp, no de la ultima linea", () => {
    const { session } = minimal();

    expect(session.endedAt).toBe("2026-01-01T10:00:30.000Z");
  });

  it("lista los modelos usados sin repetir", () => {
    const { session } = minimal();

    expect(session.models).toEqual(["glm5.3-flash"]);
  });
});

describe("S6 raw recuperable", () => {
  it("registra el hash de cada linea no vacia", () => {
    const text = fixture("minimal.jsonl");
    const { raw } = parsePiSessionText(text);

    expect(raw).toHaveLength(nonBlankLineCount(text));
    for (const line of raw) {
      expect(line.sha256).toBe(sha256(line.text));
    }
  });

  it("apunta cada evento a su linea original por numero y hash", () => {
    const { events, raw } = minimal();
    const byLine = new Map(raw.map((line) => [line.lineNumber, line]));

    for (const event of events) {
      const line = byLine.get(event.raw.lineNumber);
      expect(line).toBeDefined();
      expect(line?.sha256).toBe(event.raw.sha256);
    }
  });

  it("emite un registro de contenido por evento, aunque el texto sea vacio", () => {
    const { events, content } = minimal();

    expect(content).toHaveLength(events.length);
    const eventIds = new Set(events.map((event) => event.id));
    for (const record of content) {
      expect(eventIds.has(record.eventId)).toBe(true);
    }
  });
});

describe("S8 extraccion de texto", () => {
  it("extrae el texto del turno humano", () => {
    const { content } = minimal();
    const texts = content.map((record) => record.text);

    expect(texts).toContain("crea el README del proyecto");
  });

  it("extrae el texto del resultado de herramienta", () => {
    const { content } = minimal();

    expect(content.map((record) => record.text)).toContain("Wrote README.md");
  });

  it("no puntua el razonamiento: un turno con solo thinking y toolCall deja texto vacio", () => {
    const { events, content } = minimal();
    const assistant = events.find((event) => event.id.endsWith(":a1"));

    expect(assistant).toBeDefined();
    const record = content.find((item) => item.eventId === assistant?.id);
    expect(record?.text).toBe("");
  });

  it("conserva el contenido de las entradas custom como JSON canonico", () => {
    const { events, content } = minimal();
    const change = events.find((event) => event.customType === "gentle-pi.session-change/v1");
    const record = content.find((item) => item.eventId === change?.id);

    expect(record).toBeDefined();
    expect(record?.text).toContain('"path":"README.md"');
    expect(record?.text).toContain('"kind":"text"');
  });
});

describe("S8 roles y tipos de evento", () => {
  it("mapea el rol de cada mensaje", () => {
    const { events } = minimal();
    const roleOf = (suffix: string): string | undefined =>
      events.find((event) => event.id.endsWith(`:${suffix}`))?.role;

    expect(roleOf("u1")).toBe("system");
    expect(roleOf("u2")).toBe("human");
    expect(roleOf("a1")).toBe("agent");
    expect(roleOf("r1")).toBe("tool");
  });

  it("marca la cabecera como tipo de evento propia y no como mensaje", () => {
    const { events } = minimal();
    const header = events.find((event) => event.id.endsWith(":test-session-01"));

    expect(header?.kind).toBe("session_header");
  });

  it("no marca error en un resultado exitoso", () => {
    const { events } = minimal();

    expect(events.every((event) => !event.isError)).toBe(true);
  });

  it("lee el nombre de herramienta del resultado y del toolCall", () => {
    const { events } = minimal();
    const toolResult = events.find((event) => event.id.endsWith(":r1"));
    const assistant = events.find((event) => event.id.endsWith(":a1"));

    expect(toolResult?.toolName).toBe("write");
    expect(assistant?.toolName).toBe("write");
  });
});

describe("S9 entradas custom de gentle-pi", () => {
  it("modela los tres customType verificados", () => {
    const { events } = minimal();
    const customTypes = events
      .map((event) => event.customType)
      .filter((value): value is string => value !== null);

    expect(customTypes).toContain("gentle-pi.session-worktree/v1");
    expect(customTypes).toContain("gentle-pi.session-change/v1");
    expect(customTypes).toContain("gentle-pi.review-reminder-receipt/v1");
  });

  it("distingue custom de custom_message", () => {
    const { events } = minimal();
    const kinds = events.map((event) => event.kind);

    expect(kinds).toContain("custom");
    expect(kinds).toContain("custom_message");
  });
});

describe("S12 identidad de herramienta en partes toolCall", () => {
  it("copia toolName y toolCallId de la parte toolCall al evento hijo", () => {
    const parsed = parsePiSessionText(fixture("parts.jsonl"));
    const call = parsed.events.find((event) => event.id === "ev:pi:test-session-parts:a1#p2");

    expect(call?.kind).toBe("tool_call");
    expect(call?.toolName).toBe("read");
    expect(call?.toolCallId).toBe("call_9");
  });

  it("copia la identidad de la llamada derivada del a1 de minimal", () => {
    const parsed = parsePiSessionText(fixture("minimal.jsonl"));
    const call = parsed.events.find((event) => event.id === "ev:pi:test-session-01:a1#p1");

    expect(call?.kind).toBe("tool_call");
    expect(call?.toolName).toBe("write");
    expect(call?.toolCallId).toBe("call_1");
  });

  it("lee el nombre y el id que pi v3 real escribe en la parte (name/id)", () => {
    // Forma observada en una sesion real de 1.073 lineas: la parte lleva
    // "name" e "id", no "toolName"/"toolCallId". Sin esta lectura, las 374
    // llamadas de esa sesion perdian nombre e id y todo quedaba sin emparejar.
    const text = [
      '{"type":"session","version":3,"id":"s-real","timestamp":"2026-09-28T15:00:00.000Z"}',
      '{"type":"message","id":"a1","parentId":null,"timestamp":"2026-09-28T15:00:01.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_real_1","name":"bash","arguments":{"command":"git status"}}],"stopReason":"toolUse"}}',
      '{"type":"message","id":"r1","parentId":"a1","timestamp":"2026-09-28T15:00:02.000Z","message":{"role":"toolResult","toolCallId":"call_real_1","toolName":"bash","content":[{"type":"text","text":"ok"}],"isError":false}}',
      "",
    ].join("\n");
    const parsed = parsePiSessionText(text);
    const call = parsed.events.find((event) => event.kind === "tool_call");

    expect(call?.toolName).toBe("bash");
    expect(call?.toolCallId).toBe("call_real_1");
    const signals = computeSessionSignals(parsed);
    expect(signals.toolCallsByTool).toEqual({ bash: 1 });
    expect(signals.unpairedToolCalls).toBe(0);
  });
});

describe("S5 determinismo", () => {
  it("produce los mismos ids en dos corridas", () => {
    const first = minimal().events.map((event) => event.id);
    const second = minimal().events.map((event) => event.id);

    expect(first).toEqual(second);
  });

  it("deriva el id del id de origen, no del numero de linea", () => {
    const { events } = minimal();
    const bySource = events.find((event) => event.id.endsWith(":u2"));

    expect(bySource?.id).toBe("ev:pi:test-session-01:u2");
  });

  it("usa un hash canonico cuando la entrada no trae id", () => {
    const line = '{"type":"label","label":"hito"}';
    const parsed = parsePiSessionText(line);

    expect(parsed.events[0]?.id).toBe(`ev:pi:unknown-${sha256(line).slice(0, 16)}:h${sha256(line).slice(0, 16)}`);
  });

  it("canoniza las claves para que el orden no cambie el hash", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("deriva el id de las partes del id del mensaje mas el indice de la parte", () => {
    const first = parsePiSessionText(fixture("parts.jsonl")).events.map((event) => event.id);
    const second = parsePiSessionText(fixture("parts.jsonl")).events.map((event) => event.id);

    expect(first).toEqual(second);
    expect(first.filter((id) => id.includes("#p"))).toEqual([
      "ev:pi:test-session-parts:a1#p0",
      "ev:pi:test-session-parts:a1#p2",
      "ev:pi:test-session-parts:a1#p3",
      "ev:pi:test-session-parts:r1#p1",
    ]);
  });
});

describe("S12/S13/S15 partes de mensaje", () => {
  function parts(): ParsedSession {
    return parsePiSessionText(fixture("parts.jsonl"));
  }

  it("S12: emite el evento del mensaje solo con el texto de las partes text", () => {
    const parsed = parts();
    const message = parsed.events.find((event) => event.id.endsWith(":a1"));

    expect(message?.kind).toBe("message");
    expect(parsed.content.find((item) => item.eventId === message?.id)?.text).toBe("Aqui esta la lista.");
  });

  it("S15: el texto del mensaje no incluye el razonamiento ni la imagen", () => {
    const parsed = parts();
    const message = parsed.events.find((event) => event.id.endsWith(":a1"));
    const text = parsed.content.find((item) => item.eventId === message?.id)?.text ?? "";

    expect(text).not.toContain("voy a listar");
    expect(text).not.toContain("<ref-sintetico>");
  });

  it("S12: la parte thinking produce un hijo reasoning con id, padre e indice", () => {
    const parsed = parts();
    const reasoning = parsed.events.find((event) => event.id === "ev:pi:test-session-parts:a1#p0");

    expect(reasoning?.kind).toBe("reasoning");
    expect(reasoning?.parentId).toBe("ev:pi:test-session-parts:a1");
    expect(reasoning?.partIndex).toBe(0);
    expect(reasoning?.toolCallId).toBeNull();
    expect(reasoning?.role).toBe("agent");
    expect(parsed.content.find((item) => item.eventId === reasoning?.id)?.text).toBe("voy a listar");
  });

  it("S12: la parte toolCall produce un hijo tool_call con nombre, id de llamada y argumentos canonicos", () => {
    const parsed = parts();
    const call = parsed.events.find((event) => event.id === "ev:pi:test-session-parts:a1#p2");

    expect(call?.kind).toBe("tool_call");
    expect(call?.parentId).toBe("ev:pi:test-session-parts:a1");
    expect(call?.partIndex).toBe(2);
    expect(call?.toolName).toBe("read");
    expect(call?.toolCallId).toBe("call_9");
    expect(parsed.content.find((item) => item.eventId === call?.id)?.text).toBe('{"path":"README.md"}');
  });

  it("S12/S15: la parte image produce un hijo attachment sin bytes", () => {
    const parsed = parts();
    const attachment = parsed.events.find((event) => event.id === "ev:pi:test-session-parts:a1#p3");

    expect(attachment?.kind).toBe("attachment");
    expect(attachment?.parentId).toBe("ev:pi:test-session-parts:a1");
    expect(attachment?.partIndex).toBe(3);
    expect(parsed.content.find((item) => item.eventId === attachment?.id)?.text).toBe("");
  });

  it("S13: el toolResult se emite como tool_result conservando toolName y toolCallId", () => {
    const parsed = parts();
    const result = parsed.events.find((event) => event.id.endsWith(":r1"));

    expect(result?.kind).toBe("tool_result");
    expect(result?.role).toBe("tool");
    expect(result?.toolName).toBe("read");
    expect(result?.toolCallId).toBe("call_9");
    expect(parsed.content.find((item) => item.eventId === result?.id)?.text).toBe("# Demo");
  });

  it("S13/S15: la parte image dentro del toolResult produce su attachment", () => {
    const parsed = parts();
    const attachment = parsed.events.find((event) => event.id === "ev:pi:test-session-parts:r1#p1");

    expect(attachment?.kind).toBe("attachment");
    expect(attachment?.parentId).toBe("ev:pi:test-session-parts:r1");
    expect(attachment?.partIndex).toBe(1);
    expect(parsed.content.find((item) => item.eventId === attachment?.id)?.text).toBe("");
  });

  it("S12: los hijos heredan la pertenencia a la rama activa del mensaje", () => {
    const parsed = parts();
    const message = parsed.events.find((event) => event.id.endsWith(":a1"));
    const children = parsed.events.filter((event) => event.id.startsWith("ev:pi:test-session-parts:a1#p"));

    expect(message?.onActiveBranch).toBe(true);
    expect(children.map((event) => event.onActiveBranch)).toEqual([true, true, true]);
  });

  it("S14: parsedLines cuenta entradas y partEvents cuenta los hijos derivados", () => {
    const parsed = parts();
    const { report } = parsed;

    expect(report.parsedLines).toBe(5);
    expect(report.partEvents).toBe(4);
    expect(report.totalLines).toBe(5);
    expect(report.parsedLines + report.rawOnly + report.malformed).toBe(report.totalLines);
    expect(parsed.events.length).toBe(9);
    expect(parsed.events.length).toBeGreaterThan(report.parsedLines);
  });

  it("S6: hay un registro de contenido por evento, incluidas las partes", () => {
    const parsed = parts();

    expect(parsed.content).toHaveLength(parsed.events.length);
    const eventIds = new Set(parsed.events.map((event) => event.id));
    for (const record of parsed.content) {
      expect(eventIds.has(record.eventId)).toBe(true);
    }
  });

  it("S5/S6: la parte comparte la referencia raw de su linea de origen", () => {
    const parsed = parts();
    const message = parsed.events.find((event) => event.id.endsWith(":a1"));
    const child = parsed.events.find((event) => event.id === "ev:pi:test-session-parts:a1#p0");

    expect(child?.raw).toEqual(message?.raw);
  });
});
