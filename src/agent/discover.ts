// ─────────────────────────────────────────────────────────────────────────────
// testla-cli · src/agent/discover.ts
//
// walkFlow() — single browser session, browser-driven state detection.
//
// KEY PRINCIPLE: The browser decides when a new page state begins.
// The LLM plan provides hints and ordering — the browser provides ground truth.
//
// After every click we check:
//   1. Did the URL change?         → definite new page state
//   2. Did significant DOM change? → possible new state (SPA content update)
//   3. Did a modal/overlay appear? → snapshot in-place, tag as modal
//
// This handles:
//   - Classic multi-page apps (URL changes)
//   - SPAs (URL stays, content changes)
//   - Modals and overlays
//   - Dynamic content (AJAX, lazy load)
//   - Multi-step forms / wizards
// ─────────────────────────────────────────────────────────────────────────────

import { bold, cyan, green, red, yellow } from 'jsr:@std/fmt/colors';
import type { FlowPlan } from '../cli/planner.ts';

// ── Public types ──────────────────────────────────────────────────────────

export interface ElementInfo {
    propName: string;
    role: string;
    name: string;
    locator: string;
    kind: 'interactive' | 'output';
}

export interface AssertionResult {
    assertionKind: string;
    assertionValue?: string;
    passed: boolean;
    locator: string;
    note: string;
    /** Best-matching propName from the discovered elements of this page state */
    matchedPropName?: string;
}

export interface DiscoveredState {
    pageStateId: string;
    screenName: string;
    url: string;
    elements: ElementInfo[];
    screenshotPath: string;
    assertionResults: AssertionResult[];
    /** How this state was detected */
    detectedBy: 'navigate' | 'url-change' | 'content-change' | 'modal' | 'plan';
}

export interface WalkResult {
    states: DiscoveredState[];
    success: boolean;
    failedAt?: string;
}

// ── Stdio MCP client ──────────────────────────────────────────────────────

class StdioMCPClient {
    private proc: Deno.ChildProcess | null = null;
    private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    private pending = new Map<number, {
        resolve: (v: unknown) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    private idCounter = 1;
    private enc = new TextEncoder();
    private dec = new TextDecoder();
    private buf = '';

    async start(): Promise<void> {
        const hasBinary = await new Deno.Command('which', {
            args: ['playwright-mcp'], stdout: 'null', stderr: 'null',
        }).output().then(r => r.code === 0).catch(() => false);

        const cmd = hasBinary
            ? new Deno.Command('playwright-mcp', {
                args: ['--headless'], stdin: 'piped', stdout: 'piped', stderr: 'null',
            })
            : new Deno.Command('npx', {
                args: ['--yes', '@playwright/mcp@latest', '--headless'],
                stdin: 'piped', stdout: 'piped', stderr: 'null',
            });

        this.proc = cmd.spawn();
        this.writer = this.proc.stdin.getWriter();
        this.startReadLoop();

        await this.rpc('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            clientInfo: { name: 'testla-cli', version: '1.0' },
        });
    }

    private startReadLoop() {
        (async () => {
            const reader = this.proc!.stdout.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    this.buf += this.dec.decode(value);
                    this.flush();
                }
            } catch { /* ended */ }
        })();
    }

    private flush() {
        const lines = this.buf.split('\n');
        this.buf = lines.pop() ?? '';
        for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            try {
                const msg = JSON.parse(t);
                const h = this.pending.get(msg.id);
                if (h) {
                    this.pending.delete(msg.id);
                    clearTimeout(h.timer);
                    msg.error
                        ? h.reject(new Error(JSON.stringify(msg.error)))
                        : h.resolve(msg.result);
                }
            } catch { /* skip */ }
        }
    }

    rpc(method: string, params: unknown): Promise<unknown> {
        const id = this.idCounter++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP timeout: ${method}`));
            }, 30_000);
            this.pending.set(id, { resolve, reject, timer });
            const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
            this.writer!.write(this.enc.encode(msg)).catch(reject);
        });
    }

    async tool(name: string, args: Record<string, unknown>): Promise<string> {
        const r = await this.rpc('tools/call', { name, arguments: args }) as {
            content: Array<{ type: string; text?: string }>;
        };
        return (r.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
    }

    async stop() {
        try { await this.tool('browser_close', {}); } catch { /* ignore */ }
        try { this.writer?.close(); } catch { /* ignore */ }
        try { this.proc?.kill('SIGTERM'); } catch { /* ignore */ }
    }
}

// ── Accessibility snapshot parsing ────────────────────────────────────────

const INTERACTIVE = new Set([
    'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio',
    'combobox', 'listbox', 'menuitem', 'switch', 'tab', 'spinbutton',
]);

const OUTPUT_ROLES = /alert|status|region|paragraph|heading/;

function locatorFor(role: string, name: string): string {
    if (!name) return `page.getByRole('${role}')`;
    if (['textbox', 'searchbox', 'spinbutton', 'combobox'].includes(role)) {
        return `page.getByLabel(${JSON.stringify(name)})`;
    }
    return `page.getByRole('${role}', { name: ${JSON.stringify(name)} })`;
}

function toProp(name: string, role: string, suffix = ''): string {
    const base = (name || role)
        .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    return (base || 'ELEMENT') + suffix;
}

function parseSnapshot(snap: string): ElementInfo[] {
    const seen = new Set<string>();
    const out: ElementInfo[] = [];
    for (const line of snap.split('\n')) {
        const m = line.match(/^\s*-\s+(\w[\w-]*)\s+"([^"]+)"/);
        if (!m) continue;
        const [, role, name] = m;
        const locator = locatorFor(role, name);
        if (seen.has(locator)) continue;
        seen.add(locator);
        if (INTERACTIVE.has(role)) {
            out.push({ kind: 'interactive', role, name, locator, propName: toProp(name, role) });
        } else if (OUTPUT_ROLES.test(role)) {
            out.push({ kind: 'output', role, name, locator, propName: toProp(name, role, '_AREA') });
        }
    }
    return out;
}

/** Extract current URL from snapshot text */
function extractUrl(snap: string): string {
    return snap.match(/Page URL:\s*(\S+)/)?.[1] ?? '';
}

/** Count interactive elements — rough measure of page complexity */
function countInteractive(snap: string): number {
    return (snap.match(/^\s*-\s+\w[\w-]*\s+"/gm) ?? []).length;
}

// ── Element matching (hint → ref) ─────────────────────────────────────────

function findRef(snap: string, hint: string, preferRole?: string): string | null {
    if (!hint) return null;
    const hl = hint.toLowerCase();
    let best = 0, bestRef: string | null = null;

    for (const line of snap.split('\n')) {
        const m = line.match(/^\s*-\s+(\w[\w-]*)\s+"([^"]+)".*\[ref=([^\]]+)\]/);
        if (!m) continue;
        const [, role, name, ref] = m;
        const nl = name.toLowerCase();
        let score = 0;

        if (preferRole && role === preferRole) score += 2;
        for (const w of hl.split(/\W+/).filter(Boolean)) {
            if (nl.includes(w)) score += 3;
        }
        if (nl === hl || nl.includes(hl) || hl.includes(nl)) score += 5;
        if (score > best) { best = score; bestRef = ref; }
    }
    return bestRef;
}

// ── Change detection ──────────────────────────────────────────────────────

interface PageState {
    url: string;
    interactiveCount: number;
    snap: string;
}

type ChangeKind = 'none' | 'url-change' | 'content-change' | 'modal';

function detectChange(before: PageState, after: PageState): ChangeKind {
    // 1. URL changed → definite navigation
    if (before.url && after.url && before.url !== after.url) {
        return 'url-change';
    }

    // 2. Modal/dialog appeared (new dialog/alertdialog role in snapshot)
    const hadDialog = /role="(?:dialog|alertdialog)"/.test(before.snap) ||
                      before.snap.includes('dialog "');
    const hasDialog = /role="(?:dialog|alertdialog)"/.test(after.snap) ||
                      after.snap.includes('dialog "');
    if (!hadDialog && hasDialog) return 'modal';

    // 3. Significant content change on same URL
    // Threshold: interactive count changed by >3 or >40%
    const delta = Math.abs(after.interactiveCount - before.interactiveCount);
    const pct = before.interactiveCount > 0
        ? delta / before.interactiveCount
        : 0;

    if (delta > 3 || pct > 0.4) return 'content-change';

    return 'none';
}

// ── walkFlow ──────────────────────────────────────────────────────────────

export async function walkFlow(
    plan: FlowPlan,
    url: string,
    outputDir: string,
): Promise<WalkResult> {
    const enc = new TextEncoder();
    await Deno.mkdir(outputDir, { recursive: true });
    const ts = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    Deno.stdout.writeSync(enc.encode(
        `\n  🔍  Walking flow: ${bold(url)}\n` +
        `      ${plan.steps.length} step(s), ${plan.pageStates.length} planned page state(s)\n\n`,
    ));

    const client = new StdioMCPClient();

    try {
        // ── Start browser ─────────────────────────────────────────────
        try {
            await client.start();
        } catch (e) {
            Deno.stdout.writeSync(enc.encode(
                `\n  ${red('❌')}  Cannot start @playwright/mcp\n` +
                `      npm install -g @playwright/mcp@latest\n` +
                `      ${String(e).slice(0, 120)}\n\n`,
            ));
            return { states: [], success: false, failedAt: 'browser start' };
        }

        const states: DiscoveredState[] = [];

        // Map plan pageStateId → discovered state (for later assertion lookup)
        const stateByPlanId = new Map<string, DiscoveredState>();

        // Current plan state cursor
        let planStateIdx = 0;
        const currentPlanState = () => plan.pageStates[planStateIdx];

        // Capture and record the current page as a discovered state
        const captureCurrentPage = async (
            pageStateId: string,
            screenName: string,
            detectedBy: DiscoveredState['detectedBy'],
            currentUrl: string,
        ): Promise<DiscoveredState> => {
            const shotPath = `${outputDir}/${pageStateId}-${ts()}.png`;
            await client.tool('browser_screenshot', { filename: shotPath, raw: false }).catch(() => {});
            const snap = await client.tool('browser_snapshot', {}).catch(() => '');
            const elements = parseSnapshot(snap);

            const interactive = elements.filter(e => e.kind === 'interactive');
            const outputs = elements.filter(e => e.kind === 'output');

            Deno.stdout.writeSync(enc.encode(
                `\n  ${cyan('📸')}  [${pageStateId}] ${screenName} (${detectedBy})\n` +
                `      URL: ${currentUrl || '(unknown)'}\n` +
                `      ${interactive.length} interactive, ${outputs.length} output\n` +
                `      Screenshot: ${shotPath}\n`,
            ));

            const state: DiscoveredState = {
                pageStateId,
                screenName,
                url: currentUrl,
                elements,
                screenshotPath: shotPath,
                assertionResults: [],
                detectedBy,
            };

            states.push(state);
            stateByPlanId.set(pageStateId, state);
            return state;
        };

        // ── Walk steps ────────────────────────────────────────────────
        let snap = '';
        let pageState: PageState = { url: '', interactiveCount: 0, snap: '' };

        for (let i = 0; i < plan.steps.length; i++) {
            const step = plan.steps[i];
            const stepLabel = `step ${i + 1}/${plan.steps.length}: ${step.kind}` +
                (step.hint ? ` "${step.hint}"` : '') +
                (step.value ? ` = "${step.value}"` : '');

            Deno.stdout.writeSync(enc.encode(`      ${yellow('→')} ${stepLabel}\n`));

            // ── navigate ───────────────────────────────────────────────
            if (step.kind === 'navigate') {
                try {
                    await client.tool('browser_navigate', { url });
                    await new Promise(r => setTimeout(r, 1000));
                } catch (e) {
                    const msg = String(e);
                    Deno.stdout.writeSync(enc.encode(
                        `\n  ${red('❌')}  Cannot reach ${url}\n      ${msg.slice(0, 150)}\n\n`,
                    ));
                    await client.stop();
                    return { states, success: false, failedAt: `navigate to ${url}` };
                }

                snap = await client.tool('browser_snapshot', {}).catch(() => '');
                const currentUrl = extractUrl(snap);
                pageState = { url: currentUrl, interactiveCount: countInteractive(snap), snap };

                const ps = currentPlanState();
                await captureCurrentPage(ps.id, ps.screenName, 'navigate', currentUrl);
                continue;
            }

            // ── fill ───────────────────────────────────────────────────
            if (step.kind === 'fill') {
                snap = await client.tool('browser_snapshot', {}).catch(() => snap);
                const ref = findRef(snap, step.hint ?? '', 'textbox') ??
                            findRef(snap, step.hint ?? '');

                if (ref) {
                    await client.tool('browser_type', { ref, text: step.value ?? '' }).catch(e =>
                        Deno.stdout.writeSync(enc.encode(`      ${yellow('⚠️')}  type failed: ${String(e).slice(0, 80)}\n`)),
                    );
                } else {
                    Deno.stdout.writeSync(enc.encode(`      ${yellow('⚠️')}  no element for hint "${step.hint}"\n`));
                }
                continue;
            }

            // ── click ──────────────────────────────────────────────────
            if (step.kind === 'click') {
                snap = await client.tool('browser_snapshot', {}).catch(() => snap);
                const before: PageState = {
                    url: extractUrl(snap),
                    interactiveCount: countInteractive(snap),
                    snap,
                };

                const ref = findRef(snap, step.hint ?? '', 'button') ??
                            findRef(snap, step.hint ?? '', 'link') ??
                            findRef(snap, step.hint ?? '');

                if (!ref) {
                    Deno.stdout.writeSync(enc.encode(`      ${yellow('⚠️')}  no element for hint "${step.hint}"\n`));
                    continue;
                }

                await client.tool('browser_click', { ref }).catch(e =>
                    Deno.stdout.writeSync(enc.encode(`      ${yellow('⚠️')}  click failed: ${String(e).slice(0, 80)}\n`)),
                );

                // Wait for any navigation or content update to settle
                await new Promise(r => setTimeout(r, 1200));

                snap = await client.tool('browser_snapshot', {}).catch(() => snap);
                const after: PageState = {
                    url: extractUrl(snap),
                    interactiveCount: countInteractive(snap),
                    snap,
                };

                const change = detectChange(before, after);

                if (change !== 'none') {
                    // Advance to next plan state if available
                    const nextPlanState = plan.pageStates[planStateIdx + 1];

                    if (nextPlanState) {
                        planStateIdx++;
                        await captureCurrentPage(
                            nextPlanState.id,
                            nextPlanState.screenName,
                            change,
                            after.url,
                        );
                    } else {
                        // More states than planned — create an auto-named one
                        const autoId = `page-${states.length + 1}`;
                        const autoName = `Page${states.length + 1}Screen`;
                        Deno.stdout.writeSync(enc.encode(
                            `      ${yellow('ℹ️')}  Unexpected page state detected (${change}) — capturing as ${autoName}\n`,
                        ));
                        await captureCurrentPage(autoId, autoName, change, after.url);
                    }
                    pageState = after;
                }
                continue;
            }

            // ── assert ─────────────────────────────────────────────────
            if (step.kind === 'assert') {
                snap = await client.tool('browser_snapshot', {}).catch(() => snap);

                // Find the state this assertion belongs to
                const targetState = stateByPlanId.get(step.pageStateId)
                    ?? states[states.length - 1];

                if (!targetState) continue;

                if (step.assertionKind === 'text' && step.assertionValue) {
                    const found = snap.toLowerCase().includes(step.assertionValue.toLowerCase());
                    const locator = `page.getByText(${JSON.stringify(step.assertionValue)})`;

                    // Find the best matching Screen prop for this text
                    // Score by trigram coverage: longer name match = more specific = better
                    const textLower = step.assertionValue.toLowerCase();
                    let bestProp: string | undefined;
                    let bestScore = 0;
                    for (const el of targetState.elements) {
                        const nl = el.name.toLowerCase();
                        let score = 0;
                        for (let i = 0; i <= nl.length - 3; i++) {
                            if (textLower.includes(nl.slice(i, i + 3))) score++;
                        }
                        score += nl.length * 0.1; // prefer longer (more specific) names
                        if (score > bestScore) { bestScore = score; bestProp = el.propName; }
                    }

                    targetState.assertionResults.push({
                        assertionKind: 'text',
                        assertionValue: step.assertionValue,
                        passed: found,
                        locator,
                        matchedPropName: bestProp,
                        note: found
                            ? `✅ Text found: "${step.assertionValue}"` +
                              (bestProp ? ` → ${bestProp}` : '')
                            : `⚠️  Text NOT found: "${step.assertionValue}"`,
                    });
                    Deno.stdout.writeSync(enc.encode(
                        `      ${found ? green('✅') : yellow('⚠️')}  text "${step.assertionValue}": ${found ? 'FOUND' : 'NOT FOUND'}\n`,
                    ));

                } else if (step.assertionKind === 'visible' && step.hint) {
                    const ref = findRef(snap, step.hint);
                    const targetState2 = stateByPlanId.get(step.pageStateId) ?? states[states.length - 1];
                    const matchedEl = ref
                        ? targetState2.elements.find(e => snap.includes(e.name) && snap.includes(`[ref=${ref}]`))
                        : null;
                    const locator = matchedEl?.locator ?? `page.getByText(${JSON.stringify(step.hint)})`;

                    targetState.assertionResults.push({
                        assertionKind: 'visible',
                        passed: !!ref,
                        locator,
                        note: ref ? `✅ Element found: "${step.hint}"` : `⚠️  Not found: "${step.hint}"`,
                    });
                    Deno.stdout.writeSync(enc.encode(
                        `      ${ref ? green('✅') : yellow('⚠️')}  visible "${step.hint}": ${ref ? 'FOUND' : 'NOT FOUND'}\n`,
                    ));

                } else if (step.assertionKind === 'url' && step.assertionValue) {
                    const currentUrl = extractUrl(snap);
                    const found = currentUrl.includes(step.assertionValue);
                    targetState.assertionResults.push({
                        assertionKind: 'url',
                        assertionValue: step.assertionValue,
                        passed: found,
                        locator: 'page.url()',
                        note: found ? `✅ URL matches` : `⚠️  URL mismatch (got: ${currentUrl})`,
                    });
                }
                continue;
            }

            // ── wait ───────────────────────────────────────────────────
            if (step.kind === 'wait') {
                await new Promise(r => setTimeout(r, 1500));
                snap = await client.tool('browser_snapshot', {}).catch(() => snap);
                // After wait, check if content changed significantly
                const after: PageState = {
                    url: extractUrl(snap),
                    interactiveCount: countInteractive(snap),
                    snap,
                };
                if (detectChange(pageState, after) !== 'none') {
                    snap = after.snap;
                    pageState = after;
                }
                continue;
            }

            // ── screenshot ─────────────────────────────────────────────
            if (step.kind === 'screenshot') {
                const shotPath = `${outputDir}/manual-screenshot-${ts()}.png`;
                await client.tool('browser_screenshot', { filename: shotPath, raw: false }).catch(() => {});
                Deno.stdout.writeSync(enc.encode(`      📷  ${shotPath}\n`));
                continue;
            }
        }

        await client.stop();

        // ── Summary ───────────────────────────────────────────────────
        Deno.stdout.writeSync(enc.encode(`\n  ${cyan('✅')}  Walk complete: ${states.length} page state(s)\n`));
        for (const s of states) {
            const passed = s.assertionResults.filter(a => a.passed).length;
            const total  = s.assertionResults.length;
            Deno.stdout.writeSync(enc.encode(
                `      [${s.pageStateId}] ${s.screenName} — ` +
                `${s.elements.length} elements` +
                (total ? `, ${passed}/${total} assertions` : '') + '\n',
            ));
            for (const a of s.assertionResults) {
                Deno.stdout.writeSync(enc.encode(`        ${a.note}\n`));
            }
        }
        Deno.stdout.writeSync(enc.encode('\n'));

        return { states, success: true };

    } catch (err) {
        await client.stop().catch(() => {});
        Deno.stdout.writeSync(enc.encode(
            `\n  ${red('❌')}  walkFlow crashed: ${String(err).slice(0, 200)}\n\n`,
        ));
        return { states: [], success: false, failedAt: String(err) };
    }
}