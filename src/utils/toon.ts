/**
 * toon.ts
 * ──────────────────────────────────────────────────────────────
 * TOON – Token-Oriented Object Notation
 *
 * Das zentrale Kommunikationsformat zwischen allen Nova-Agenten.
 *
 * Struktur:
 *   [TOON:<type>]
 *   <header-key>: <value>
 *   ---
 *   <JSON payload>
 *   [/TOON]
 *
 * Beispiel:
 *   [TOON:request]
 *   from: analyst
 *   to: llm
 *   version: 1.0
 *   ---
 *   { "task": "decompose", "prompt": "..." }
 *   [/TOON]
 * ──────────────────────────────────────────────────────────────
 */

// ─── Typen ────────────────────────────────────────────────────

export type ToonType =
  | "request"
  | "response"
  | "plan"
  | "error"
  | "event"
  | "result";

export type AgentName =
  | "orchestrator"
  | "analyst"
  | "explorer"
  | "codewriter"
  | "runner"
  | "verdict"
  | "lens"
  | "llm";

export interface ToonEnvelope<T = unknown> {
  type: ToonType;
  headers: Record<string, string>;
  payload: T;
}

// ─── Serialisierung ───────────────────────────────────────────

/**
 * Serialisiert ein ToonEnvelope in das Text-Format.
 * Wird an das LLM gesendet oder in Dateien geschrieben.
 */
export function toonSerialize<T>(envelope: ToonEnvelope<T>): string {
  const headerLines = Object.entries(envelope.headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  const payloadJson = JSON.stringify(envelope.payload, null, 2);

  return `[TOON:${envelope.type}]\n${headerLines}\n---\n${payloadJson}\n[/TOON]`;
}

/**
 * Deserialisiert einen TOON-String zurück in ein ToonEnvelope.
 * Wirft einen Fehler wenn das Format ungültig ist.
 */
export function toonDeserialize<T = unknown>(raw: string): ToonEnvelope<T> {
  // Extrahiere den Block zwischen [TOON:...] und [/TOON]
  const blockMatch = raw.match(/\[TOON:(\w+)\]([\s\S]*?)\[\/TOON\]/);
  if (!blockMatch) {
    throw new Error(`TOON: Kein gültiger TOON-Block gefunden.\n---\n${raw}`);
  }

  const type = blockMatch[1] as ToonType;
  const body = blockMatch[2].trim();

  // Trenne Header und Payload am ersten "---"
  const separatorIdx = body.indexOf("---");
  if (separatorIdx === -1) {
    throw new Error(`TOON: Kein Header/Payload-Separator (---) gefunden.`);
  }

  const headerSection = body.slice(0, separatorIdx).trim();
  const payloadSection = body.slice(separatorIdx + 3).trim();

  // Header parsen: "key: value" → Record
  const headers: Record<string, string> = {};
  for (const line of headerSection.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    headers[key] = value;
  }

  // Payload: JSON parsen
  let payload: T;
  try {
    payload = JSON.parse(payloadSection) as T;
  } catch {
    throw new Error(`TOON: Payload ist kein gültiges JSON.\n---\n${payloadSection}`);
  }

  return { type, headers, payload };
}

/**
 * Extrahiert den ersten TOON-Block aus einem LLM-Response-String.
 * Toleriert Text vor/nach dem Block (z. B. wenn das LLM trotzdem
 * etwas erklärt).
 */
export function toonExtractFirst<T = unknown>(raw: string): ToonEnvelope<T> {
  return toonDeserialize<T>(raw);
}

// ─── Builder-Helfer ───────────────────────────────────────────

export function toonRequest<T>(
  from: AgentName,
  to: AgentName,
  payload: T,
  extra?: Record<string, string>,
): ToonEnvelope<T> {
  return {
    type: "request",
    headers: {
      from,
      to,
      version: "1.0",
      timestamp: new Date().toISOString(),
      ...extra,
    },
    payload,
  };
}

export function toonResponse<T>(
  from: AgentName,
  to: AgentName,
  payload: T,
  extra?: Record<string, string>,
): ToonEnvelope<T> {
  return {
    type: "response",
    headers: {
      from,
      to,
      version: "1.0",
      timestamp: new Date().toISOString(),
      ...extra,
    },
    payload,
  };
}

export function toonPlan<T>(
  from: AgentName,
  payload: T,
  extra?: Record<string, string>,
): ToonEnvelope<T> {
  return {
    type: "plan",
    headers: {
      from,
      version: "1.0",
      timestamp: new Date().toISOString(),
      ...extra,
    },
    payload,
  };
}

export function toonError(
  from: AgentName,
  message: string,
  detail?: string,
): ToonEnvelope<{ message: string; detail?: string }> {
  return {
    type: "error",
    headers: {
      from,
      version: "1.0",
      timestamp: new Date().toISOString(),
    },
    payload: { message, detail },
  };
}

// ─── Datei-I/O ────────────────────────────────────────────────

/**
 * Schreibt ein ToonEnvelope als .toon-Datei.
 * Erstellt den Ordner falls nötig.
 */
export async function toonWriteFile<T>(
  filePath: string,
  envelope: ToonEnvelope<T>,
): Promise<void> {
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(filePath, toonSerialize(envelope));
}

/**
 * Liest eine .toon-Datei und deserialisiert sie.
 */
export async function toonReadFile<T = unknown>(
  filePath: string,
): Promise<ToonEnvelope<T>> {
  const raw = await Deno.readTextFile(filePath);
  return toonDeserialize<T>(raw);
}