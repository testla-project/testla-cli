import { logger } from '../utils/logger.ts';
import * as state from '../utils/state.ts';

import { loadConfig, type TestlaConfig } from '../config/config.ts';
import { ensureTestlaProject } from './project.ts'
import { runAnalyst } from './analyst.ts';
import { runLens } from './lens.ts';

import { join } from '@std/path';
import { ensureDir } from '@std/fs';
import { validateExecution, logValidationResult, ValidationFailureReason } from '../utils/validator.ts';
// import { writeScreenplayFiles } from '../agents/codewriter.ts';
import type { ExecutedAction } from '../agents/playwright_cli.ts';

export interface OrchestratorOptions {
    ticket?: string;
    prompt?: string;
    projectDir?: string; // Überschreibt CWD
    outputDir?: string;
}

export async function runOrchestrator(opts: OrchestratorOptions): Promise<void> {
    // ─── Config ────────────────────────────────────────────────────────────────
    const config = await loadConfig(); 
    if (!config) {
        logger.error("Orchestrator", "❌ Keine Konfiguration. Bitte `testla setup` ausführen.\n");
        Deno.exit(1);
    }

    const cwd = opts.projectDir ?? Deno.cwd();
    // ─── Input auflösen ────────────────────────────────────────────────────────
    logger.divider("Testla is starting");
    
    let inputText: string;
    
    if (opts.prompt) {
        inputText = opts.prompt;
    } else {
        logger.error("Orchestrator", "❌ Kein Input. Verwende --ticket oder --prompt.");
        Deno.exit(1);
    }

    // ─── Projekt prüfen (vor State-Init, damit wir wissen ob Setup-Step nötig) ──
    const needsSetup = !(await projectExists(cwd));

    // ─── State initialisieren ──────────────────────────────────────────────────
    // const inputSpec = opts.prompt
    //     ? { type: "prompt" as const, value: opts.prompt ?? "".slice(0,80)} : "https://www.google.de";
    //     ? { type: "ticket" as const, value: opts.ticket! }
    //     : { type: "prompt" as const, value: (opts.prompt ?? "").slice(0, 80) };
    const inputSpec = {
        type: "prompt" as const,
        value: (opts.prompt ?? "").slice(0, 80),
    };

    const runState = state.buildInitialState(inputSpec, needsSetup)
    await state.initState(runState);

    logger.info("Orchestrator", `Run-ID: ${runState.runId}`);
    logger.info("Orchestrator", `Dashboard: testla dashboard`);

    // ─── SCHRITT 1: Projekt-Setup ──────────────────────────────────────────────
    let projectDir = cwd;

    if (needsSetup) {
        try {
            const result = await ensureTestlaProject(cwd);
            projectDir = result.projectDir;
        } catch (e) {
            await state.finishRun("failed");
            logger.error("Orchestrator", `Testla Project-Setup fehlgeschlagen: ${e}`);
            Deno.exit(1);
        }
    } else {
        logger.info("Orchestrator", "Bestehendes testla-project gefunden - Setup übersprungen");
        if (runState.pipeline.find((s) => s.id === "setup")) {
            await state.updateStep("setup", { status: "skipped", detail: "Bereits vorhanden"});
        }
    }

    // ─── Base URL ermitteln ───────────────────────────────────────────────────
    let baseUrl: string | null = null;
    // Prüfe ob in der .env eine BASE_URL (auch leer) enthält
    try {
        const envContent = await Deno.readTextFile(`${projectDir}/.env`);
        const envBaseUrlMatch = envContent.match(/BASE_URL=(.*)/);
        const envBaseUrl = envBaseUrlMatch ? envBaseUrlMatch[1].trim() : null;

        if (envBaseUrl && envBaseUrl != '') {
            baseUrl = envBaseUrl;
            logger.info('Orchestrator', `Base_URL aus .env geladen: ${baseUrl}`);
        } else {
            // BASE_URL ist leer → Extrahiere aus Prompt oder frage nach
            const urlRegex = /https?:\/\/[^\s]+/g;
            const extractedUrls = inputText.match(urlRegex);
            if (extractedUrls?.length) {
                baseUrl = extractedUrls[0];
                logger.info('Orchestrator', `BASE_URL aus Prompt extrahiert: ${baseUrl}`);
                // Aktualisiere .env mit der neuen BASE_URL
                await Deno.writeTextFile(`${projectDir}/.env`, `BASE_URL=${baseUrl}\n`);
            } else {
                // Interaktive Abfrage
                const userInput = prompt(`❓ Base_URL für die Tests (z.B. https://meine-app.de):`);
                if (userInput) {
                    baseUrl = userInput;
                    await Deno.writeTextFile(`${projectDir}/.env`, `BASE_URL=${baseUrl}\n`);
                }
            }
            logger.info('Orchestrator', `Base_URL in .env gespeichert: ${baseUrl}`);
        }
    } catch (error) {
        throw error; // Unerwarteter Fehler
    }

    // ─── SCHRITT 2: Analyst ────────────────────────────────────────────────────
    logger.agentStart("Analyst", "analyst", "Anforderungen → TOON Test-Brief");
    let toonBrief = ""; 
    const briefPath = resolveBriefPath(opts.outputDir ?? join(projectDir, ".testla", "briefs"), "key");

    try {
        const result = await runAnalyst(inputText, baseUrl ?? '', projectDir, (token) => {
            Deno.stdout.writeSync(new TextEncoder().encode(token));
            toonBrief += token;
        });
        toonBrief = result.toonBrief;
        console.log("\n");

        await ensureDir(briefPath.dir);
        await Deno.writeTextFile(briefPath.full, toonBrief);
        logger.agentEnd("Analyst", "analyst", "success", `Brief: ${briefPath.full}`);
    } catch (e) {
        logger.agentEnd("Analyst", "analyst", "failed", String(e));
        await state.finishRun("failed");
        Deno.exit(1);
    }

    const planResult = validatePlan(parseToonBrief(toonBrief));
    if (!planResult.ok) {
        logger.error("Orchestrator", `❌ Analyst-Plan ungültig: ${planResult.reason}\n${planResult.details}`);
        await state.finishRun("failed");
        Deno.exit(1);
    }


    // ─── SCHRITT 3: Explorer ──────────────────────────────────────────────────
    // TODO: Explorer implementieren — liefert actions: ExecutedAction[]
    // const actions = await runExplorer(projectDir, plan, baseUrl);

    // ─── SCHRITT 4: Validation + Writer (mit Retry-Loop) ──────────────────────
    // Aktivieren sobald Explorer echte actions liefert.
    // Aktuell: plan aus Analyst-Brief parsen, actions = [] als Platzhalter.
    // ─── SCHRITT 3–5: Explorer, Writer, Runner (Stubs) ─────────────────────────
    // Diese Agents werden in den nächsten Iterationen implementiert.
    // Für jetzt: als "pending" markiert und übersprungen.

    const plan = parseToonBrief(toonBrief);   // TODO: parseToonBrief implementieren
const actions: ExecutedAction[] = [];      // TODO: durch Explorer-Output ersetzen

const MAX_RETRIES = 3;
let attempt = 0;
let currentPlan = plan;
logger.info("Orchestrator", `plan.screens: ${JSON.stringify(plan.screens, null, 2)}`);
while (attempt < MAX_RETRIES) {
 
  const validation = validateExecution(currentPlan, actions);
  logValidationResult(validation, logger);

  if (validation.ok) break;

  if (validation.reason === ValidationFailureReason.MISSING_SCREEN_MAPPING) {
    logger.warn("Orchestrator", `→ Analyst re-run ${attempt + 1}/${MAX_RETRIES}`);
    const result = await runAnalyst(inputText, baseUrl ?? '', projectDir, (token) => {
      Deno.stdout.writeSync(new TextEncoder().encode(token));
    });
    currentPlan = parseToonBrief(result.toonBrief);
    attempt++;
    continue;
  }

  await state.finishRun("failed");
  throw new Error(`Execution aborted: ${validation.reason}`);
}

if (attempt === MAX_RETRIES) {
  await state.finishRun("failed");
  throw new Error("Analyst failed to produce a valid plan after max retries.");
}

// await writeScreenplayFiles(projectDir, currentPlan, actions);  // aktivieren wenn Explorer ready



    logger.divider("Agents 3-5 (Explorer · Writer · Runner)");
    logger.info("Orchestrator", "Diese Agents werden in der nächsten Iteration implementiert");

    for (const stepId of ["explorer", "writer", "runner", "verdict"]) {
        await state.updateStep(stepId, {
            status: "skipped",
            detail: "Noch nicht implementiert",
        });
    }

    // ─── Simulierter Runner-Erfolg für Lens-Test ───────────────────────────────
    // TODO: Durch echten Runner ersetzen. testsPassedSimulation = true = Lens läuft.
    const testsPassed = false;  // ← wird true sobald Runner implementiert ist
 
    // ─── SCHRITT 6: testla-lens (nur bei bestandenen Tests) ───────────────────
    if (testsPassed) {
        logger.divider("Qualitätsprüfung");
        try {
            const lensResult = await runLens(projectDir);
            if (!lensResult.passed) {
                logger.warn("Orchestrator", `Qualitäts-Score: ${lensResult.score}/100 — Verbesserungen empfohlen`);
            }
        } catch (e) {
            logger.warn("Orchestrator", `testla-lens Fehler: ${e} — wird ignoriert`);
            await state.updateStep("lens", { status: "skipped", detail: "Fehler beim Ausführen" });
        }
    } else {
        logger.info("Orchestrator", "Lens übersprungen (Tests noch nicht implementiert)");
        await state.updateStep("lens", { status: "skipped", detail: "Warte auf Runner" });
    }
 
    // ─── Abschluss ─────────────────────────────────────────────────────────────
    await state.finishRun("success");
    logger.divider("Fertig");
    logger.success("Orchestrator", `Test-Brief gespeichert: ${briefPath.full}`);
    logger.info("Orchestrator", "Nächster Schritt: Explorer-Agent wird den Brief verarbeiten.");
}
 
async function projectExists(cwd: string): Promise<boolean> {
  const MARKERS = ["testla-screenplay-playwright", "@testla/screenplay-playwright"];
  try {
    const raw = await Deno.readTextFile(`${cwd}/package.json`);
    const pkg = JSON.parse(raw);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return MARKERS.some((m) => m in deps);
  } catch {
    return false;
  }
}
 
function resolveBriefPath(
  dir: string,
  ticketKey: string | undefined,
): { dir: string; full: string } {
  const slug = ticketKey ?? `prompt-${Date.now()}`;
  return { dir, full: join(dir, `${slug}.toon`) };
}