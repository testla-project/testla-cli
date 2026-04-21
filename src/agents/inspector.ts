// ─────────────────────────────────────────────────────────────────────────────
// testla-cli · src/agent/inspector.ts
//
// Playwright page inspector — runs as a Node.js child process.
// Started by Deno via: node --import=tsx src/agent/inspector.ts
//
// Protocol: newline-delimited JSON on stdio
//
// Commands (Deno → inspector via stdin):
//   { "id": 1, "cmd": "goto",       "url": "https://..." }
//   { "id": 2, "cmd": "snapshot" }
//   { "id": 3, "cmd": "click",      "ref": "e5" }
//   { "id": 4, "cmd": "fill",       "ref": "e3", "text": "hello" }
//   { "id": 5, "cmd": "screenshot", "path": "/abs/path.png" }
//   { "id": 6, "cmd": "eval",       "js": "document.title" }
//   { "id": 7, "cmd": "wait",       "ms": 1500 }
//   { "id": 8, "cmd": "url" }
//   { "id": 9, "cmd": "quit" }
//
// Responses (inspector → Deno via stdout):
//   { "id": 1, "ok": true,  "url": "https://..." }
//   { "id": 2, "ok": true,  "elements": [...] }
//   { "id": 3, "ok": false, "error": "Element not found" }
// ─────────────────────────────────────────────────────────────────────────────

import { chromium, type Page, type BrowserContext, type Browser } from 'playwright';
import * as readline from "node:readline";
import path from "node:path";
import fs from "node:fs";

// ── Types ─────────────────────────────────────────────────────────────────

interface Element {
    ref: string;
    role: string;
    name: string;
    locator: string;       // e.g. page.getByRole('button', { name: 'Login' })
    propName: string;      // e.g. LOGIN_BUTTON
    interactive: boolean;
}

// ── Ref management ────────────────────────────────────────────────────────
// Each snapshot assigns refs to elements. Refs survive until the next snapshot.

interface RefEntry { role: string; name: string; selector?: string }
let refCounter = 0;
const refMap = new Map<string, RefEntry>();

function nextRef(): string { return `e${++refCounter}`; }

// ── Element locator strategy ─────────────────────────────────────────────
//
// Priority (highest to lowest stability):
//   1. data-testid          → page.getByTestId('...')
//   2. aria-label           → page.getByLabel('...')
//   3. placeholder          → page.getByPlaceholder('...')
//   4. id (unique, stable)  → page.locator('#id')
//   5. role + name          → page.getByRole('button', { name: '...' })
//   6. name attr            → page.locator('[name="..."]')
//   7. stable CSS class     → page.locator('.class-name')
//
// This runs OUTSIDE the browser (from the a11y tree).
// DOM-enriched locators are computed separately via getDomLocators().

const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio',
    'combobox', 'listbox', 'menuitem', 'switch', 'tab', 'spinbutton',
    'menuitemcheckbox', 'menuitemradio', 'slider', 'option',
]);

const SKIP_ROLES = new Set(['none', 'presentation', 'document', 'RootWebArea', 'generic', 'img']);

function toPropName(label: string): string {
    return label
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 50) || 'ELEMENT';
}

/** Fallback locator from a11y tree only — used when DOM enrichment is unavailable */
function a11yLocator(role: string, name: string): string {
    if (!name) return `page.getByRole(${JSON.stringify(role)})`;
    if (['textbox', 'searchbox', 'spinbutton', 'combobox'].includes(role)) {
        return `page.getByLabel(${JSON.stringify(name)})`;
    }
    return `page.getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(name)} })`;
}

function walkTree(
    node: { role?: string; name?: string; children?: unknown[] } | null,
    out: Element[],
    depth = 0,
): void {
    if (!node || depth > 40) return;

    const role = node.role ?? '';
    const name = (node.name ?? '').trim();

    if (!SKIP_ROLES.has(role) && name) {
        const ref = nextRef();
        refMap.set(ref, { role, name });
        out.push({
            ref,
            role,
            name,
            locator: a11yLocator(role, name),
            propName: toPropName(name),
            interactive: INTERACTIVE_ROLES.has(role),
        });
    }

    for (const child of (node.children ?? []) as typeof node[]) {
        walkTree(child, out, depth + 1);
    }
}

// ── DOM-based interactive element discovery ────────────────────────────────
// Replaces page.accessibility.snapshot() which was removed in Playwright v1.47.
// Queries the live DOM directly and builds the same Element[] structure.

async function getDomInteractiveElements(page: Page): Promise<Element[]> {
    const raw = await page.evaluate((): Array<{
        role: string; name: string; locator: string; prop: string; interactive: boolean;
    }> => {
        const INTERACTIVE_ROLES = new Set([
            'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio',
            'combobox', 'listbox', 'menuitem', 'switch', 'tab', 'spinbutton',
            'menuitemcheckbox', 'menuitemradio', 'slider', 'option',
        ]);

        const TAG_TO_ROLE: Record<string, string> = {
            button: 'button', a: 'link', input: 'textbox',
            select: 'combobox', textarea: 'textbox',
        };

        const results: Array<{
            role: string; name: string; locator: string; prop: string; interactive: boolean;
        }> = [];

        const seen = new Set<string>();

        const candidates = Array.from(document.querySelectorAll(
            'button, a[href], input:not([type=hidden]), select, textarea, [role], [data-testid], h1, h2, h3, label, p, span, div'
        )) as HTMLElement[];

        for (const el of candidates) {
            const tag = el.tagName.toLowerCase();
            const roleAttr = el.getAttribute('role');
            const role = roleAttr || TAG_TO_ROLE[tag] || tag;
            const interactive = INTERACTIVE_ROLES.has(role);

            const testid = (el as HTMLElement & { dataset: DOMStringMap }).dataset?.testid;
            const ariaLabel = el.getAttribute('aria-label');
            const label = (el as HTMLInputElement).labels?.[0]?.textContent?.trim() || '';
            const placeholder = el.getAttribute('placeholder');
            const idAttr = el.id;
            const nameAttr = el.getAttribute('name');
            const text = el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 60) || '';
            const cls = Array.from(el.classList)
                .filter(c => !/^(ng-|v-|css-|is-|has-|js-|active|disabled|hidden|visible|\d)/.test(c))
                .slice(0, 2).join('.');

            const accessibleName = ariaLabel || label || placeholder || text || idAttr || nameAttr || '';
            if (!accessibleName) continue;

            let locator: string;
            if (testid) {
                locator = `page.getByTestId(${JSON.stringify(testid)})`;
            } else if (ariaLabel) {
                locator = `page.getByLabel(${JSON.stringify(ariaLabel)})`;
            } else if (label && ['textbox', 'searchbox', 'checkbox', 'radio', 'combobox'].includes(role)) {
                locator = `page.getByLabel(${JSON.stringify(label)})`;
            } else if (placeholder && ['textbox', 'searchbox'].includes(role)) {
                locator = `page.getByPlaceholder(${JSON.stringify(placeholder)})`;
            } else if (idAttr && !/^\d|^[a-z]{1,2}\d+$/.test(idAttr)) {
                locator = `page.locator(${JSON.stringify('#' + idAttr)})`;
            } else if (role === 'button' && text) {
                locator = `page.getByRole('button', { name: ${JSON.stringify(text)} })`;
            } else if (role === 'link' && text) {
                locator = `page.getByRole('link', { name: ${JSON.stringify(text)} })`;
            } else if (nameAttr) {
                locator = `page.locator('[name=${JSON.stringify(nameAttr)}]')`;
            } else if (cls) {
                locator = `page.locator(${JSON.stringify('.' + cls)})`;
            } else {
                continue;
            }

            if (seen.has(locator)) continue;
            seen.add(locator);

            const prop = accessibleName
                .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'ELEMENT';

            results.push({ role, name: accessibleName, locator, prop, interactive });
        }

        return results;
    }).catch(() => []);

    return raw.map(r => ({
        ref: nextRef(),
        role: r.role,
        name: r.name,
        locator: r.locator,
        propName: r.prop,
        interactive: r.interactive,
    }));
}

// ── DOM-based locator enrichment ─────────────────────────────────────────
//
// Runs inside page.evaluate() — has full access to the DOM.
// For each interactive element, determines the best locator strategy
// by checking attributes in priority order.
//
// Returns a map: { role+name fingerprint → best locator string }

async function getDomLocators(page: Page): Promise<Map<string, string>> {
    const raw = await page.evaluate((): Array<{ key: string; locator: string }> => {
        const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea']);
        const INTERACTIVE_ROLES = new Set([
            'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio',
            'combobox', 'listbox', 'menuitem', 'switch', 'tab', 'spinbutton',
        ]);

        const results: Array<{ key: string; locator: string }> = [];

        const candidates = Array.from(document.querySelectorAll(
            'button, a[href], input, select, textarea, [role], [data-testid]'
        )) as HTMLElement[];

        for (const el of candidates) {
            const tag      = el.tagName.toLowerCase();
            const role     = el.getAttribute('role') || tag;
            const testid   = el.dataset?.testid;
            const ariaLabel = el.getAttribute('aria-label');
            const label    = (el as HTMLInputElement).labels?.[0]?.textContent?.trim() || '';
            const placeholder = el.getAttribute('placeholder');
            const idAttr   = el.id;
            const nameAttr = el.getAttribute('name');
            const text     = el.textContent?.trim().slice(0, 60) || '';
            const cls      = Array.from(el.classList)
                .filter(c => !/^(ng-|v-|css-|is-|has-|js-|active|disabled|hidden|visible|\d)/.test(c))
                .slice(0, 2).join('.');

            // Fingerprint: role + accessible name (matches a11y tree)
            const accessibleName = ariaLabel || label || el.getAttribute('aria-labelledby') || text;
            const fingerprint    = `${role}::${accessibleName}`;

            // Choose best locator
            let locator: string;
            if (testid) {
                locator = `page.getByTestId(${JSON.stringify(testid)})`;
            } else if (ariaLabel && INTERACTIVE_ROLES.has(role)) {
                locator = `page.getByLabel(${JSON.stringify(ariaLabel)})`;
            } else if (label && ['textbox', 'searchbox', 'checkbox', 'radio', 'combobox'].includes(role)) {
                locator = `page.getByLabel(${JSON.stringify(label)})`;
            } else if (placeholder && ['textbox', 'searchbox'].includes(role)) {
                locator = `page.getByPlaceholder(${JSON.stringify(placeholder)})`;
            } else if (idAttr && !idAttr.match(/^\d|^[a-z]{1,2}\d+$/)) {
                // Stable ID (not auto-generated like 'b1' or '42')
                locator = `page.locator(${JSON.stringify('#' + idAttr)})`;
            } else if (role === 'button' && text) {
                locator = `page.getByRole('button', { name: ${JSON.stringify(text)} })`;
            } else if (role === 'link' && text) {
                locator = `page.getByRole('link', { name: ${JSON.stringify(text)} })`;
            } else if (nameAttr) {
                locator = `page.locator(${JSON.stringify('[name=' + JSON.stringify(nameAttr) + ']')})`;
            } else if (cls) {
                locator = `page.locator(${JSON.stringify('.' + cls)})`;
            } else {
                continue; // no good locator
            }

            results.push({ key: fingerprint, locator });
        }

        return results;
    }).catch(() => []);

    return new Map(raw.map(r => [r.key, r.locator]));
}

// ── DOM output element discovery ──────────────────────────────────────────
// Finds non-semantic containers like <div id="result"> that are invisible
// to the accessibility tree but contain important output.

async function getDomOutputElements(page: Page): Promise<Element[]> {
    const raw = await page.evaluate((): Array<{locator: string; name: string; prop: string}> => {
        const OUTPUT = /result|output|combo|response|answer|todo|count|message|notification|alert/i;
        const els: Array<{locator: string; name: string; prop: string}> = [];
        const seen = new Set<string>();

        for (const el of Array.from(document.querySelectorAll('[id], [class], [data-testid]'))) {
            const htmlEl = el as HTMLElement;
            const testid = htmlEl.dataset?.testid;
            const id     = htmlEl.id;
            const cls    = Array.from(htmlEl.classList).find(c => OUTPUT.test(c));

            let selector: string | null = null;
            let prop = '';

            if (testid) {
                selector = `[data-testid="${testid}"]`;
                prop = testid.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
            } else if (id && OUTPUT.test(id)) {
                selector = `#${id}`;
                prop = id.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
            } else if (cls) {
                selector = `.${cls}`;
                prop = cls.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
            }

            if (!selector || seen.has(selector)) continue;
            seen.add(selector);

            const text = (htmlEl.textContent ?? '').trim().slice(0, 80);
            els.push({
                locator: `page.locator(${JSON.stringify(selector)})`,
                name: text || selector,
                prop: prop.replace(/^_+|_+$/g, '') + '_OUTPUT',
            });
        }

        return els;
    }).catch(() => []);

    return raw.map(r => ({
        ref: nextRef(),
        role: 'generic',
        name: r.name,
        locator: r.locator,
        propName: r.prop,
        interactive: false,
    }));
}

// ── Click / Fill helpers ──────────────────────────────────────────────────

async function clickByRef(page: Page, ref: string): Promise<void> {
    const entry = refMap.get(ref);
    if (!entry) throw new Error(`Unknown ref: ${ref}`);
    const { role, name } = entry;

    if (name) {
        await page.getByRole(role as Parameters<Page['getByRole']>[0], { name })
            .first()
            .click({ timeout: 8000 });
    } else {
        await page.getByRole(role as Parameters<Page['getByRole']>[0])
            .first()
            .click({ timeout: 8000 });
    }
}

async function fillByRef(page: Page, ref: string, text: string): Promise<void> {
    const entry = refMap.get(ref);
    if (!entry) throw new Error(`Unknown ref: ${ref}`);
    const { role, name } = entry;

    if (name) {
        try {
            await page.getByLabel(name).first().fill(text, { timeout: 8000 });
        } catch {
            await page.getByRole(role as Parameters<Page['getByRole']>[0], { name })
                .first()
                .fill(text, { timeout: 8000 });
        }
    } else {
        await page.getByRole(role as Parameters<Page['getByRole']>[0])
            .first()
            .fill(text, { timeout: 8000 });
    }
}

// ── Main session ──────────────────────────────────────────────────────────

async function main() {
    const browser: Browser = await chromium.launch({ headless: true });
    const context: BrowserContext = await browser.newContext({
        viewport: { width: 1280, height: 720 },
    });
    const page: Page = await context.newPage();

    const send = (obj: object) => process.stdout.write(JSON.stringify(obj) + '\n');

    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

    rl.on('line', async (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let msg: { id: number; cmd: string; [k: string]: unknown };
        try { msg = JSON.parse(trimmed); }
        catch { return; }

        const { id, cmd } = msg;

        try {
            switch (cmd) {

                case 'goto': {
                    const navUrl = msg.url as string;
                    const response = await page.goto(navUrl, {
                        waitUntil: 'domcontentloaded',
                        timeout: 20000,
                    });
                    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

                    const status = response?.status() ?? 0;
                    if (status >= 400) {
                        send({ id, ok: false, error: `HTTP ${status}`, url: page.url() });
                    } else {
                        send({ id, ok: true, url: page.url() });
                    }
                    break;
                }

                case 'snapshot': {
                    try {
        refCounter = 0;
        refMap.clear();

        // page.accessibility was removed in Playwright v1.47 — use DOM fallback
        let a11yElements: Element[] = [];

        const accessibilityApi = (page as unknown as Record<string, unknown>).accessibility as
            { snapshot: (o: { interestingOnly: boolean }) => Promise<unknown> } | undefined;

        if (accessibilityApi?.snapshot) {
            // Legacy path (Playwright < 1.47)
            const tree = await accessibilityApi.snapshot({ interestingOnly: false });
            if (tree) walkTree(tree as Parameters<typeof walkTree>[0], a11yElements);
        }

        if (a11yElements.length === 0) {
            // Modern path: DOM-based element discovery
            a11yElements = await getDomInteractiveElements(page).catch(() => []);
        }

        // Enrich locators with DOM-derived best locators
        const domLocators = await getDomLocators(page).catch(() => new Map<string, string>());
        for (const el of a11yElements) {
            const fingerprint = `${el.role}::${el.name}`;
            const domLocator = domLocators.get(fingerprint);
            if (domLocator) el.locator = domLocator;
        }

        // Add DOM output elements (e.g. <div id="result">)
        const domElements = await getDomOutputElements(page).catch(() => [] as Element[]);
        const seenLocators = new Set(a11yElements.map(e => e.locator));
        const merged: Element[] = [
            ...a11yElements,
            ...domElements.filter(e => !seenLocators.has(e.locator)),
        ];

        send({ id, ok: true, url: page.url(), elements: merged });
    } catch (err) {
        send({
            id, ok: false,
            error: err instanceof Error ? err.message : String(err),
            url: page.url(), elements: []
        });
    }
    break;
                }

                case 'click': {
                    const ref = msg.ref as string;
                    await clickByRef(page, ref);
                    await page.waitForTimeout(300);
                    send({ id, ok: true });
                    break;
                }

                case 'fill': {
                    const ref  = msg.ref  as string;
                    const text = msg.text as string ?? '';
                    await fillByRef(page, ref, text);
                    send({ id, ok: true });
                    break;
                }

                case 'screenshot': {
                    const shotPath = msg.path as string ??
                        `/tmp/testla-screenshot-${Date.now()}.png`;
                    fs.mkdirSync(path.dirname(shotPath), { recursive: true });
                    await page.screenshot({ path: shotPath, fullPage: true });
                    send({ id, ok: true, path: shotPath });
                    break;
                }

                case 'eval': {
                    const js = msg.js as string;
                    const result = await page.evaluate(js);
                    send({ id, ok: true, result: String(result ?? '') });
                    break;
                }

                case 'url': {
                    send({ id, ok: true, url: page.url() });
                    break;
                }

                case 'wait': {
                    const ms = (msg.ms as number) ?? 1000;
                    await page.waitForTimeout(ms);
                    send({ id, ok: true });
                    break;
                }

                case 'waitForSelector': {
                    const selector = msg.selector as string;
                    await page.waitForSelector(selector, { timeout: msg.timeout as number ?? 10000 });
                    send({ id, ok: true });
                    break;
                }

                case 'quit': {
                    send({ id, ok: true });
                    await browser.close();
                    process.exit(0);
                    break;
                }

                default:
                    send({ id, ok: false, error: `Unknown command: ${cmd}` });
            }
        } catch (err: unknown) {
            send({ id, ok: false, error: String(err).slice(0, 300) });
        }
    });

    rl.on('close', async () => {
        await browser.close().catch(() => {});
        process.exit(0);
    });
}

main().catch(err => {
    process.stderr.write(String(err) + '\n');
    process.exit(1);
});