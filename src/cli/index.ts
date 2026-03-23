// @ts-nocheck: CLI command wiring uses dynamic types from cliffy and is intentionally untyped to ease maintenance.
// ─────────────────────────────────────────────────────────────
// testla-cli · src/cli/index.ts
// Command line interface entrypoint
// ─────────────────────────────────────────────────────────────

import { Command } from '@cliffy/command';
import { Input, Select, Confirm, Checkbox } from '@cliffy/prompt';
import { bold, cyan, green, red, yellow } from 'jsr:@std/fmt/colors';
import type { AgentStep } from '../agent/types.ts';
import { AgentLoop } from '../agent/loop.ts';
import { ConfigManager } from '../config/manager.ts';
import { createProvider } from '../llm/provider.ts';
import { SkillRegistry } from '../skills/registry.ts';
import { testlaCreateSkill } from '../skills/builtin/testla-create.ts';
import { testlaLensSkill } from '../skills/builtin/testla-lens.ts';
import { playwrightScreenplaySkill } from '../skills/builtin/playwright-screenplay.ts';
import { BUILTIN_TOOLS, checkTestlaProjectTool } from '../agent/tools.ts';
import { loadMCPTools } from '../mcp/client.ts';
import { registerSkillsCommands } from './skills-cmd.ts';
import { runSetup } from './setup.ts';
import { planTask, resolveTargets } from './planner.ts';
import type { FlowPlan, FlowStep } from '../cli/planner.ts';
import { walkFlow } from '../agent/discover.ts';
import type { DiscoveredState, WalkResult } from '../agent/discover.ts';

async function loadSkills(
    config: Awaited<ReturnType<ConfigManager['load']>>,
): Promise<SkillRegistry> {
    const registry = new SkillRegistry();

    // Built-in skills (always available)
    if (config.skills.enabled.includes('testla-create')) registry.register(testlaCreateSkill);
    if (config.skills.enabled.includes('testla-lens')) registry.register(testlaLensSkill);
    if (config.skills.enabled.includes('playwright-screenplay')) registry.register(playwrightScreenplaySkill);

    // Load skill directories (enabled skills only)
    await registry.loadFromDirectory(config.skills.dir, config.skills.enabled);
    return registry;
}

function printStep(step: AgentStep): void {
    switch (step.type) {
        case 'thought':
            // Always show model reasoning — critical for debugging
            if (step.content.trim()) {
                console.log(cyan('💭'), step.content.trim().slice(0, 300));
            }
            break;
        case 'tool_call':
            console.log(
                yellow('➡️'),
                bold(step.toolName ?? 'tool'),
                JSON.stringify(step.toolInput, null, 2),
            );
            break;
        case 'tool_result':
            if (step.content.startsWith('ERROR:')) {
                console.log(red('❌'), step.content);
            } else {
                console.log(green('✅'), step.content);
            }
            break;
        case 'final':
            console.log(bold(green('🎯 Task complete:')));
            console.log(step.content);
            break;
        default:
            console.log(step.content);
    }
}

async function runAgentTask(
    task: string,
    options: { cwd?: string; iterations?: number; confirmShell?: boolean },
): Promise<void> {
    const configManager = new ConfigManager();
    const config = await configManager.load();
    const registry = await loadSkills(config);
    const mcpTools = await loadMCPTools(config.mcp.servers);

    const initialWorkingDir = options.cwd ?? Deno.cwd();
    const url = extractFirstUrl(task) ?? await promptForBaseUrl();
    const projectName = deriveProjectName(url);
    const subDir = `${initialWorkingDir}/${projectName}`;
    let projectDir = initialWorkingDir;

    // ── Phase 1: Find or scaffold project ────────────────────────────
    const checkCwd = await checkTestlaProjectTool.execute({ path: initialWorkingDir });

    if (checkCwd.success) {
        projectDir = initialWorkingDir;
        console.log(cyan('✅'), `Using existing testla project at`, bold(initialWorkingDir));
    } else {
        const checkSub = await checkTestlaProjectTool.execute({ path: subDir });

        if (checkSub.success) {
            projectDir = subDir;
            Deno.chdir(projectDir);
            console.log(cyan('✅'), `Using existing testla project at`, bold(projectDir));
        } else {
            const createTool = registry.getAllTools().find((t) => t.name === 'testla_create_project');
            if (!createTool) throw new Error('Missing tool: testla_create_project');

            const browsers = extractBrowsers(task);
            const headless = !/\bheaded\b/i.test(task);

            console.log(cyan('🧱'), `Scaffolding \"${projectName}\" in`, bold(initialWorkingDir));

            const createResult = await createTool.execute({
                projectName,
                targetDir: initialWorkingDir,
                testsFolder: 'tests',
                baseUrl: url,
                browsers,
                headless,
                reporter: 'html',
                packageManager: 'npm',
                installDependencies: true,
            });

            if (!createResult.success) {
                console.log(red('❌ Scaffold failed:'), createResult.error ?? createResult.output);
                return;
            }

            projectDir = subDir;
            Deno.chdir(projectDir);
        }
    }

    const shellTool = BUILTIN_TOOLS.find((t) => t.name === 'shell');
    const maxAttempts = options.iterations ?? config.agent.maxIterations ?? 30;

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 3: Plan — LLM reads the prompt and returns a structured FlowPlan
    // ══════════════════════════════════════════════════════════════════════════
    const featureName = deriveProjectName(url).replace(/^testla-/, '');
    const provider = createProvider(config.llm);

    console.log(cyan('\n🧠  Step 3: Planning test flow...'));
    const plan = await planTask(provider, task, url, featureName);

    if (!plan) {
        console.log(red('❌  Planning failed — check LLM connection.'));
        return;
    }
    console.log(green('✅'), `${plan.pageStates.length} page state(s), ${plan.steps.length} step(s)`);
    console.log(cyan('   Flow:'), plan.pageStates.map(p => p.screenName).join(' → '));
    for (const a of plan.steps.filter(s => s.kind === 'assert')) {
        console.log(cyan('   Assert:'), a.assertionKind,
            a.assertionValue ? `"${a.assertionValue}"` : `visible "${a.hint}"`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 4: Walk — execute all steps in one real browser session.
    //         After every page state change: snapshot → Screen class.
    //         Nothing else happens here. Pure discovery.
    // ══════════════════════════════════════════════════════════════════════════
    const discoverDir = `${projectDir}/test-results/discover`;
    console.log(cyan('\n🔍  Step 4: Discovering all page states via real browser...'));

    const walk = await walkFlow(plan, url, discoverDir);

    if (!walk.success && walk.states.length === 0) {
        console.log(red('❌  Flow walk failed:'), walk.failedAt);
        return;
    }

    console.log(green(`✅  ${walk.states.length} page state(s) discovered`));

    // Resolve element targets: match hints from plan to discovered prop names
    const resolvedPlan = await resolveTargets(provider, plan, walk.states.map(s => ({
        id: s.pageStateId,
        elements: s.elements,
    })));

    // Get screenplay tools
    const allScreenplayTools = [...registry.getAllTools()];
    const screenTool = allScreenplayTools.find(t => t.name === 'screenplay_screen');
    const taskTool   = allScreenplayTools.find(t => t.name === 'screenplay_task');
    const specTool   = allScreenplayTools.find(t => t.name === 'screenplay_spec');

    if (!screenTool || !taskTool || !specTool) {
        console.log(red('❌  Missing screenplay tools. Enable playwright-screenplay skill.'));
        return;
    }

    // Generate one Screen class per discovered page state
    console.log(cyan('\n📄  Step 4 → Generating Screen classes...'));
    for (const state of walk.states) {
        const r = await screenTool.execute({
            name: state.screenName,
            projectDir,
            elements: state.elements.map(e => ({ name: e.propName, selector: e.locator, isLazy: true })),
        });
        if (r.success) {
            console.log(green('✅'), state.screenName, `(${state.elements.length} elements)`);
        } else {
            console.log(red('❌'), state.screenName, r.error ?? '');
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 5a: Decide if a custom Question class is needed.
    //
    // Standard assertions (no custom Question needed):
    //   - text:    Element.toBe.visible(page.getByText('exact text'))
    //   - visible: Element.toBe.visible(Screen.PROP)
    //   - url:     expect(page.url()).toContain('fragment')
    //
    // Custom Question needed only for complex assertions:
    //   - checking an element's text VALUE (not just visibility)
    //   - counting elements
    //   - comparing state across multiple elements
    // ══════════════════════════════════════════════════════════════════════════
    const assertSteps = resolvedPlan.steps.filter(s => s.kind === 'assert');
    const needsCustomQuestion = assertSteps.some(s =>
        s.assertionKind === 'count' || s.assertionKind === 'value'
    );

    console.log(cyan('\n🤔  Step 5a:'),
        needsCustomQuestion ? 'Custom Question needed' : 'No custom Question needed — using Element.toBe.visible()');

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 5b: Generate Task
    //          Uses Screen classes from Step 4.
    //          All imports reference real prop names from discovered screens.
    // ══════════════════════════════════════════════════════════════════════════
    console.log(cyan('\n📄  Step 5b: Generating Task...'));

    const actionSteps = resolvedPlan.steps.filter(
        s => s.kind === 'fill' || s.kind === 'click' || s.kind === 'navigate'
    );
    const firstPageState = resolvedPlan.pageStates[0];
    const taskActionStrings = buildTaskActions(actionSteps, resolvedPlan, url);

    // Collect all screen imports needed by the task
    // (only screens that have elements used in actions)
    const screenNamesUsedInTask = [...new Set(
        actionSteps
            .filter(s => s.kind !== 'navigate')
            .map(s => resolvedPlan.pageStates.find(p => p.id === s.pageStateId)?.screenName)
            .filter(Boolean) as string[]
    )];

    const taskResult = await taskTool.execute({
        name: resolvedPlan.taskName,
        projectDir,
        screenImport: firstPageState?.screenName ?? '',
        description: resolvedPlan.describeLabel,
        actions: taskActionStrings,
        factoryMethod: 'toApp',
        webActions: inferWebActions(actionSteps),
    });
    console.log(taskResult.success ? green('✅') : red('❌'), resolvedPlan.taskName,
        taskResult.success ? '' : taskResult.error ?? '');
    if (!taskResult.success) return;

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 5c: Generate Spec
    //          Calls the Task, then validates using Screen classes from Step 4.
    //          Imports ONLY the screens actually used in assertions.
    // ══════════════════════════════════════════════════════════════════════════
    console.log(cyan('\n📄  Step 5c: Generating Spec...'));

    // Build assertion lines — each uses a locator from a discovered screen
    const assertionLines = buildAssertionLines(assertSteps, resolvedPlan, walk.states);

    // Collect screen imports: task screen + assertion screens
    const screenNamesForSpec = [...new Set([
        firstPageState?.screenName,
        ...assertSteps.map(s => resolvedPlan.pageStates.find(p => p.id === s.pageStateId)?.screenName),
    ].filter(Boolean) as string[])];

    const taskCall =
        `await Bob.attemptsTo(\n` +
        `    ${resolvedPlan.taskName}.toApp()\n` +
        `);`;

    const specTests = [
        {
            name: assertionLines.length > 0
                ? 'executes flow and validates'
                : 'executes flow',
            body: assertionLines.length > 0
                ? taskCall + '\n' + assertionLines.join('\n')
                : taskCall,
        },
        {
            name: 'takes a screenshot',
            body:
                taskCall + '\n' +
                `const page = BrowseTheWeb.as(Bob).getPage();\n` +
                `await page.screenshot({ path: 'test-results/${featureName}.png', fullPage: true });`,
        },
    ];

    const specResult = await specTool.execute({
        name: featureName,
        projectDir,
        describeLabel: resolvedPlan.describeLabel,
        imports: [
            ...screenNamesForSpec.map(n =>
                `import { ${n} } from '../src/screenplay/screens/${toKebab(n)}';`
            ),
            `import { ${resolvedPlan.taskName} } from '../src/screenplay/tasks/${toKebab(resolvedPlan.taskName)}';`,
        ],
        tests: specTests,
    });
    console.log(specResult.success ? green('✅') : red('❌'), `${featureName}.spec.ts`,
        specResult.success ? '' : specResult.error ?? '');
    if (!specResult.success) return;

    // Tools for fix loop
    const allTools = [...BUILTIN_TOOLS, ...registry.getAllTools(), ...mcpTools];
    const agentTools = allTools.filter(t =>
        t.name !== 'testla_create_project' && t.name !== 'testla_install_deps',
    );

    // ── Phase 3: Verify loop ──────────────────────────────────────────
    if (!shellTool) {
        console.log(yellow('⚠️  No shell tool — skipping test verification'));
        return;
    }

    let attempt = 0;
    const maxFix = Math.min(maxAttempts, 30);

    while (attempt < maxFix) {
        attempt++;
        console.log(cyan(`\n🧪 Test run ${attempt}/${maxFix}...`));

        const testResult = await shellTool.execute({
            command: 'npm test -- --reporter=line 2>&1',
            cwd: projectDir,
        });

        if (testResult.success) {
            console.log(green(`✅ All tests passed on attempt ${attempt}!`));
            return;
        }

        console.log(yellow(`⚠️  Tests failed (attempt ${attempt}/${maxFix})`));

        if (attempt >= maxFix) {
            console.log(red('❌ Max fix attempts reached. Last error:'));
            console.log((testResult.output ?? '').slice(0, 1000));
            return;
        }

        // Build fix prompt with error context + file listing
        let fileContext = '';
        try {
            const ls = await shellTool.execute({
                command: 'find src/screenplay tests -name "*.ts" 2>/dev/null | head -20',
                cwd: projectDir,
            });
            fileContext = ls.success ? `\n\nProject files:\n${ls.output}` : '';
        } catch {
            // ignore
        }

        const errorOutput = (testResult.output ?? '').slice(0, 2500);
        const fixPrompt =
            `Fix the failing TypeScript/Playwright tests.\n\n` +
            `Project directory: ${projectDir}\n\n` +
            `Test error output:\n${errorOutput}${fileContext}\n\n` +
            `STRICT RULES — read carefully before making any change:\n` +
            `- Only fix TypeScript errors, wrong imports, or wrong API calls\n` +
            `- NEVER rewrite a spec file from scratch — only fix the specific error\n` +
            `- NEVER use: new testla.screenplay.Actor(), bob.usesAbilities(), describe(), it()\n` +
            `- Spec files MUST use this exact pattern:\n` +
            `    import { test, expect } from '../src/screenplay/fixtures/actors';\n` +
            `    test.describe('...', () => {\n` +
            `        test('...', async ({ Bob }) => {\n` +
            `            await Bob.attemptsTo(MyTask.toApp());\n` +
            `            await Bob.asks(Element.toBe.visible(MyScreen.PROP));\n` +
            `        });\n` +
            `    });\n` +
            `- Task files MUST use: return actor.attemptsTo(...) in performAs(actor: Actor)\n` +
            `- Fill syntax: Fill.in(Screen.PROP, 'value') — NOT Fill.in(...).with(...)\n` +
            `- Do NOT invent file paths or class names not already in the project`;

        console.log(cyan(`🔧 Fix attempt ${attempt}...`));

        // Fix loop only gets read/write/shell — no screenplay generators
        // This prevents the LLM from hallucinating new files with wrong paths
        const fixTools = allTools.filter((t) =>
            ['shell', 'read_file', 'write_file', 'list_dir'].includes(t.name)
        );
        const fixProvider = createProvider(config.llm);
        const fixAgent = new AgentLoop(
            fixProvider,
            fixTools,
            15,
            '',
        );

        await fixAgent.run({
            task: fixPrompt,
            workingDir: projectDir,
            maxIterations: 15,
            confirmShellCommands: false,
            onStep: printStep,
        });
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function toKebab(str: string): string {
    return str
        .replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function inferWebActions(steps: typeof plan.steps): string[] {
    const s = new Set<string>();
    for (const step of steps) {
        if (step.kind === 'navigate') s.add('Navigate');
        if (step.kind === 'fill')     s.add('Fill');
        if (step.kind === 'click')    s.add('Click');
    }
    if (s.size === 0) s.add('Navigate');
    return [...s];
}

function buildTaskActions(
    steps: typeof plan.steps,
    plan: typeof resolvedPlan,
    url: string,
): string[] {
    const lines: string[] = [];
    for (const step of steps) {
        if (step.kind === 'navigate') {
            lines.push(`Navigate.to(process.env.BASE_URL ?? ${JSON.stringify(url)})`);
        } else if (step.kind === 'fill') {
            const screenName = plan.pageStates.find(p => p.id === step.pageStateId)?.screenName ?? '';
            lines.push(step.target && screenName
                ? `Fill.in(${screenName}.${step.target}, ${JSON.stringify(step.value ?? '')})`
                : `// Fill "${step.hint}" — target not resolved`);
        } else if (step.kind === 'click') {
            const screenName = plan.pageStates.find(p => p.id === step.pageStateId)?.screenName ?? '';
            lines.push(step.target && screenName
                ? `Click.on(${screenName}.${step.target})`
                : `// Click "${step.hint}" — target not resolved`);
        }
    }
    return lines;
}

/**
 * Build assertion lines for the Spec.
 *
 * For each assert step we look up the REAL locator from the discovered
 * Screen elements — never guessing, never hardcoding.
 *
 * Priority order for 'text' assertions:
 *   1. A Screen element whose accessible name contains the assertion text
 *   2. page.getByText('...') as fallback
 */
function buildAssertionLines(
    assertSteps: typeof plan.steps,
    plan: typeof resolvedPlan,
    states: typeof walk.states,
): string[] {
    const lines: string[] = [];

    for (const step of assertSteps) {
        const pageState = plan.pageStates.find(p => p.id === step.pageStateId);
        const screenName = pageState?.screenName ?? '';
        const discoveredState = states.find(s => s.pageStateId === step.pageStateId)
            ?? states[states.length - 1];

        if (step.assertionKind === 'text' && step.assertionValue) {
            // The walk already found the best matching prop during discovery.
            // Use it directly — no re-matching needed.
            const ar = discoveredState?.assertionResults
                .find(a => a.assertionValue === step.assertionValue);

            const locator = ar?.matchedPropName && screenName
                ? `${screenName}.${ar.matchedPropName}`
                : `page.getByText(${JSON.stringify(step.assertionValue)})`;

            lines.push(
                `await Bob.asks(\n` +
                `    Element.toBe.visible(${locator})\n` +
                `);`
            );

        } else if (step.assertionKind === 'visible') {
            // Use the resolved target prop, or fall back to text search
            const locator = step.target && screenName
                ? `${screenName}.${step.target}`
                : `page.getByText(${JSON.stringify(step.hint ?? '')})`;

            lines.push(
                `await Bob.asks(\n` +
                `    Element.toBe.visible(${locator})\n` +
                `);`
            );

        } else if (step.assertionKind === 'url' && step.assertionValue) {
            lines.push(
                `const page = BrowseTheWeb.as(Bob).getPage();\n` +
                `expect(page.url()).toContain(${JSON.stringify(step.assertionValue)});`
            );
        }
    }

    return lines;
}


function toPascalCase(str: string): string {
    return str
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join('');
}


function extractFirstUrl(text: string): string | null {
    const match = text.match(/https?:\/\/[^\s)'"`]+/i);
    return match?.[0] ?? null;
}

function deriveProjectName(url: string): string {
    try {
        const u = new URL(url);
        const last = u.pathname.split('/').filter(Boolean).pop() ?? 'testla-project';
        const slug = last.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
        return `testla-${slug}`;
    } catch {
        return `testla-project`;
    }
}

function extractBrowsers(task: string): Array<'chromium' | 'firefox' | 'webkit'> {
    const lower = task.toLowerCase();
    const browsers: Array<'chromium' | 'firefox' | 'webkit'> = [];
    if (lower.includes('chromium')) browsers.push('chromium');
    if (lower.includes('firefox')) browsers.push('firefox');
    if (lower.includes('webkit')) browsers.push('webkit');
    return browsers.length ? browsers : ['chromium', 'firefox', 'webkit'];
}

async function promptForBaseUrl(): Promise<string> {
    return await Input.prompt({
        message: 'Base URL of the app under test (from your task)',
        default: 'https://example.com',
        validate: (v: string) => (v ? true : 'URL is required'),
    });
}

export function buildCLI(): Command {
    const cmd = new Command()
        .name('testla')
        .version('0.1.0')
        .description('testla — Open-source AI agent for developers (terminal CLI)')
        .command('setup', 'Interactive setup wizard')
        .action(async () => {
            await runSetup();
        })
        .command('run <task:string>', 'Run a natural language task')
        .option('-w, --cwd <cwd:string>', 'Working directory', { default: Deno.cwd() })
        .option('-i, --iterations <n:number>', 'Max iterations', { default: 30 })
        .option('--no-confirm', 'Disable confirmation for shell commands', { default: true })
        .action(async ({ cwd, iterations, confirm }, task) => {
            await runAgentTask(task, { cwd, iterations, confirmShell: confirm });
        })
        .command('new <project:string>', 'Scaffold a new testla project')
        .action(async (options, project) => {
            console.log(cyan('🧪'), 'Welcome to testla-screenplay project creation');

            // Interactive prompts
            const testsFolder = await Input.prompt({
                message: 'Name of your tests folder (default is \'tests\' or \'e2e\' if \'tests\' already exists):',
                default: 'tests'
            });

            const baseUrl = await Input.prompt({
                message: 'What is the base URL of the application under test?',
                default: 'https://example.com'
            });

            const browser = await Select.prompt({
                message: 'Which browser do you want to use?',
                options: [
                    { name: 'Chromium', value: 'chromium' },
                    { name: 'Firefox', value: 'firefox' },
                    { name: 'WebKit', value: 'webkit' }
                ],
                default: 'chromium'
            });

            const headless = await Confirm.prompt({
                message: 'Should tests run in headless mode?',
                default: true
            });

            const useAws = await Confirm.prompt({
                message: 'Will you interact with AWS services? (adds @testla/screenplay-aws)',
                default: false
            });

            const reporter = await Select.prompt({
                message: 'Which reporter do you want to use?',
                options: [
                    { name: 'HTML', value: 'html' },
                    { name: 'JUnit', value: 'junit' },
                    { name: 'JSON', value: 'json' },
                    { name: 'List', value: 'list' },
                    { name: 'Dot', value: 'dot' },
                    { name: 'Testla Screenplay HTML', value: 'screenplay:html' }
                ],
                default: 'screenplay:html'
            });

            const configManager = new ConfigManager();
            const config = await configManager.load();
            const registry = await loadSkills(config);
            const tools = registry.getAllTools();
            const createTool = tools.find(t => t.name === 'testla_create_project');
            const installTool = tools.find(t => t.name === 'testla_install_deps');

            if (!createTool) {
                console.log(red('❌ testla-create tool not found. Make sure the skill is enabled.'));
                return;
            }

            console.log(cyan('🔎'), 'Creating testla project:', bold(project));

            // Create the project with interactive config
            const createResult = await createTool.execute({
                projectName: project,
                targetDir: Deno.cwd(),
                testsFolder,
                baseUrl,
                browsers: [browser],
                headless,
                useAws,
                reporter,
                packageManager: 'npm',
            });

            if (!createResult.success) {
                console.log(red('❌ Failed to create project:'), createResult.error);
                return;
            }

            console.log(green('✅'), createResult.output);

            // Install dependencies
            if (installTool) {
                const projectDir = `${Deno.cwd()}/${project}`;
                console.log(cyan('📦'), 'Installing dependencies...');
                const installResult = await installTool.execute({
                    projectDir,
                    packageManager: 'npm',
                });

                if (installResult.success) {
                    console.log(green('✅'), 'Dependencies installed');
                } else {
                    console.log(yellow('⚠️'), 'Failed to install dependencies:', installResult.error);
                }
            }

            console.log(green('🎯 Project created successfully!'));
            console.log(cyan('🚀'), 'We suggest that you begin by typing:');
            console.log(`  cd ${project}`);
            console.log('  npm test');
        })
        .command('status', 'Check provider and MCP status')
        .action(async () => {
            const configManager = new ConfigManager();
            const config = await configManager.load();
            const provider = createProvider(config.llm);

            console.log(cyan('LLM Provider:'), config.llm.provider, config.llm.model);
            if (provider.healthCheck) {
                const ok = await provider.healthCheck();
                console.log(ok ? green('✅ Provider reachable') : red('❌ Provider unreachable'));
            }

            const mcpTools = await loadMCPTools(config.mcp.servers);
            console.log(cyan('MCP tools loaded:'), mcpTools.length);
        });

    // Register skill-related commands
    registerSkillsCommands(cmd);

    // Default action: prompt for task when no subcommand given
    cmd.action(async () => {
        const { Input } = await import('@cliffy/prompt');
        const task = await Input.prompt({ message: 'What should testla do?' });
        if (task) await runAgentTask(task, { cwd: Deno.cwd(), iterations: 30, confirmShell: true });
    });

    return cmd;
}

// Alias for backwards compatibility
export const createCli = buildCLI;