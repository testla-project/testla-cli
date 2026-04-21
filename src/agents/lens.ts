import * as logger from "../utils/logger.ts";

export interface LensResult {
  score: number;                  // 0–100
  passed: boolean;
  readability?: number;
  locatorQuality?: number;
  screenpLayAdherence?: number;
  duplicates?: number;
  reportPath?: string;
  raw: string;
}

/**
 * Führt testla-lens im Projekt-Verzeichnis aus.
 * testla-lens muss im Projekt installiert oder global verfügbar sein.
 */
export async function runLens(projectDir: string): Promise<LensResult> {
  logger.agentStart("Lens", "lens", "Analysiere Test-Qualität mit testla-lens");

  // testla-lens aufrufen — versuche zuerst lokale npx-Version
  const result = await executeLens(projectDir);

  if (result.passed) {
    logger.agentEnd("Lens", "lens", "success", `Score: ${result.score}/100`);
  } else {
    logger.warn("Lens", `Score unter Schwellwert: ${result.score}/100`);
    logger.agentEnd("Lens", "lens", "success", `Score: ${result.score}/100 (Verbesserungen empfohlen)`);
  }

  return result;
}

async function executeLens(projectDir: string): Promise<LensResult> {
  // JSON-Output anfragen damit wir strukturiert parsen können
  const cmd = new Deno.Command("npx", {
    args: ["testla-lens", "--json", "--output", ".nova/lens-report.json"],
    cwd: projectDir,
    stdout: "piped",
    stderr: "piped",
  });

  let code: number;
  let stdout: Uint8Array;
  let stderr: Uint8Array;

  try {
    ({ code, stdout, stderr } = await cmd.output());
  } catch (e) {
    // testla-lens nicht verfügbar
    logger.warn("Lens", "testla-lens nicht gefunden — überspringe Qualitätsprüfung");
    logger.agentEnd("Lens", "lens", "success", "übersprungen (nicht installiert)");
    return { score: 0, passed: false, raw: "", reportPath: undefined };
  }

  const out = new TextDecoder().decode(stdout);
  const err = new TextDecoder().decode(stderr);

  if (code !== 0 && !out) {
    throw new Error(`testla-lens fehlgeschlagen: ${err}`);
  }

  return parseLensOutput(out, projectDir);
}

function parseLensOutput(raw: string, projectDir: string): LensResult {
  try {
    // Versuche JSON zu parsen (wenn testla-lens --json unterstützt)
    const json = JSON.parse(raw);
    return {
      score: json.score ?? 0,
      passed: (json.score ?? 0) >= 70,
      readability: json.readability,
      locatorQuality: json.locatorQuality,
      screenpLayAdherence: json.screenpLayAdherence,
      duplicates: json.duplicates,
      reportPath: `${projectDir}/.nova/lens-report.json`,
      raw,
    };
  } catch {
    // Fallback: Score aus plain-text output extrahieren
    const scoreMatch = raw.match(/score[:\s]+(\d+)/i);
    const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 50;

    // Einzelmetriken
    const readMatch = raw.match(/readability[:\s]+([\d.]+)/i);
    const locMatch  = raw.match(/locator[:\s]+([\d.]+)/i);
    const spMatch   = raw.match(/screenplay[:\s]+([\d.]+)/i);
    const dupMatch  = raw.match(/duplicate[s]?[:\s]+(\d+)/i);

    if (score > 0) {
      logger.info("Lens", `Score: ${score}/100`);
      if (readMatch) logger.info("Lens", `Readability:   ${readMatch[1]}`);
      if (locMatch)  logger.info("Lens", `Locator-Qual.: ${locMatch[1]}`);
      if (spMatch)   logger.info("Lens", `Screenplay:    ${spMatch[1]}`);
      if (dupMatch)  logger.info("Lens", `Duplikate:     ${dupMatch[1]}`);
    }

    return {
      score,
      passed: score >= 70,
      readability: readMatch ? parseFloat(readMatch[1]) : undefined,
      locatorQuality: locMatch ? parseFloat(locMatch[1]) : undefined,
      screenpLayAdherence: spMatch ? parseFloat(spMatch[1]) : undefined,
      duplicates: dupMatch ? parseInt(dupMatch[1], 10) : undefined,
      raw,
    };
  }
}