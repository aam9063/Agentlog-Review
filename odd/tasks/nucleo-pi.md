# Fase 1 — Núcleo: lectura sin pérdida de sesiones pi

## Specs

- **S1** — Puerta 1: «Reconstruye la sesión de ejemplo sin pérdida».
- **S2** — Identidad de conteo. Toda línea no vacía cae en exactamente un cubo disjunto: `totalLineas = parseadas + soloRaw + malformadas`. `parseadas` incluye las entradas con deriva: la deriva es una marca, no un cubo, así que no se cuenta aparte sin duplicar. Las líneas vacías se cuentan aparte como `lineasVacias` y no son datos.
- **S3** — Árbol íntegro. Cada `id` aparece una vez; cada `parentId` resuelve a un `id` conocido o se declara huérfano con su motivo. La cabecera `session` no tiene la clave `parentId` (ausente, distinto de `null`) y no es nodo del árbol.
- **S4** — Rama activa estable. El recorrido hoja a raíz da el mismo conjunto de eventos con el archivo en su orden original y con las líneas barajadas. La hoja se elige por `timestamp` máximo y se desempata por `id`, nunca por posición en el archivo.
- **S5** — IDs deterministas. Dos corridas sobre el mismo input producen IDs idénticos; el ID deriva del `id` de origen o del hash canónico del contenido, jamás del orden de llegada.
- **S6** — Raw recuperable. Se registra el `sha256` de cada línea no vacía y el texto de cada evento es recuperable desde `content` y `raw`. Hay un registro de `content` por evento, aunque su texto sea vacío.
- **S7** — Deriva ruidosa. Un campo desconocido aparece en el informe de deriva y hace fallar el test; nunca se descarta en silencio.
- **S8** — Modelo de datos de tres tablas: `sessions`, `events`, `content`, más `raw` siempre conservado.
- **S9** — Entradas `custom` de gentle-pi modeladas: `session-worktree/v1`, `session-change/v1`, `review-reminder-receipt/v1`. Los `kind: nudged` y `acknowledged` se toleran aunque el corpus no los traiga.
- **S10** — El JSONL es la fuente de verdad. El HTML exportado no se parsea y no hay ejecución de código de la entrega.
- **S11** — Stack: Node 24 + TypeScript estricto (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`). Sin dependencias de runtime en esta tarea.
- **S12** — Eventos de parte. Un mensaje del agente con partes `thinking`, `toolCall` o `image` produce eventos hijos de tipo `reasoning`, `tool_call` y `attachment`. Cada hijo lleva `parentId` igual al id del evento del mensaje y hereda su pertenencia a la rama activa. Su id deriva del id del mensaje más el índice de la parte, así que es estable ante reordenamientos del archivo.
- **S13** — Un mensaje con `role: toolResult` se emite como evento de tipo `tool_result`, conservando `toolName` y `toolCallId`, para poder ligar cada llamada con su resultado.
- **S14** — La identidad de conteo se mide sobre líneas, no sobre eventos. `parsedLines` cuenta entradas del archivo; `events` cuenta filas normalizadas y puede ser mayor. Invariante: `totalLines = parsedLines + rawOnly + malformed`, y todo evento apunta a una línea real del `raw`.
- **S15** — Las imágenes se referencian, no se incrustan: una parte `image` produce un evento `attachment` sin bytes y el texto del mensaje no la incluye.
- **S16** — Señales deterministas de sesión. Sin LLM y sin repositorio, el informe calcula: turnos humanos y su longitud, llamadas a herramienta por nombre, comandos de shell, comandos de git por subcomando, comandos de verificación (test, build, lint, check, typecheck), errores de herramienta, compactaciones y cantidad de eventos.
- **S17** — No capturable explícito. El código de salida no existe en el formato de pi, así que `signals.notCapturable` incluye `exitCode` con su motivo y ninguna señal se puntúa por su ausencia. Es la regla del brief: "no capturable", nunca puntuar bajo.
- **S18** — Emparejamiento por `toolCallId`. Cada llamada tiene a lo sumo un resultado con el mismo `toolCallId`; las llamadas sin resultado se cuentan como `unpairedToolCalls` y se declaran señal reducida, nunca mala práctica.
- **S19** — Las marcas de cuestionamiento son una heurística declarada, con patrones listados y versionados, y se reportan como estimación. Los patrones cubren español e inglés para no castigar el idioma en que escribe el candidato.
- **S20** — T3 calcula números; no convierte nada a niveles Developing, Adequate o Strong. Esa conversión no ocurre en esta tarea.

## Tasks

- **T1** — Lector JSONL sin pérdida, contratos de deriva, IDs deterministas y resolución de árbol. Specs: S1–S8. Ruta: inline. Commit: pendiente.
- **T2** — Refinamiento semántico de eventos: partes de mensaje a `reasoning`, `tool_call` y `attachment`; `tool_result` propio; `toolCallId` para ligar llamada y resultado. Specs: S8, S9, S12–S15. Ruta: delegada. Commit: pendiente.
- **T3** — Señales deterministas de sesión. Specs: S16–S20. Ruta: delegada. Commit: pendiente.
- **T4** — Análisis git del repositorio entregado con `execFile`. Commit: pendiente.
- **T5** — Lectura segura de ZIP con `yauzl`, límites y rechazo de rutas fuera del destino. Commit: pendiente.
- **T6** — Informe HTML autocontenido. Commit: pendiente.
- **T7** — Fixture real anonimizado y validación manual contra la sesión completa. Commit: pendiente.

## Log

- **L1** (original) — «En la carpeta del proyecto tienes un documento brief en markdown para que lo leas y asimiles y entiendas en que consiste el proyecto que vamos a realizar»
- **L2** — «Arranca por ahi si antes del stack»: investigar el esquema de las entradas `custom` de gentle-pi antes de decidir el stack.
- **L3** — «Todo en orden, continua con el stack»: ratifica los criterios de Puerta 1 y pasa a la decisión de stack.
- **L4** — Decisión de stack: TypeScript, contra la recomendación de Python mínimo. Riesgo aceptado y registrado en el brief: Node no tiene binario único estable, así que la distribución al evaluador no técnico queda para fase 4.
- **L5** — Corrección a S2 encontrada al implementar T1: la fórmula original del brief sumaba `deriva_declarada` como un cuarto sumando, lo que duplica las entradas con deriva porque ya están contadas como parseadas. Queda como cubo disjunto de tres términos sobre líneas no vacías.
- **L6** — «si si»: autoriza T2 en la rama `feat/fase-1-t2-partes` creada desde `dev`. Se fijan S12–S15 antes de delegar, incluido el cambio de S14: `parsed` pasa a significar líneas parseadas y no eventos, porque las partes hacen que los eventos superen a las líneas y el cubo debe seguir cerrando sobre el archivo.
- **L7** — «pues continua»: autoriza T3. Antes de delegar se verifica el dato y aparece que **pi no emite código de salida**: cero ocurrencias de `exitCode`, `exit_code`, `exitStatus`, `statusCode` o `signal` en 1.073 líneas, y `details` lleva cargas por herramienta (mem_save, gentleTodo, diff), no metadata de shell. El brief prometía verificación "con su código de salida" y reconstrucción de git "leyendo el código de salida": ambas quedan `no capturable` y el brief se corrige en la misma pasada. La única señal de fallo real del formato es `message.isError`, 14 veces en el fixture.
