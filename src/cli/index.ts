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
import { planFromDiscovery } from './planner.ts';
import type { TaskAction } from './planner.ts';

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

    // ── Phase 2a: Discover real page elements ──────────────────────
    const discoverTool = BUILTIN_TOOLS.find((t) => t.name === 'discover_page');
    let discoveryReport = '';

    if (discoverTool) {
        console.log(cyan('🔍'), 'Discovering page elements at', bold(url));
        const discoverResult = await discoverTool.execute({
            url,
            outputDir: `${projectDir}/test-results/discover`,
        });

        if (!discoverResult.success) {
            console.log(red('❌ Page discovery failed:'), discoverResult.error);
            console.log(yellow('   Continuing — tests may need manual fixes.'));
        } else {
            discoveryReport = discoverResult.output;
            console.log(green('✅'), 'Page discovered');
        }
    }

    // ── Phase 2b: LLM plans actions (JSON only, no tool calls) ───────
    const featureName = deriveProjectName(url).replace(/^testla-/, '');
    const provider = createProvider(config.llm);

    console.log(cyan('🧠'), 'Planning test structure...');
    const plan = await planFromDiscovery(provider, task, url, featureName, discoveryReport);

    if (!plan) {
        console.log(red('❌ Planning failed — LLM did not return a valid plan.'));
        return;
    }

    console.log(green('✅'), `Plan: ${plan.taskName} → ${plan.questionName}`);

    // ── Phase 2c: CLI calls screenplay tools directly ─────────────────
    // LLM never touches projectDir, URL, or file paths.
    const allScreenplayTools = [...registry.getAllTools()];
    const screenTool    = allScreenplayTools.find((t) => t.name === 'screenplay_screen');
    const taskTool      = allScreenplayTools.find((t) => t.name === 'screenplay_task');
    const questionTool  = allScreenplayTools.find((t) => t.name === 'screenplay_question');
    const specTool      = allScreenplayTools.find((t) => t.name === 'screenplay_spec');

    if (!screenTool || !taskTool || !questionTool || !specTool) {
        console.log(red('❌ Missing screenplay tools. Enable playwright-screenplay skill.'));
        return;
    }

    // Parse discovered elements for the screen
    const screenElements = parseDiscoveredElements(discoveryReport);

    // 1) Screen
    console.log(cyan('📄'), `Generating ${plan.screenName}...`);
    const screenResult = await screenTool.execute({
        name: plan.screenName,
        projectDir,
        elements: screenElements,
    });
    if (!screenResult.success) {
        console.log(red('❌ Screen generation failed:'), screenResult.error);
        return;
    }
    console.log(green('✅'), screenResult.output.split('\n')[0]);

    // 2) Task — build action strings from the plan, in order
    const actionStrings = buildActionStrings(plan.actions, plan.screenName, url);
    console.log(cyan('📄'), `Generating ${plan.taskName}...`);
    const taskResult = await taskTool.execute({
        name: plan.taskName,
        projectDir,
        screenImport: plan.screenName,
        description: plan.describeLabel,
        actions: actionStrings,
        factoryMethod: 'toApp',
        webActions: inferWebActions(plan.actions),
    });
    if (!taskResult.success) {
        console.log(red('❌ Task generation failed:'), taskResult.error);
        return;
    }
    console.log(green('✅'), taskResult.output.split('\n')[0]);

    // 3) Spec — uses Element.toBe.visible() directly, no separate Question class
    //    Pattern: await Bob.asks(Element.toBe.visible(Screen.PROP))
    //    Or for text validation: expect(page).toContainText('text')
    const kebabTask = toKebab(plan.taskName);
    
    // Validate assertionTarget exists in screenElements, otherwise fallback to last element
    const elementNames = new Set(screenElements.map(e => e.name));
    const assertionProp = (plan.assertionTarget && elementNames.has(plan.assertionTarget)) 
        ? plan.assertionTarget 
        : screenElements[screenElements.length - 1]?.name ?? 'ELEMENT';
    
    if (plan.assertionTarget && !elementNames.has(plan.assertionTarget)) {
        console.log(yellow('⚠️  Assertion target not found:'), plan.assertionTarget);
        console.log(yellow('     Available elements:'), [...elementNames].join(', '));
        console.log(yellow('     Using fallback:'), assertionProp);
    }

    console.log(cyan('📄'), `Generating ${featureName}.spec.ts...`);
    
    // Build assertion body based on whether we have text validation
    let assertionBody: string;
    if (plan.assertionText) {
        // Text-based assertion: use page.locator(...).toContainText()
        assertionBody = 
            `const page = BrowseTheWeb.as(Bob).getPage();\n` +
            `        await expect(page).toContainText(${JSON.stringify(plan.assertionText)});`;
    } else {
        // Element-based assertion: use Element.toBe.visible()
        assertionBody = `Element.toBe.visible(${plan.screenName}.${assertionProp})`;
    }
    
    const specResult = await specTool.execute({
        name: featureName,
        projectDir,
        describeLabel: plan.describeLabel,
        imports: [
            `import { ${plan.screenName} } from '../src/screenplay/screens/${toKebab(plan.screenName)}';`,
            `import { ${plan.taskName} } from '../src/screenplay/tasks/${kebabTask}';`,
            // Element is already imported in spec template, so don't duplicate it
        ],
        tests: [
            {
                name: 'execute task and verify outcome',
                body:
                    `await Bob.attemptsTo(\n` +
                    `            ${plan.taskName}.toApp()\n` +
                    `        );\n` +
                    (plan.assertionText 
                        ? `        ${assertionBody}`
                        : `        await Bob.asks(\n` +
                          `            ${assertionBody}\n` +
                          `        );`
                    ),
            },
            {
                name: 'takes a screenshot',
                body:
                    `await Bob.attemptsTo(\n` +
                    `            ${plan.taskName}.toApp()\n` +
                    `        );\n` +
                    `        const page = BrowseTheWeb.as(Bob).getPage();\n` +
                    `        await page.screenshot({ path: 'test-results/${featureName}.png', fullPage: true });`,
            },
        ],
    });
    if (!specResult.success) {
        console.log(red('❌ Spec generation failed:'), specResult.error);
        return;
    }
    console.log(green('✅'), specResult.output.split('\n')[0]);

    // Tools available for fix loop
    const allTools = [...BUILTIN_TOOLS, ...registry.getAllTools(), ...mcpTools];
    const agentTools = allTools.filter(
        (t) => t.name !== 'testla_create_project' &&
               t.name !== 'testla_install_deps' &&
               t.name !== 'discover_page',
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
            `Instructions:\n` +
            `- Use read_file to inspect the failing file\n` +
            `- Use write_file to fix it\n` +
            `- Only fix TypeScript errors, wrong imports, or wrong API calls\n` +
            `- Do NOT use screenplay_screen, screenplay_task, screenplay_feature or any other generator tool\n` +
            `- Do NOT invent new file paths`;

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

// ── Helpers for Phase 2c ─────────────────────────────────────────────────

function toKebab(str: string): string {
    return str
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

interface ParsedElement { name: string; selector: string; isLazy: boolean }

function parseDiscoveredElements(report: string): ParsedElement[] {
    const elements: ParsedElement[] = [];
    // discover.ts outputs: { propName: "X", selector: "Y", isLazy: true },
    // screenplay_screen expects: { name: "X", selector: "Y", isLazy: true }
    // Parse each line that looks like a screenplay_screen element object
    const lines = report.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        // Match lines like: { propName: "...", selector: "...", isLazy: true },
        if (!trimmed.startsWith('{')) continue;
        if (!trimmed.includes('propName:')) continue;
        
        try {
            // Convert to valid JSON by adding quotes around keys and replacing JavaScript boolean with JSON true/false
            const jsonStr = trimmed
                .replace(/,\s*$/, '') // Remove trailing comma
                .replace(/propName:/g, '"propName":')
                .replace(/selector:/g, '"selector":')
                .replace(/isLazy:/g, '"isLazy":');
            
            const obj = JSON.parse(jsonStr);
            if (obj.propName && obj.selector && typeof obj.isLazy === 'boolean') {
                elements.push({ 
                    name: obj.propName, 
                    selector: obj.selector, 
                    isLazy: obj.isLazy 
                });
            }
        } catch (e) {
            // Skip malformed lines
            continue;
        }
    }
    return elements;
}

function buildActionStrings(actions: TaskAction[], screenName: string, url: string): string[] {
    return actions.map((a) => {
        switch (a.action) {
            case 'Navigate':
                // Use process.env.BASE_URL so tests respect the playwright.config.ts baseURL.
                // Falls back to the discovered URL if the env var is not set.
                return `Navigate.to(process.env.BASE_URL ?? ${JSON.stringify(url)})`;
            case 'Fill':
                return `Fill.in(${screenName}.${a.target}, ${JSON.stringify(a.value ?? '')})`;
            case 'Click':
                return `Click.on(${screenName}.${a.target})`;
            case 'Wait':
                return `Wait.forLoadState('networkidle')`;
            default:
                return `// ${a.action}${a.target ? ' ' + screenName + '.' + a.target : ''}`;
        }
    });
}

function inferWebActions(actions: TaskAction[]): string[] {
    const needed = new Set<string>();
    for (const a of actions) {
        if (a.action === 'Navigate') needed.add('Navigate');
        if (a.action === 'Fill')     needed.add('Fill');
        if (a.action === 'Click')    needed.add('Click');
        if (a.action === 'Wait')     needed.add('Wait');
    }
    if (needed.size === 0) needed.add('Navigate');
    return [...needed];
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