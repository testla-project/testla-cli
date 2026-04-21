import { Command } from '@cliffy/command';
import { logger } from '../utils/logger.ts';
import { ensureTestlaProject } from '../agents/project.ts';
import { analystAgent, type AnalystPlan } from "../agents/analyst.ts";
import { buildPromptPlan, extractBaseUrlFromPrompt, normalizeUrl } from '../agents/prompt_plan.ts';
import { runPlaywrightCliPlan, type ExecutedAction } from '../agents/playwright_cli.ts';
import { writeScreenplayFiles } from '../agents/codewriter.ts';
import { loadConfig } from '../config/config.ts';
import { saveArtifact } from "../utils/persistence.ts";
import { validateExecution, logValidationResult } from '../utils/validator.ts';

export const runCommand = new Command()
    .description('Generate a Testla test from a prompt')
    .option('-p, --prompt <text:string>', 'URL oder Test-Beschreibung', { default: 'https://google.com' })
    .action(async (opts) => {
        const workingDir = Deno.cwd();
        const { projectDir } = await ensureTestlaProject(workingDir);
        const config = await loadConfig();
        const promptText = opts.prompt ?? '';
        const baseUrl = await resolveBaseUrl(projectDir, promptText);

        const inputSpec = {
            type: "prompt" as const,
            value: promptText.slice(0, 80),
        };

        logger.info('Orchestrator', `Modus: Prompt-Input [${inputSpec.value}]`);
        logger.info('Orchestrator', `Base_URL: ${baseUrl}`);

        try {
            // 1️⃣ Analyst → TOON
            logger.info('Analyst', 'Starte Analyse...');
            const plan: AnalystPlan = await analystAgent(promptText, baseUrl, config!);
            await saveArtifact("last_plan.json", plan);
            logger.info('Analyst', 'TOON Spec received');

            // 2️⃣ Explorer → Realität aus Browser
            logger.info('Explorer', `Starte Playwright-CLI-Flow auf: ${baseUrl}`);
            const { actions, snapshot } = await runPlaywrightCliPlan(plan, baseUrl, config!);
            await saveArtifact("last_snapshot.json", snapshot);
            await saveArtifact("last_actions.json", actions);
            logger.info('Explorer', `${actions.length} actions recorded`);

            // 3️⃣ Guard → Validierung vor dem CodeWriter
            // Harter Gate: Misalignment zwischen Plan und Explorer-Output
            // wird hier gestoppt — der CodeWriter bekommt nie kaputte Arrays.
            const validation = validateExecution(plan, actions);
            logValidationResult(validation, logger);

            if (!validation.ok) {
                logger.error(
                    'Orchestrator',
                    `Pipeline abgebrochen [${validation.reason}]. Keine Dateien wurden geschrieben.`,
                );
                Deno.exit(1);
            }

            // 4️⃣ Codewriter → Screens, Tasks, Spec schreiben
            // Nur erreichbar wenn Guard bestanden — Index-Zip ist sicher.
            await writeScreenplayFiles(projectDir, plan, actions);
            logger.info('Codewriter', '✅ Screenplay files generated');

        } catch (error) {
            logger.error('Orchestrator', `Fehler beim Durchlauf: ${error}`);
            throw error;
        }
    });

async function resolveBaseUrl(projectDir: string, prompt: string): Promise<string> {
    try {
        const envContent = await Deno.readTextFile(`${projectDir}/.env`);
        const envBaseUrlMatch = envContent.match(/BASE_URL=(.*)/);
        const envBaseUrl = envBaseUrlMatch ? normalizeUrl(envBaseUrlMatch[1].trim()) : null;
        if (envBaseUrl) return envBaseUrl;
    } catch {
        // fall through
    }

    const extracted = extractBaseUrlFromPrompt(prompt);
    if (!extracted) {
        throw new Error('Keine Base URL gefunden. Bitte gib eine URL oder Domain im Prompt an.');
    }

    await Deno.writeTextFile(`${projectDir}/.env`, `BASE_URL=${extracted}\n`);
    return extracted;
}

async function buildExecutionPlan(
    prompt: string,
    baseUrl: string,
    projectDir: string,
): Promise<AnalystPlan> {
    try {
        const { plan } = await runAnalyst(prompt, baseUrl, projectDir);
        return plan;
    } catch (error) {
        logger.warn(
            'Analyst',
            `LLM-Plan fehlgeschlagen, nutze lokalen Fallback-Parser: ${String(error)}`,
        );
        return buildPromptPlan(prompt, baseUrl);
    }
}