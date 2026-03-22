// ─────────────────────────────────────────────────────────────
// testla-cli · src/skills/builtin/testla-create.ts
//
// API Reference (testla-screenplay-playwright docs):
//   Actor  → Actor.named('X').with('k',v).can(BrowseTheWeb.using(page))
//   Task   → extends Task, performAs(actor: Actor), actor.attemptsTo(...)
//   Question → extends Question<T>, answeredBy(actor: Actor)
//   Screen → static class: CSS string OR LazySelector = (page: Page) => page.getBy...()
//   Actions → Navigate.to(), Click.on(), Fill.in(), Element.toBe.visible(), Element.toHave.text()
//   Imports → @testla/screenplay-playwright  +  /web  +  /api
// ─────────────────────────────────────────────────────────────

import type { Skill } from '../types.ts';
import type { AgentTool } from '../../agent/types.ts';

const scaffoldProjectTool: AgentTool = {
    name: 'testla_create_project',
    description:
        'Scaffold a new testla-screenplay-playwright project with correct structure: ' +
        'playwright.config.ts, actors.ts fixture, example Screen/Task/Question, working spec.',
    parameters: {
        type: 'object',
        properties: {
            projectName: {
                type: 'string',
                description:
                    'The name for the new project directory, e.g. "testla-random-redesign-picker". ' +
                    'This is REQUIRED. Derive it from the app name in the task. ' +
                    'Do NOT pass projectDir instead of this.',
            },
            targetDir: { type: 'string', description: 'Parent directory' },
            testsFolder: { type: 'string', description: 'Tests folder name (default: tests)' },
            baseUrl: {
                type: 'string',
                description: 'Base URL of the app under test (use "baseUrl", not "baseURL").',
            },
            browsers: {
                type: 'array',
                items: { type: 'string', enum: ['chromium', 'firefox', 'webkit'] },
                description: 'Browsers to test (default: [chromium, webkit])',
            },
            headless: { type: 'boolean', description: 'Run headless (default: true)' },
            reporter: { type: 'string', description: 'Reporter (default: html)' },
            packageManager: { type: 'string', enum: ['npm', 'pnpm', 'yarn'] },
            useAws: {
                type: 'boolean',
                description: 'Install @testla/screenplay-aws for AWS service interactions (default: false)',
            },
            installDependencies: { type: 'boolean', description: 'Install deps after scaffold (default: true)' },
        },
        required: ['projectName'],
    },
    async execute(input) {
        // Guard: LLM sometimes omits projectName or passes projectDir instead
        const projectName = (input.projectName as string | undefined) ||
            (input.name as string | undefined);
        if (!projectName || typeof projectName !== 'string') {
            return {
                success: false,
                output: '',
                error:
                    'testla_create_project requires "projectName" (a string like "testla-my-app"). ' +
                    'Do not pass "projectDir" to this tool — it derives the directory from projectName automatically.',
            };
        }
        const targetDir = (input.targetDir as string | undefined) ?? Deno.cwd();
        const testsFolder = (input.testsFolder as string | undefined) ?? 'tests';
        // Accept both baseUrl and baseURL (LLMs sometimes use wrong casing)
        const baseUrl = (input.baseUrl as string | undefined) ??
            (input.baseURL as string | undefined) ?? 'https://example.com';
        const browsers = ((input.browsers as string[] | undefined)?.length)
            ? (input.browsers as string[])
            : ['chromium', 'webkit'];
        const headless = (input.headless as boolean | undefined) ?? true;
        const reporter = (input.reporter as string | undefined) ?? 'html';
        const pm = (input.packageManager as string | undefined) ?? 'npm';
        const useAws = (input.useAws as boolean | undefined) ?? false;
        const installDeps = (input.installDependencies as boolean | undefined) ?? true;
        const projectDir = `${targetDir}/${projectName}`;

        try {
            // ── Directories ────────────────────────────────────
            for (const dir of [
                testsFolder,
                'src/screenplay/fixtures',
                'src/screenplay/tasks',
                'src/screenplay/actions',
                'src/screenplay/questions',
                'src/screenplay/screens',
            ]) {
                await Deno.mkdir(`${projectDir}/${dir}`, { recursive: true });
            }

            // ── package.json ───────────────────────────────────
            await Deno.writeTextFile(`${projectDir}/package.json`, JSON.stringify({
                name: projectName,
                version: '1.0.0',
                description: 'testla-screenplay-playwright project',
                scripts: {
                    test: 'npx playwright test',
                    'test:headed': 'npx playwright test --headed',
                    'test:report': 'npx playwright show-report',
                },
                devDependencies: {
                    '@playwright/test': '^1.40.0',
                    '@types/node': '^20.0.0',
                    typescript: '^5.0.0',
                },
                dependencies: {
                    '@testla/screenplay-playwright': 'latest',
                    ...(useAws ? { '@testla/screenplay-aws': 'latest' } : {}),
                    dotenv: '^16.0.0',
                },
            }, null, 2));

            // ── tsconfig.json ──────────────────────────────────
            await Deno.writeTextFile(`${projectDir}/tsconfig.json`, JSON.stringify({
                compilerOptions: {
                    target: 'ES2020',
                    module: 'commonjs',
                    lib: ['ES2020'],
                    strict: true,
                    esModuleInterop: true,
                    skipLibCheck: true,
                },
                include: [testsFolder, 'src'],
                exclude: ['node_modules'],
            }, null, 2));

            // ── playwright.config.ts ───────────────────────────
            const deviceMap: Record<string, string> = {
                chromium: "devices['Desktop Chrome']",
                firefox: "devices['Desktop Firefox']",
                webkit: "devices['Desktop Safari']",
            };
            const projectsBlock = browsers
                .map((b) => `    { name: '${b}', use: { ...${deviceMap[b] ?? `{ browserName: '${b}' }`} } }`)
                .join(',\n');

            await Deno.writeTextFile(`${projectDir}/playwright.config.ts`,
`import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
dotenv.config();

export default defineConfig({
  testDir: './${testsFolder}',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: '${reporter}',
  use: {
    baseURL: process.env.BASE_URL || '${baseUrl}',
    trace: 'on-first-retry',
    headless: ${headless},
    screenshot: 'only-on-failure',
  },
  projects: [
${projectsBlock}
  ],
});
`);

            // ── .env ───────────────────────────────────────────
            await Deno.writeTextFile(`${projectDir}/.env`, `BASE_URL=${baseUrl}\n`);

            // ── .gitignore ─────────────────────────────────────
            await Deno.writeTextFile(`${projectDir}/.gitignore`,
`node_modules/
dist/
test-results/
playwright-report/
.playwright/
screenshots/
*.local
`);

            // ─────────────────────────────────────────────────
            // src/screenplay/fixtures/actors.ts
            // Correct pattern per testla-screenplay docs:
            // - browser + request fixtures, context.newPage()
            // - Named actors with username/password from env
            // - Default actor name: Bob
            // ─────────────────────────────────────────────────
            const awsImport = useAws
                ? `import { UseAWS } from '@testla/screenplay-aws';\n`
                : '';
            const awsAbility = useAws
                ? `        .can(UseAWS.fromEnv())\n`
                : '';

            await Deno.writeTextFile(`${projectDir}/src/screenplay/fixtures/actors.ts`,
`import { APIRequestContext, Browser, test as base } from '@playwright/test';
import { Actor } from '@testla/screenplay-playwright';
import { BrowseTheWeb } from '@testla/screenplay-playwright/web';
import { UseAPI } from '@testla/screenplay-playwright/api';
${awsImport}
// Function to create a user actor with Web browsing and API capabilities
const createUser = async (
    browser: Browser,
    request: APIRequestContext,
    actorName: string,
    username: string,
    password: string,
): Promise<Actor> => {
    const context = await browser.newContext();
    const page = await context.newPage();

    return Actor.named(actorName)
        .with('username', username)
        .with('password', password)
        .can(BrowseTheWeb.using(page))
        .can(UseAPI.using(request));
${awsAbility}};

// Define actor fixture type
type Actors = {
    Bob: Actor;
};

// Export the test fixture with the Bob actor
export const test = base.extend<Actors>({
    Bob: async ({ browser, request }, use) => {
        const Bob = await createUser(
            browser, request,
            'Bob',
            process.env.BOB_USER_NAME ?? 'bob',
            process.env.BOB_USER_PASSWORD ?? 'password',
        );
        await use(Bob);
    },
});

// Export the expect function from the Playwright test library
export { expect } from '@playwright/test';
`);

            // screen files generated by agent via screenplay tools


            // task files generated by agent via screenplay tools


            // ─────────────────────────────────────────────────
            // src/screenplay/questions/page-title.ts
            // CORRECT Question pattern: extends Question<T>, answeredBy(actor)
            // ─────────────────────────────────────────────────
            await Deno.writeTextFile(
                `${projectDir}/src/screenplay/questions/page-title.ts`,
`import { Actor, Question } from '@testla/screenplay-playwright';
import { BrowseTheWeb } from '@testla/screenplay-playwright/web';

export class PageTitle extends Question<string> {
    public async answeredBy(actor: Actor): Promise<string> {
        const page = BrowseTheWeb.as(actor).getPage();
        return page.title();
    }

    public static current(): PageTitle {
        return new PageTitle();
    }
}
`);

            // spec files generated by agent via screenplay tools


            // ── README ─────────────────────────────────────────
            await Deno.writeTextFile(`${projectDir}/README.md`,
`# ${projectName}

testla-screenplay-playwright project — Browsers: ${browsers.join(', ')}${useAws ? ' · AWS: enabled' : ''}

## Setup

\`\`\`bash
${pm} install
npx playwright install
\`\`\`

## Run

\`\`\`bash
${pm} test
${pm} run test:headed
\`\`\`

## Structure

\`\`\`
${testsFolder}/
  <feature>.spec.ts          ← Test specs (import from '../src/screenplay/fixtures/actors')
src/screenplay/
  fixtures/actors.ts         ← Actor fixture: Bob, Alice, Andy${useAws ? ' + UseAWS' : ''}
  screens/                   ← Locators: static CSS or LazySelector
  tasks/                     ← Task classes: extends Task, performAs(actor: Actor)
  questions/                 ← Question classes: extends Question<T>, answeredBy(actor: Actor)
  actions/                   ← Custom low-level action classes
\`\`\`
`);

            // ── Install ────────────────────────────────────────
            if (installDeps) {
                const installCmd = pm === 'yarn' ? 'yarn' : `${pm} install`;
                const proc = new Deno.Command('bash', {
                    args: ['-c', `${installCmd} && npx playwright install --with-deps`],
                    cwd: projectDir,
                    stdout: 'piped',
                    stderr: 'piped',
                });
                const { code, stdout, stderr } = await proc.output();
                const out = new TextDecoder().decode(stdout).trim();
                const err = new TextDecoder().decode(stderr).trim();
                if (code !== 0) {
                    return {
                        success: false,
                        output: `Project created but install failed:\n${[out, err].filter(Boolean).join('\n')}`,
                        error: `install exited ${code}`,
                    };
                }
            }

            return {
                success: true,
                output:
                    `✅ Project "${projectName}" created at ${projectDir}\n\n` +
                    `  cd ${projectName}\n` +
                    `  ${pm} test\n\n` +
                    `Key files:\n` +
                    `  src/screenplay/fixtures/actors.ts     ← Actor fixture (Bob, Alice, Andy)\n` +
                    `  ${testsFolder}/<feature>.spec.ts         ← Add your specs here\n` +
                    `  src/screenplay/screens/                ← Add feature Screens here\n` +
                    `  src/screenplay/tasks/                  ← Add Tasks\n` +
                    `  src/screenplay/questions/              ← Add Questions\n` +
                    `  playwright.config.ts                   ← ${browsers.join(', ')}`,
            };
        } catch (e) {
            return { success: false, output: '', error: String(e) };
        }
    },
};

const installDependenciesTool: AgentTool = {
    name: 'testla_install_deps',
    description: 'Install npm dependencies and Playwright browsers for a testla project',
    parameters: {
        type: 'object',
        properties: {
            projectDir: { type: 'string', description: 'Path to the project directory' },
            packageManager: { type: 'string', enum: ['npm', 'pnpm', 'yarn'] },
        },
        required: ['projectDir'],
    },
    async execute(input) {
        const cwd = input.projectDir as string;
        const pm = (input.packageManager as string | undefined) ?? 'npm';
        const installCmd = pm === 'yarn' ? 'yarn' : `${pm} install`;

        const proc = new Deno.Command('bash', {
            args: ['-c', `${installCmd} && npx playwright install --with-deps`],
            cwd,
            stdout: 'piped',
            stderr: 'piped',
        });
        const { code, stdout, stderr } = await proc.output();
        const out = new TextDecoder().decode(stdout).trim();
        const err = new TextDecoder().decode(stderr).trim();

        return {
            success: code === 0,
            output: [out, err].filter(Boolean).join('\n'),
            error: code !== 0 ? `Exit code: ${code}` : undefined,
        };
    },
};

export const testlaCreateSkill: Skill = {
    name: 'testla-create',
    description: 'Scaffold testla-screenplay-playwright projects with correct API patterns',
    version: '1.0.0',
    author: 'testla',
    tools: [scaffoldProjectTool, installDependenciesTool],
    systemPromptAddition: `
## testla-create Skill

Use testla_create_project to scaffold. After scaffolding, use screenplay generators for feature files.
The scaffold creates a working actors.ts fixture and example.spec.ts.
`,
};

export default testlaCreateSkill;