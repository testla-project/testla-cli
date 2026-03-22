// ─────────────────────────────────────────────────────────────
// testla-cli · src/skills/builtin/playwright-screenplay.ts
//
// Generates testla-screenplay-playwright code using the CORRECT API:
//
//   SCREEN:
//     export class FooScreen {
//       static SOME_CSS = '#selector';
//       static SOME_LAZY: LazySelector = (page: Page) => page.getByRole(...)
//     }
//
//   TASK:
//     export class DoSomething extends Task {
//       private constructor(...) { super(); }
//       public async performAs(actor: Actor): Promise<void> {
//         await Bob.attemptsTo(Click.on(...), Fill.in(...), ...);
//       }
//       public static now(): DoSomething { return new DoSomething(); }
//     }
//
//   QUESTION:
//     export class SomeQuestion extends Question<boolean> {
//       public async answeredBy(actor: Actor): Promise<boolean> { ... }
//       public static current(): SomeQuestion { return new SomeQuestion(); }
//     }
//
//   TEST:
//     test('...', async ({ Bob }) => {
//       await Bob.attemptsTo(DoSomething.now());
//       await Bob.asks(Element.toBe.visible(FooScreen.ELEMENT));
//     });
//
// ─────────────────────────────────────────────────────────────

import type { Skill } from '../types.ts';
import type { AgentTool } from '../../agent/types.ts';

// ─── Helpers ─────────────────────────────────────────────────

function kebab(str: string): string {
    return str.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
}

// Write a file relative to baseDir (defaults to Deno.cwd())
// If baseDir looks like a placeholder invented by the LLM, ignore it and use cwd.
async function write(path: string, content: string, baseDir?: string): Promise<void> {
    // Detect and discard placeholder paths the LLM invents
    const isPlaceholder = baseDir && (
        baseDir.includes('/path/to') ||
        baseDir === '/path/to/project' ||
        baseDir.includes('<') ||
        !baseDir.startsWith('/')
    );
    const resolvedBase = (!baseDir || isPlaceholder) ? undefined : baseDir;
    const fullPath = resolvedBase ? `${resolvedBase}/${path}` : path;
    const dir = fullPath.includes('/') ? fullPath.substring(0, fullPath.lastIndexOf('/')) : '.';
    if (dir !== '.') await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(fullPath, content);
}

// ─────────────────────────────────────────────────────────────
// TOOL: screenplay_screen
// ─────────────────────────────────────────────────────────────

const generateScreen: AgentTool = {
    name: 'screenplay_screen',
    description:
        'Generate a Screen class for testla-screenplay-playwright. ' +
        'Screens hold locators for a page: static CSS strings or LazySelector functions. ' +
        'Example: static BUTTON: LazySelector = (page: Page) => page.getByRole("button", { name: "Submit" })',
    parameters: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Class name, e.g. "LoginScreen"' },
            elements: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Property name, e.g. "USERNAME_INPUT"' },
                        selector: {
                            type: 'string',
                            description:
                                'Either a CSS string like "#username" ' +
                                'or a Playwright expression like "page.getByRole(\'button\', { name: \'Login\' })"',
                        },
                        isLazy: {
                            type: 'boolean',
                            description:
                                'True if selector uses page.getBy...() (LazySelector). ' +
                                'False if it is a plain CSS/attribute string.',
                        },
                    },
                    required: ['name', 'selector'],
                },
            },
            outputDir: { type: 'string', description: 'Output dir (default: src/screenplay/screens)' },
        },
        required: ['name', 'elements'],
    },
    async execute(input) {
        const name = input.name as string | undefined;
        if (!name || typeof name !== 'string') {
            return { success: false, output: '', error: 'screenplay_screen requires "name" (Screen class name, e.g. "LoginScreen").' };
        }
        const elements = input.elements as Array<{ name: string; selector: string; isLazy?: boolean }>;
        const outputDir = (input.outputDir as string | undefined) ?? 'src/screenplay/screens';
        const baseDir = (input.projectDir as string | undefined) ?? undefined;
        const filePath = `${outputDir}/${kebab(name)}.ts`;

        const hasLazy = elements.some((e) => e.isLazy);

        const imports = [
            hasLazy ? `import type { LazySelector } from '@testla/screenplay-playwright';` : '',
            hasLazy ? `import type { Page } from '@playwright/test';` : '',
        ].filter(Boolean).join('\n');

        const props = elements.map((el) => {
            if (el.isLazy) {
                return `    static ${el.name}: LazySelector = (page: Page) => ${el.selector};`;
            }
            return `    static ${el.name} = '${el.selector}';`;
        }).join('\n');

        const content =
`${imports}${imports ? '\n\n' : ''}export class ${name} {
${props}
}
`;
        await write(filePath, content, baseDir);
        return { success: true, output: `✅ Screen written: ${filePath}\n\n${content}` };
    },
};

// ─────────────────────────────────────────────────────────────
// TOOL: screenplay_task
// ─────────────────────────────────────────────────────────────

const generateTask: AgentTool = {
    name: 'screenplay_task',
    description:
        'Generate a Task class for testla-screenplay-playwright. ' +
        'Tasks extend Task, implement performAs(actor: Actor), and call actor.attemptsTo(...actions). ' +
        'Available web actions: Navigate.to(url), Click.on(selector), Fill.in(selector, value), ' +
        'Wait.forLoadState("networkidle"), Check.element(selector). ' +
        'Import actions from @testla/screenplay-playwright/web',
    parameters: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Task class name, e.g. "Login", "PickCombo"' },
            screenImport: { type: 'string', description: 'Screen class to use, e.g. "LoginScreen"' },
            description: { type: 'string', description: 'What this task does' },
            params: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        type: { type: 'string' },
                    },
                },
                description: 'Constructor parameters',
            },
            actions: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Lines inside performAs. Use actor.attemptsTo(). ' +
                    'Examples: "Navigate.to(this.url)", "Click.on(LoginScreen.SUBMIT)", ' +
                    '"Fill.in(LoginScreen.EMAIL_INPUT, this.email)", "Wait.forLoadState(\'networkidle\')"',
            },
            factoryMethod: {
                type: 'string',
                description: 'Name of the static factory method, e.g. "toApp", "now", "with"',
            },
            webActions: {
                type: 'array',
                items: { type: 'string' },
                description: 'Web action imports needed, e.g. ["Navigate", "Click", "Fill", "Wait"]',
            },
            outputDir: { type: 'string', description: 'Output dir (default: src/screenplay/tasks)' },
        },
        required: ['name'],
    },
    async execute(input) {
        const name = input.name as string | undefined;
        if (!name || typeof name !== 'string') {
            return { success: false, output: '', error: 'screenplay_task requires "name" (Task class name, e.g. "PickCombo").' };
        }
        const screenImport = input.screenImport as string | undefined;
        const description = (input.description as string | undefined) ?? name;
        const params = (input.params as Array<{ name: string; type: string }> | undefined) ?? [];
        const actions = (input.actions as string[] | undefined) ?? [
            `// TODO: add actions here`,
            `// Example: Navigate.to('https://example.com'),`,
            `// Example: Click.on(${screenImport ?? 'MyScreen'}.SOME_BUTTON),`,
        ];
        const factoryMethod = (input.factoryMethod as string | undefined) ?? 'toApp';
        const webActions = (input.webActions as string[] | undefined) ?? [];
        const outputDir = (input.outputDir as string | undefined) ?? 'src/screenplay/tasks';
        const baseDir = (input.projectDir as string | undefined) ?? undefined;
        const filePath = `${outputDir}/${kebab(name)}.ts`;

        const hasParams = params.length > 0;
        const constructorArgs = params.map((p) => `private readonly ${p.name}: ${p.type}`).join(', ');
        const factoryArgs = params.map((p) => `${p.name}: ${p.type}`).join(', ');
        const newArgs = params.map((p) => p.name).join(', ');

        const webImports = webActions.length > 0
            ? `import { ${webActions.join(', ')} } from '@testla/screenplay-playwright/web';`
            : `import { Navigate, Click, Fill, Wait, Element } from '@testla/screenplay-playwright/web';`;

        const screenLine = screenImport
            ? `import { ${screenImport} } from '../screens/${kebab(screenImport)}';`
            : '';

        const actionLines = actions
            .map((a) => a.trimEnd().replace(/,+$/, ''))
            .map((a) => `            ${a},`)
            .join('\n');

        const content =
`import { Actor, Task } from '@testla/screenplay-playwright';
${webImports}${screenLine ? '\n' + screenLine : ''}

/**
 * Task: ${description}
 *
 * Usage:
 *   await Bob.attemptsTo(${name}.${factoryMethod}(${params.map(() => '...').join(', ')}));
 */
export class ${name} extends Task {
    private constructor(${constructorArgs}) {
        super();
    }

    public async performAs(actor: Actor): Promise<any> {
        return actor.attemptsTo(
${actionLines}
        );
    }

    public static ${factoryMethod}(${factoryArgs}): ${name} {
        return new ${name}(${newArgs});
    }
}
`;
        await write(filePath, content, baseDir);
        return { success: true, output: `✅ Task written: ${filePath}\n\n${content}` };
    },
};

// ─────────────────────────────────────────────────────────────
// TOOL: screenplay_question
// ─────────────────────────────────────────────────────────────

const generateQuestion: AgentTool = {
    name: 'screenplay_question',
    description:
        'Generate a Question class for testla-screenplay-playwright. ' +
        'Questions extend Question<T> and implement answeredBy(actor: Actor). ' +
        'Used for assertions: await Bob.asks(MyQuestion.current()). ' +
        'Can also use Element.toBe.visible() / Element.toHave.text() directly in tests.',
    parameters: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Question class name, e.g. "IsResultVisible"' },
            returnType: { type: 'string', description: 'Return type, e.g. "boolean", "string"' },
            screenImport: { type: 'string', description: 'Screen class to query from' },
            description: { type: 'string', description: 'What this question checks' },
            implementation: {
                type: 'string',
                description:
                    'Body of answeredBy(). Access page via: const page = BrowseTheWeb.as(actor).getPage(). ' +
                    'Example: "const page = BrowseTheWeb.as(actor).getPage(); return page.locator(\'#result\').isVisible();"',
            },
            factoryMethod: { type: 'string', description: 'Static factory method name (default: current)' },
            outputDir: { type: 'string', description: 'Output dir (default: src/screenplay/questions)' },
        },
        required: ['name', 'returnType'],
    },
    async execute(input) {
        const name = (input.name as string | undefined);
        if (!name || typeof name !== 'string') {
            return { success: false, output: '', error: 'screenplay_question requires "name" (Question class name, e.g. "IsResultVisible").' };
        }
        const returnType = (input.returnType as string | undefined) ?? 'boolean';
        const screenImport = input.screenImport as string | undefined;
        const description = (input.description as string | undefined) ?? name;
        const implementation = (input.implementation as string | undefined) ??
            `const page = BrowseTheWeb.as(actor).getPage();\n        // TODO: implement\n        throw new Error('Not implemented: ${name}');`;
        const factoryMethod = (input.factoryMethod as string | undefined) ?? 'current';
        const outputDir = (input.outputDir as string | undefined) ?? 'src/screenplay/questions';
        const baseDir = (input.projectDir as string | undefined) ?? undefined;
        const filePath = `${outputDir}/${kebab(name)}.ts`;

        const screenLine = screenImport
            ? `import { ${screenImport} } from '../screens/${kebab(screenImport)}';`
            : '';

        const implLines = implementation.split('\n').map((l) => `        ${l}`).join('\n');

        const content =
`import { Actor, Question } from '@testla/screenplay-playwright';
import { BrowseTheWeb } from '@testla/screenplay-playwright/web';${screenLine ? '\n' + screenLine : ''}

/**
 * Question: ${description}
 *
 * Usage:
 *   await Bob.asks(${name}.${factoryMethod}());
 */
export class ${name} extends Question<${returnType}> {
    public async answeredBy(actor: Actor): Promise<${returnType}> {
${implLines}
    }

    public static ${factoryMethod}(): ${name} {
        return new ${name}();
    }
}
`;
        await write(filePath, content, baseDir);
        return { success: true, output: `✅ Question written: ${filePath}\n\n${content}` };
    },
};

// ─────────────────────────────────────────────────────────────
// TOOL: screenplay_spec
// ─────────────────────────────────────────────────────────────

const generateSpec: AgentTool = {
    name: 'screenplay_spec',
    description:
        'Generate a Playwright spec file using testla-screenplay. ' +
        'Uses the actor fixture from actors.ts and calls actor.attemptsTo() / actor.asks(). ' +
        'For assertions, use Element.toBe.visible(Screen.SELECTOR) or Element.toHave.text(Screen.SELECTOR, text).',
    parameters: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Spec file name (no extension), e.g. "random-redesign"' },
            describeLabel: { type: 'string', description: 'test.describe label' },
            actorsFile: {
                type: 'string',
                description: 'Path to actors fixture relative to spec, default: "../src/screenplay/fixtures/actors"',
            },
            imports: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Extra import lines, e.g. ' +
                    '["import { PickCombo } from \'../src/screenplay/tasks/pick-combo\';"]',
            },
            tests: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Test name' },
                        body: { type: 'string', description: 'Test body lines joined by \\n' },
                    },
                    required: ['name', 'body'],
                },
            },
            outputDir: { type: 'string', description: 'Output dir (default: tests)' },
        },
        required: ['name', 'describeLabel', 'tests'],
    },
    async execute(input) {
        // Guard: validate required params
        const name = (input.name as string | undefined) ??
            (input.featureName as string | undefined);
        if (!name || typeof name !== 'string') {
            return { success: false, output: '', error: 'screenplay_spec requires "name" (spec file name, e.g. "random-redesign").' };
        }
        const describeLabel = (input.describeLabel as string | undefined) ?? name;
        const actorsFile = (input.actorsFile as string | undefined) ?? '../src/screenplay/fixtures/actors';
        const imports = (input.imports as string[] | undefined) ?? [];
        // Guard: default to a placeholder test if tests array is missing/invalid
        const rawTests = input.tests as Array<{ name: string; body: string }> | undefined;
        const tests = Array.isArray(rawTests) && rawTests.length > 0
            ? rawTests
            : [{ name: `should complete ${name} flow`, body: '// TODO: implement test steps' }];
        const outputDir = (input.outputDir as string | undefined) ?? 'tests';
        const baseDir = (input.projectDir as string | undefined) ?? undefined;
        const filePath = `${outputDir}/${name}.spec.ts`;

        const extraImports = imports.join('\n');
        const testBlocks = tests.map((t) => {
            const bodyLines = t.body.split('\n').map((l) => `        ${l}`).join('\n');
            return `    test('${t.name}', async ({ Bob }) => {\n${bodyLines}\n    });`;
        }).join('\n\n');

        const content =
`import { test, expect } from '${actorsFile}';
import { Navigate, Click, Fill, Element, BrowseTheWeb } from '@testla/screenplay-playwright/web';
${extraImports}

test.describe('${describeLabel}', () => {
${testBlocks}
});
`;
        await write(filePath, content, baseDir);
        return { success: true, output: `✅ Spec written: ${filePath}\n\n${content}` };
    },
};

// ─────────────────────────────────────────────────────────────
// TOOL: screenplay_feature
// One-shot: Screen + Task + Question + Spec for a feature
// ─────────────────────────────────────────────────────────────

const generateFeature: AgentTool = {
    name: 'screenplay_feature',
    description:
        'Generate testla-screenplay files for a feature: Screen (locators) + Task (Navigate+Click) + Spec (3 tests). ' +
        'Required: featureName (kebab-case, e.g. "random-redesign-picker"), url (the page URL), ' +
        'projectDir (absolute path to project root). ' +
        'Call this ONCE — it creates all 3 files automatically.',
    parameters: {
        type: 'object',
        properties: {
            featureName: {
                type: 'string',
                description: 'Kebab-case feature name, e.g. "random-redesign" or "login". Used to derive class names and file names.',
            },
            url: { type: 'string', description: 'Page URL, e.g. "https://example.com/login"' },
            projectDir: {
                type: 'string',
                description: 'Absolute path to the project root where files will be written, e.g. "/Users/me/projects/testla-my-app". Required when the agent is not already inside the project directory.',
            },
            description: { type: 'string', description: 'What the feature does' },
            screenElements: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        propName: { type: 'string', description: 'UPPER_SNAKE_CASE property name, e.g. PICK_BUTTON' },
                        selector: { type: 'string', description: 'CSS string or page.getByRole(...) expression' },
                        isLazy: { type: 'boolean', description: 'True if selector uses page.getBy...' },
                    },
                    required: ['propName', 'selector'],
                },
            },
            taskName: { type: 'string', description: 'Task class name, e.g. "PickCombo"' },
            taskActions: {
                type: 'array',
                items: { type: 'string' },
                description: 'Lines inside actor.attemptsTo(), e.g. ["Navigate.to(\'https://...\'),", "Click.on(RandomRedesignScreen.PICK_BUTTON),"]',
            },
            testCases: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        body: { type: 'string' },
                    },
                },
            },
        },
        required: ['featureName', 'url'],
    },
    async execute(input) {
        const featureName = input.featureName as string | undefined;
        const url = input.url as string | undefined;

        // Guard: LLM sometimes passes wrong params (e.g. projectDir instead of featureName)
        if (!featureName || typeof featureName !== 'string') {
            return {
                success: false,
                output: '',
                error:
                    'screenplay_feature requires "featureName" (a kebab-case string like "random-redesign"). ' +
                    'Do not pass projectDir or packageManager to this tool. ' +
                    'Those belong to testla_create_project.',
            };
        }
        if (!url || typeof url !== 'string') {
            return {
                success: false,
                output: '',
                error: 'screenplay_feature requires "url" (the page URL to test).',
            };
        }
        const description = (input.description as string | undefined) ?? featureName;
        const baseDir = (input.projectDir as string | undefined) ?? undefined;
        const screenName = featureName.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('') + 'Screen';
        const taskName = (input.taskName as string | undefined) ??
            featureName.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('');

        // ── Sanitize and normalize screenElements ─────────────────
        // LLM often passes propName=undefined or selector with unicode quotes.
        // We sanitize inputs and always generate safe defaults.
        const rawElements = (input.screenElements as Array<{
            propName?: string;
            name?: string;
            selector: string;
            isLazy?: boolean;
        }> | undefined) ?? [];

        // Normalize: use propName or name, generate one from selector if missing
        const screenElements = rawElements
            .filter((e) => e && e.selector)
            .map((e, i) => {
                const rawProp = e.propName ?? e.name;
                const propName = (rawProp && rawProp !== 'undefined')
                    ? rawProp.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
                    : `ELEMENT_${i + 1}`;
                // Strip unicode curly quotes the LLM sometimes emits
                const selector = e.selector
                    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
                    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
                    .replace(/\\u[0-9a-fA-F]{4}/g, (m) =>
                        String.fromCharCode(parseInt(m.slice(2), 16)));
                return { propName, selector, isLazy: e.isLazy ?? selector.startsWith('page.') };
            });

        // ── Context-aware defaults based on URL/featureName ─────────
        const urlLower = (url + ' ' + featureName).toLowerCase();
        const isLogin = /login|signin|sign-in|auth/.test(urlLower);
        const isSearch = /search|query/.test(urlLower);

        // Only add smart defaults if no elements were provided at all
        if (screenElements.length === 0) {
            if (isLogin) {
                screenElements.push(
                    { propName: 'USERNAME_FIELD', selector: `page.locator('#username, [name="username"], [type="text"]').first()`, isLazy: true },
                    { propName: 'PASSWORD_FIELD', selector: `page.locator('#password, [name="password"], [type="password"]').first()`, isLazy: true },
                    { propName: 'SUBMIT_BUTTON', selector: `page.locator('button[type="submit"], input[type="submit"], .btn-default').first()`, isLazy: true },
                    { propName: 'SUCCESS_INDICATOR', selector: `page.locator('.flash.success, .flash.notice, h2, [data-test="success"]').first()`, isLazy: true },
                );
            } else {
                screenElements.push(
                    { propName: 'HEADING', selector: isLogin ? 'h2' : 'h1', isLazy: false },
                );
            }
        }
        if (!screenElements.some((e) => e.propName === 'HEADING')) {
            screenElements.push({ propName: 'HEADING', selector: isLogin ? 'h2' : 'h1', isLazy: false });
        }

        // ── Context-aware task actions ────────────────────────────────
        const taskActions = (input.taskActions as string[] | undefined) ?? (() => {
            if (isLogin) return [
                `Navigate.to('${url}'),`,
                `Fill.in(${screenName}.USERNAME_FIELD, process.env.TEST_USERNAME ?? 'tomsmith'),`,
                `Fill.in(${screenName}.PASSWORD_FIELD, process.env.TEST_PASSWORD ?? 'SuperSecretPassword!'),`,
                `Click.on(${screenName}.SUBMIT_BUTTON),`,
            ];
            return [`Navigate.to('${url}'),`];
        })();

        // Use the first non-HEADING element for the visibility assertion
        const assertElement = screenElements.find((e) => e.propName !== 'HEADING')
            ?? screenElements[0];
        const assertRef = assertElement
            ? `${screenName}.${assertElement.propName}`
            : `${screenName}.HEADING`;

        const testCases = (input.testCases as Array<{ name: string; body: string }> | undefined) ?? (() => {
            if (isLogin) return [
                {
                    name: `logs in successfully with valid credentials`,
                    body:
                        `await Bob.attemptsTo(${taskName}.toApp());
` +
                        `await Bob.asks(Element.toBe.visible(${screenName}.SUCCESS_INDICATOR));`,
                },
                {
                    name: `takes a screenshot after successful login`,
                    body:
                        `await Bob.attemptsTo(${taskName}.toApp());
` +
                        `const page = BrowseTheWeb.as(Bob).getPage();
` +
                        `await page.screenshot({ path: 'test-results/${featureName}.png', fullPage: true });`,
                },
            ];
            return [
                {
                    name: `executes the ${featureName} flow and verifies the result`,
                    body:
                        `await Bob.attemptsTo(${taskName}.toApp());
` +
                        `await Bob.asks(Element.toBe.visible(${assertRef}));`,
                },
                {
                    name: `takes a screenshot after completing the ${featureName} flow`,
                    body:
                        `await Bob.attemptsTo(${taskName}.toApp());
` +
                        `const page = BrowseTheWeb.as(Bob).getPage();
` +
                        `await page.screenshot({ path: 'test-results/${featureName}.png', fullPage: true });`,
                },
            ];
        })();

        const generated: string[] = [];

        // ── Screen ─────────────────────────────────────────────
        const lazyProps = screenElements.filter((e) => e.isLazy);
        const staticProps = screenElements.filter((e) => !e.isLazy);
        const hasLazy = lazyProps.length > 0;

        const screenPropLines = [
            ...lazyProps.map((el) =>
                `    static ${el.propName}: LazySelector = (page: Page) => ${el.selector};`),
            ...staticProps.map((el) =>
                `    static ${el.propName} = '${el.selector}';`),
        ].join('\n');

        const screenContent =
`import type { LazySelector } from '@testla/screenplay-playwright';
import type { Page } from '@playwright/test';

export class ${screenName} {
${screenPropLines}
}
`;
        await write(`src/screenplay/screens/${kebab(screenName)}.ts`, screenContent, baseDir);
        generated.push(`src/screenplay/screens/${kebab(screenName)}.ts`);

        // Task
        const actionLines = taskActions
            .map((a) => a.trimEnd().replace(/,+$/, ''))
            .map((a) => `            ${a},`)
            .join('\n');
        const taskContent =
`import { Actor, Task } from '@testla/screenplay-playwright';
import { Navigate, Click, Fill, Wait } from '@testla/screenplay-playwright/web';
import { ${screenName} } from '../screens/${kebab(screenName)}';

/**
 * Task: ${description}
 *
 * Usage:
 *   await Bob.attemptsTo(${taskName}.toApp());
 */
export class ${taskName} extends Task {
    private constructor() {
        super();
    }

    public async performAs(actor: Actor): Promise<any> {
        return actor.attemptsTo(
${actionLines}
        );
    }

    public static toApp(): ${taskName} {
        return new ${taskName}();
    }
}
`;
        await write(`src/screenplay/tasks/${kebab(taskName)}.ts`, taskContent, baseDir);
        generated.push(`src/screenplay/tasks/${kebab(taskName)}.ts`);

        // Spec
        const testBlocks = testCases.map((t) => {
            const bodyLines = t.body.split('\n').map((l) => `        ${l}`).join('\n');
            return `    test('${t.name}', async ({ Bob }) => {\n${bodyLines}\n    });`;
        }).join('\n\n');

        const specContent =
`import { test, expect } from '../src/screenplay/fixtures/actors';
import { Navigate, Click, Element, BrowseTheWeb } from '@testla/screenplay-playwright/web';
import { ${screenName} } from '../src/screenplay/screens/${kebab(screenName)}';
import { ${taskName} } from '../src/screenplay/tasks/${kebab(taskName)}';

test.describe('${description}', () => {
${testBlocks}
});
`;
        await write(`tests/${kebab(featureName)}.spec.ts`, specContent, baseDir);
        generated.push(`tests/${kebab(featureName)}.spec.ts`);

        return {
            success: true,
            output:
                `✅ Feature "${featureName}" generated:\n` +
                generated.map((f) => `  • ${f}`).join('\n'),
        };
    },
};

// ─────────────────────────────────────────────────────────────
// Export Skill
// ─────────────────────────────────────────────────────────────

export const playwrightScreenplaySkill: Skill = {
    name: 'playwright-screenplay',
    description: 'Generate Screens, Tasks, Questions, Specs for testla-screenplay-playwright',
    version: '2.0.0',
    author: 'testla',
    tools: [generateScreen, generateTask, generateQuestion, generateSpec, generateFeature],
    systemPromptAddition: `
## playwright-screenplay Skill — CORRECT API PATTERNS

### Screen (locators only — no logic)
\`\`\`ts
import type { LazySelector } from '@testla/screenplay-playwright';
import type { Page } from '@playwright/test';

export class RandomRedesignScreen {
    static HEADING = 'h1';                                                    // static CSS
    static PICK_BUTTON: LazySelector = (page: Page) =>                       // LazySelector
        page.getByRole('button', { name: 'Pick My Combo' });
    static RESULT_TEXT: LazySelector = (page: Page) =>
        page.locator('.result');
}
\`\`\`

### Task (extends Task, performAs calls actor.attemptsTo)
\`\`\`ts
import { Actor, Task } from '@testla/screenplay-playwright';
import { Navigate, Click } from '@testla/screenplay-playwright/web';
import { RandomRedesignScreen } from '../screens/random-redesign-screen';

export class PickCombo extends Task {
    private constructor() { super(); }

    public async performAs(actor: Actor): Promise<void> {
        await Bob.attemptsTo(
            Navigate.to('https://blackgirlbytes.github.io/random-redesign-picker/'),
            Click.on(RandomRedesignScreen.PICK_BUTTON),
        );
    }

    public static now(): PickCombo { return new PickCombo(); }
}
\`\`\`

### Question (extends Question<T>, answeredBy gets page via BrowseTheWeb)
\`\`\`ts
import { Actor, Question } from '@testla/screenplay-playwright';
import { BrowseTheWeb } from '@testla/screenplay-playwright/web';

export class ResultText extends Question<string> {
    public async answeredBy(actor: Actor): Promise<string> {
        const page = BrowseTheWeb.as(actor).getPage();
        return page.locator('.result').innerText();
    }
    public static current(): ResultText { return new ResultText(); }
}
\`\`\`

### Test (actor from actors.ts fixture)
\`\`\`ts
import { test, expect } from '../src/screenplay/fixtures/actors';
import { Element } from '@testla/screenplay-playwright/web';
import { RandomRedesignScreen } from '../src/screenplay/screens/random-redesign-screen';
import { PickCombo } from '../src/screenplay/tasks/pick-combo';

test.describe('Random Redesign Picker', () => {
    test('picks a combo and shows result', async ({ Bob }) => {
        await Bob.attemptsTo(PickCombo.now());
        await Bob.asks(Element.toBe.visible(RandomRedesignScreen.RESULT_TEXT));
    });
});
\`\`\`

### Available web actions (from @testla/screenplay-playwright/web)
- Navigate.to(url)
- Click.on(selector)
- Fill.in(selector, value)
- Wait.forLoadState('networkidle')
- Element.toBe.visible(selector)
- Element.toHave.text(selector, expectedText)

### NEVER do:
- ❌ Task with performAs(page: Page)  → must be performAs(actor: Actor)
- ❌ Screen with methods or logic     → Screens are pure locator holders
- ❌ Question without extends Question<T>
- ❌ Import BrowseTheWeb from @testla/screenplay-playwright (wrong: it's in /web)
`,
};

export default playwrightScreenplaySkill;