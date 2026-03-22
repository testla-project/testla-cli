// ─────────────────────────────────────────────────────────────
// skills/testla-screenplay/index.ts
// Full testla-screenplay-playwright skill
//
// Based on: @testla/screenplay-playwright
// Docs: https://github.com/testla-project/testla-screenplay-playwright-js
//
// Pattern:
//   Screen  → Selectors / locators for a page
//   Task    → Actor interaction (what they DO)
//   Question → UI state retrieval (what they OBSERVE)
//   Ability → What an Actor CAN do (Browse the web, CallAPI)
//   Actor   → Orchestrates Tasks and Questions
// ─────────────────────────────────────────────────────────────

import type { Skill } from '../../src/skills/types.ts';
import type { AgentTool, ToolResult } from '../../src/agent/types.ts';

// ─── Helpers ─────────────────────────────────────────────────

function kebab(str: string): string {
    return str.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
}

async function writeOut(filePath: string, content: string): Promise<ToolResult> {
    try {
        const dir = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '.';
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(filePath, content);
        return { success: true, output: `✅ Written: ${filePath}\n\n${content}` };
    } catch (e) {
        return { success: false, output: '', error: String(e) };
    }
}

// ─────────────────────────────────────────────────────────────
// TOOL: Generate Screen
// ─────────────────────────────────────────────────────────────

const generateScreen: AgentTool = {
    name: 'screenplay_screen',
    description: 'Generate a Screen (Page Object) for testla-screenplay-playwright. ' +
        'Screens hold all locators/selectors for one page or component. ' +
        'Uses Playwright locator strategies: getByRole, getByLabel, getByTestId, locator().',
    parameters: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'Class name, e.g. "LoginScreen", "DashboardScreen"',
            },
            url: { type: 'string', description: 'Page route, e.g. "/login"' },
            elements: {
                type: 'array',
                description: 'UI elements on this screen',
                items: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'Element property name, e.g. "usernameInput"',
                        },
                        locator: {
                            type: 'string',
                            description:
                                'Playwright locator expression as string, e.g. "getByLabel(\'Username\')" or "locator(\'[data-testid=username]\')"',
                        },
                        description: {
                            type: 'string',
                            description: 'Optional description comment',
                        },
                    },
                    required: ['name', 'locator'],
                },
            },
            outputDir: {
                type: 'string',
                description: 'Output dir, default: src/screenplay/screens',
            },
        },
        required: ['name', 'elements'],
    },
    execute(input) {
        const name = input.name as string;
        const url = (input.url as string | undefined) ?? '/';
        const elements = input.elements as Array<{
            name: string;
            locator: string;
            description?: string;
        }>;
        const outputDir = (input.outputDir as string | undefined) ?? 'src/screenplay/screens';
        const filePath = `${outputDir}/${kebab(name)}.ts`;

        const elementLines = elements
            .map((el) => {
                const comment = el.description ? `  /** ${el.description} */\n` : '';
                return `${comment}  static ${el.name} = (page: Page) => page.${el.locator};`;
            })
            .join('\n\n');

        const content = `import { Page } from '@playwright/test';

/**
 * Screen: ${name}
 * Route:  ${url}
 */
export class ${name} {
  static readonly URL = '${url}';

${elementLines}

  static async goto(page: Page): Promise<void> {
    await page.goto(this.URL);
  }
}
`;
        return writeOut(filePath, content);
    },
};

// ─────────────────────────────────────────────────────────────
// TOOL: Generate Task
// ─────────────────────────────────────────────────────────────

const generateTask: AgentTool = {
    name: 'screenplay_task',
    description: 'Generate a Task class for testla-screenplay-playwright. ' +
        'Tasks represent what an Actor DOES on the UI. ' +
        "They use Screens for selectors and the Actor's Browse ability. " +
        'Example usage: await actor.attemptsTo(Login.with({ username, password }))',
    parameters: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'Task class name, e.g. "Login", "FillSearchForm", "SubmitOrder"',
            },
            screen: {
                type: 'string',
                description: 'Screen class this task operates on, e.g. "LoginScreen"',
            },
            description: { type: 'string', description: 'Human-readable task description' },
            params: {
                type: 'array',
                description: 'Parameters the task accepts',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        type: { type: 'string' },
                        description: { type: 'string' },
                    },
                    required: ['name', 'type'],
                },
            },
            steps: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Action expressions to pass into actor.attemptsTo(), e.g. `Navigate.to(url)`, `Click.on(Screen.BUTTON)`, `Wait.forLoadState(\"networkidle\")`',
            },
            outputDir: {
                type: 'string',
                description: 'Output dir, default: src/screenplay/tasks',
            },
        },
        required: ['name', 'screen'],
    },
    execute(input) {
        const name = input.name as string;
        const screen = input.screen as string;
        const description = (input.description as string | undefined) ?? name;
        const params = (input.params as
            | Array<{
                name: string;
                type: string;
                description?: string;
            }>
            | undefined) ?? [];
        const steps = (input.steps as string[] | undefined) ??
            ['// TODO: implement task steps using ' + screen];
        const outputDir = (input.outputDir as string | undefined) ?? 'src/screenplay/tasks';
        const filePath = `${outputDir}/${kebab(name)}.ts`;

        // Build param interface if multiple params
        const hasParams = params.length > 0;
        const paramsTypeName = `${name}Params`;
        const paramsInterface = hasParams
            ? `export interface ${paramsTypeName} {\n${
                params
                    .map((p) => `  /** ${p.description ?? p.name} */\n  ${p.name}: ${p.type};`)
                    .join('\n')
            }\n}\n\n`
            : '';

        const constructorParam = hasParams ? `private readonly params: ${paramsTypeName}` : '';

        const factoryParam = hasParams ? `params: ${paramsTypeName}` : '';
        const factoryNew = hasParams ? `new ${name}(params)` : `new ${name}()`;

        // Each step is an Action expression (no `await`), passed to `actor.attemptsTo(...)`.
        const stepLines = steps.map((s) => `      ${s},`).join('\n');

        const content = `import { Actor, Task } from '@testla/screenplay-playwright';
import { Navigate, Click, Fill, Wait, Type, Select, Press } from '@testla/screenplay-playwright/web';
import { ${screen} } from '../screens/${kebab(screen)}';

${paramsInterface}/**
 * Task: ${description}
 *
 * Usage:
 *   await actor.attemptsTo(${name}.${hasParams ? `with({ ... })` : 'perform()'});
 */
export class ${name} extends Task {
  constructor(${constructorParam}) {
    super();
  }

  static ${hasParams ? `with(${factoryParam})` : 'perform()'}: ${name} {
    return ${factoryNew};
  }

  public async performAs(actor: Actor): Promise<any> {
    return actor.attemptsTo(
${stepLines}
    );
  }
}
`;
        return writeOut(filePath, content);
    },
};

// ─────────────────────────────────────────────────────────────
// TOOL: Generate Question
// ─────────────────────────────────────────────────────────────

const generateQuestion: AgentTool = {
    name: 'screenplay_question',
    description: 'Generate a Question class for testla-screenplay-playwright. ' +
        'Questions retrieve observable UI state for assertions. ' +
        'Example: const title = await PageTitle.of(page); expect(title).toBe("Dashboard")',
    parameters: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'Question class name, e.g. "PageTitle", "IsLoggedIn", "CartItemCount"',
            },
            screen: { type: 'string', description: 'Screen class to query' },
            returnType: {
                type: 'string',
                description: 'Return type, e.g. "string", "boolean", "number", "string[]"',
            },
            description: { type: 'string', description: 'What this question answers' },
            implementation: {
                type: 'string',
                description:
                    'The actual implementation line, e.g. "return await HomeScreen.title(page).innerText()"',
            },
            outputDir: {
                type: 'string',
                description: 'Output dir, default: src/screenplay/questions',
            },
        },
        required: ['name', 'screen', 'returnType'],
    },
    execute(input) {
        const name = input.name as string;
        const screen = input.screen as string;
        const returnType = input.returnType as string;
        const description = (input.description as string | undefined) ?? `Answers: ${name}`;
        const impl = (input.implementation as string | undefined) ??
            `// TODO: implement using ${screen}\n    throw new Error('Not implemented: ${name}')`;
        const outputDir = (input.outputDir as string | undefined) ?? 'src/screenplay/questions';
        const filePath = `${outputDir}/${kebab(name)}.ts`;

        const content = `import { Actor, Question } from '@testla/screenplay-playwright';
import { ${screen} } from '../screens/${kebab(screen)}';

/**
 * Question: ${description}
 *
 * Usage:
 *   await actor.asks(${name}.of);
 */
export class ${name} extends Question<${returnType}> {
  public constructor() {
    super();
  }

  public async answeredBy(actor: Actor): Promise<${returnType}> {
    ${impl};
  }

  public static get of(): ${name} {
    return new ${name}();
  }
}
`;
        return writeOut(filePath, content);
    },
};

// ─────────────────────────────────────────────────────────────
// TOOL: Generate Actor setup
// ─────────────────────────────────────────────────────────────

const generateActorSetup: AgentTool = {
    name: 'screenplay_actor_setup',
    description: 'Generate the Actor + Abilities setup file for testla-screenplay-playwright. ' +
        "Creates the actor fixture that wraps Playwright's page with screenplay capabilities.",
    parameters: {
        type: 'object',
        properties: {
            abilities: {
                type: 'array',
                items: {
                    type: 'string',
                    enum: ['BrowseTheWeb', 'UseAPI'],
                },
                description: 'Abilities to give the actor',
            },
            outputDir: {
                type: 'string',
                description: 'Output dir, default: src/screenplay',
            },
            withFixture: {
                type: 'boolean',
                description: 'Also generate a Playwright test fixture (default: true)',
            },
        },
        required: [],
    },
    async execute(input) {
        const abilities = (input.abilities as string[] | undefined) ?? ['BrowseTheWeb'];
        const outputDir = (input.outputDir as string | undefined) ?? 'src/screenplay';
        const withFixture = (input.withFixture as boolean | undefined) ?? true;

        const abilityImports = abilities
            .map((a) => {
                if (a === 'BrowseTheWeb') return `import { BrowseTheWeb } from '@testla/screenplay-playwright/web';`;
                if (a === 'UseAPI') return `import { UseAPI } from '@testla/screenplay-playwright/api';`;
                return `import { ${a} } from '@testla/screenplay-playwright';`;
            })
            .join('\n');

        const abilitySetup = abilities
            .map((a) => {
                if (a === 'BrowseTheWeb') return '    BrowseTheWeb.using(page),';
                if (a === 'UseAPI') return '    UseAPI.using(request),';
                return `    // ${a} — configure manually`;
            })
            .join('\n');

        const actorContent = `import { Actor } from '@testla/screenplay-playwright';
${abilityImports}
import type { Page${
            abilities.includes('UseAPI') ? ', APIRequestContext' : ''
        } } from '@playwright/test';

/**
 * Create a configured testla Actor with all required abilities.
 *
 * Usage in tests:
 *   const actor = createActor(page);
 *   await actor.attemptsTo(Login.with({ username: 'user', password: 'pass' }));
 *   const title = await actor.asks(PageTitle.of(page));
 */
export function createActor(
  page: Page${abilities.includes('UseAPI') ? ',\n  request: APIRequestContext' : ''}
): Actor {
  return Actor.named('Testla User').can(
${abilitySetup}
  );
}
`;

        await writeOut(`${outputDir}/actor.ts`, actorContent);

        if (!withFixture) {
            return {
                success: true,
                output: `✅ Written: ${outputDir}/actor.ts\n\n${actorContent}`,
            };
        }

        const fixtureContent = `import { test as base, expect } from '@playwright/test';
import { createActor } from '../src/screenplay/actor';
import type { Actor } from '@testla/screenplay-playwright';

// Extend Playwright test with the screenplay Actor fixture
export const test = base.extend<{ actor: Actor }>({
  actor: async ({ page, request }, use) => {
    const actor = createActor(page${abilities.includes('UseAPI') ? ', request' : ''});
    await use(actor);
  },
});

export { expect };
`;

        await writeOut('tests/fixtures.ts', fixtureContent);

        return {
            success: true,
            output:
                `✅ Written:\n  ${outputDir}/actor.ts\n  tests/fixtures.ts\n\n--- actor.ts ---\n${actorContent}\n--- fixtures.ts ---\n${fixtureContent}`,
        };
    },
};

// ─────────────────────────────────────────────────────────────
// TOOL: Generate full feature (Screen + Task + Question + Spec)
// ─────────────────────────────────────────────────────────────

const generateFeature: AgentTool = {
    name: 'screenplay_feature',
    description:
        'Generate a complete testla-screenplay feature: Screen + Tasks + Questions + Spec in one shot. ' +
        'Use this when you want to scaffold everything for a UI feature at once.',
    parameters: {
        type: 'object',
        properties: {
            feature: {
                type: 'string',
                description: 'Feature name, e.g. "login", "checkout", "user-profile"',
            },
            url: { type: 'string', description: 'Page URL, e.g. "/login"' },
            description: { type: 'string', description: 'What this feature does' },
            elements: {
                type: 'array',
                description: 'UI elements on the page',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        locator: { type: 'string' },
                        type: {
                            type: 'string',
                            enum: ['input', 'button', 'text', 'link', 'form', 'other'],
                        },
                    },
                    required: ['name', 'locator'],
                },
            },
            tasks: {
                type: 'array',
                description: 'Tasks (user actions) for this feature',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        description: { type: 'string' },
                        params: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: { name: { type: 'string' }, type: { type: 'string' } },
                            },
                        },
                    },
                    required: ['name'],
                },
            },
            questions: {
                type: 'array',
                description: 'Questions (assertions) for this feature',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        returnType: { type: 'string' },
                        description: { type: 'string' },
                    },
                    required: ['name', 'returnType'],
                },
            },
            testCases: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        steps: { type: 'array', items: { type: 'string' } },
                    },
                },
                description: 'Test cases for the spec file',
            },
        },
        required: ['feature', 'url', 'elements'],
    },
    async execute(input) {
        const feature = input.feature as string;
        const url = input.url as string;
        const description = (input.description as string | undefined) ?? feature;
        const elements = input.elements as Array<{ name: string; locator: string; type?: string }>;
        const tasks = (input.tasks as
            | Array<{
                name: string;
                description?: string;
                params?: Array<{ name: string; type: string }>;
            }>
            | undefined) ?? [];
        const questions = (input.questions as
            | Array<{
                name: string;
                returnType: string;
                description?: string;
            }>
            | undefined) ?? [];
        const testCases =
            (input.testCases as Array<{ name: string; steps: string[] }> | undefined) ??
                [{ name: `should handle ${feature}`, steps: ['// TODO: implement test'] }];

        const screenName = `${
            feature.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('')
        }Screen`;
        const outputs: string[] = [];

        // ── Screen ──────────────────────────────────────────────
        const elementLines = elements
            .map((el) => `  static ${el.name} = (page: Page) => page.${el.locator};`)
            .join('\n\n');

        const screenContent = `import { Page } from '@playwright/test';

export class ${screenName} {
  static readonly URL = '${url}';

${elementLines}

  static async goto(page: Page): Promise<void> {
    await page.goto(this.URL);
  }
}
`;
        await Deno.mkdir('src/screenplay/screens', { recursive: true });
        await Deno.writeTextFile(`src/screenplay/screens/${kebab(screenName)}.ts`, screenContent);
        outputs.push(`src/screenplay/screens/${kebab(screenName)}.ts`);

        // ── Tasks ────────────────────────────────────────────────
        for (const task of tasks) {
            const hasParams = task.params && task.params.length > 0;
            const paramsTypeName = `${task.name}Params`;
            const paramsInterface = hasParams
                ? `export interface ${paramsTypeName} {\n${
                    task.params!
                        .map((p) => `  ${p.name}: ${p.type};`)
                        .join('\n')
                }\n}\n\n`
                : '';

            const taskContent = `import { Page } from '@playwright/test';
import { ${screenName} } from '../screens/${kebab(screenName)}';

${paramsInterface}export class ${task.name} {
  constructor(${hasParams ? `private readonly params: ${paramsTypeName}` : ''}) {}

  static ${hasParams ? `with(params: ${paramsTypeName})` : 'perform()'}: ${task.name} {
    return new ${task.name}(${hasParams ? 'params' : ''});
  }

  async performAs(page: Page): Promise<void> {
    // TODO: implement ${task.description ?? task.name} using ${screenName}
  }
}
`;
            await Deno.mkdir('src/screenplay/tasks', { recursive: true });
            await Deno.writeTextFile(`src/screenplay/tasks/${kebab(task.name)}.ts`, taskContent);
            outputs.push(`src/screenplay/tasks/${kebab(task.name)}.ts`);
        }

        // ── Questions ────────────────────────────────────────────
        for (const question of questions) {
            const questionContent = `import { Page } from '@playwright/test';
import { ${screenName} } from '../screens/${kebab(screenName)}';

/** Question: ${question.description ?? question.name} */
export class ${question.name} {
  static async of(page: Page): Promise<${question.returnType}> {
    // TODO: implement using ${screenName}
    throw new Error('Not implemented: ${question.name}');
  }
}
`;
            await Deno.mkdir('src/screenplay/questions', { recursive: true });
            await Deno.writeTextFile(
                `src/screenplay/questions/${kebab(question.name)}.ts`,
                questionContent,
            );
            outputs.push(`src/screenplay/questions/${kebab(question.name)}.ts`);
        }

        // ── Spec ────────────────────────────────────────────────
        const taskImports = tasks
            .map((t) => `import { ${t.name} } from '../src/screenplay/tasks/${kebab(t.name)}';`)
            .join('\n');
        const questionImports = questions
            .map(
                (q) => `import { ${q.name} } from '../src/screenplay/questions/${kebab(q.name)}';`,
            )
            .join('\n');

        const testBlocks = testCases
            .map(
                (tc) =>
                    `  test('${tc.name}', async ({ page }) => {\n${
                        tc.steps
                            .map((s) => `    ${s}`)
                            .join('\n')
                    }\n  });`,
            )
            .join('\n\n');

        const specContent = `import { test, expect } from '@playwright/test';
${taskImports}
${questionImports}
import { ${screenName} } from '../src/screenplay/screens/${kebab(screenName)}';

test.describe('${description}', () => {

${testBlocks}

});
`;
        await Deno.mkdir('tests', { recursive: true });
        await Deno.writeTextFile(`tests/${kebab(feature)}.spec.ts`, specContent);
        outputs.push(`tests/${kebab(feature)}.spec.ts`);

        return {
            success: true,
            output: `✅ Feature "${feature}" scaffolded:\n${
                outputs.map((f) => '  • ' + f).join('\n')
            }`,
        };
    },
};

// ─────────────────────────────────────────────────────────────
// TOOL: Validate screenplay structure
// ─────────────────────────────────────────────────────────────

const validateStructure: AgentTool = {
    name: 'screenplay_validate',
    description:
        'Validate that a project follows the testla-screenplay-playwright structure correctly. ' +
        'Checks for missing screens/tasks/questions, incorrect imports, and pattern violations.',
    parameters: {
        type: 'object',
        properties: {
            projectDir: {
                type: 'string',
                description: 'Root of the project to validate (default: current dir)',
            },
        },
        required: [],
    },
    async execute(input) {
        const root = (input.projectDir as string | undefined) ?? '.';
        const issues: string[] = [];
        const ok: string[] = [];

        const check = async (path: string, label: string) => {
            try {
                await Deno.stat(`${root}/${path}`);
                ok.push(`✅ ${label}`);
            } catch {
                issues.push(`❌ Missing: ${path} — ${label}`);
            }
        };

        // Structural checks
        await check('src/screenplay/screens', 'screens directory');
        await check('src/screenplay/tasks', 'tasks directory');
        await check('src/screenplay/questions', 'questions directory');
        await check('tests', 'tests directory');
        await check('playwright.config.ts', 'Playwright config');
        await check('package.json', 'package.json');

        // Check @testla/screenplay-playwright is in deps
        try {
            const pkg = JSON.parse(await Deno.readTextFile(`${root}/package.json`));
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            if (deps['@testla/screenplay-playwright']) {
                ok.push('✅ @testla/screenplay-playwright installed');
            } else {
                issues.push(
                    '❌ @testla/screenplay-playwright not in dependencies — run: npm install @testla/screenplay-playwright',
                );
            }
            if (deps['@playwright/test']) {
                ok.push('✅ @playwright/test installed');
            } else {
                issues.push('❌ @playwright/test not in dependencies');
            }
        } catch {
            issues.push('⚠️  Could not read package.json');
        }

        // Check each spec imports from screenplay
        try {
            for await (const entry of Deno.readDir(`${root}/tests`)) {
                if (!entry.name.endsWith('.spec.ts')) continue;
                const content = await Deno.readTextFile(`${root}/tests/${entry.name}`);
                if (!content.includes('screenplay')) {
                    issues.push(
                        `⚠️  tests/${entry.name} — no screenplay imports found (Tasks/Questions/Screens)`,
                    );
                }
            }
        } catch { /* no tests dir */ }

        const report = [
            `📋 testla-screenplay Structure Validation`,
            `   Project: ${root}`,
            '',
            ...ok,
            ...(issues.length > 0
                ? ['', '── Issues ──────────────────────────────', ...issues]
                : []),
            '',
            issues.length === 0
                ? '🎉 All checks passed!'
                : `Found ${issues.length} issue(s) to fix.`,
        ].join('\n');

        return { success: issues.length === 0, output: report };
    },
};

// ─────────────────────────────────────────────────────────────
// Export Skill
// ─────────────────────────────────────────────────────────────

const testlaScreenplaySkill: Skill = {
    name: 'testla-screenplay',
    description:
        'Full testla-screenplay-playwright skill — generate Screens, Tasks, Questions, Actors, Fixtures, and validate structure',
    version: '1.0.0',
    author: 'testla',
    tools: [
        generateScreen,
        generateTask,
        generateQuestion,
        generateActorSetup,
        generateFeature,
        validateStructure,
    ],
    systemPromptAddition: `
## testla-screenplay-playwright Pattern

Core concepts:
- **Screen**   → holds Playwright locators for one page/component (src/screenplay/screens/)
- **Task**     → actor interaction, what they DO (src/screenplay/tasks/)
- **Question** → reads observable UI state for assertions (src/screenplay/questions/)
- **Actor**    → orchestrates Tasks and Questions via abilities
- **Ability**  → BrowseTheWeb(page), UseAPI(request)

Correct usage in specs:
\`\`\`ts
// Using tasks
await Login.with({ username, password }).performAs(page);

// Using questions  
const title = await PageTitle.of(page);
expect(title).toBe('Dashboard');

// Using actor (if fixture configured)
await actor.attemptsTo(Login.with({ username, password }));
const result = await actor.asks(PageTitle.of(page));
\`\`\`

Tool order when building a new feature:
1. screenplay_feature  → scaffolds everything in one shot
   OR step-by-step:
   1a. screenplay_screen     → locators
   1b. screenplay_task       → interactions
   1c. screenplay_question   → assertions
2. screenplay_actor_setup → Actor + fixture (once per project)
3. testla_lens_analyze    → quality check
4. testla_run_tests       → execute and verify
5. screenplay_validate    → structure check
`,
};

export default testlaScreenplaySkill;
