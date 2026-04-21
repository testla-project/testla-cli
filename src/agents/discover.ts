// ─────────────────────────────────────────────────────────────────────────────
// testla-cli · src/agent/discover.ts
//
// walkFlow() — walks through the entire test flow in one browser session.
//
// Uses InspectorSession (inspector.ts via Node.js) instead of playwright-mcp.
// This gives us full control: real Playwright API, DOM queries, screenshots.
//
// After every page change:
//   1. Screenshot
//   2. Full snapshot (a11y tree + DOM output elements)
//   3. Update/create DiscoveredState for that page
//
// After every click where URL didn't change:
//   Re-snapshot the current page completely → catches dynamic content.
// ─────────────────────────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
import { bold, cyan, green, red, yellow } from 'jsr:@std/fmt/colors';
import { InspectorSession } from './session.ts';
import type { SnapElement } from './session.ts';
import type { AnalystPlan } from './analyst.ts';
 
// ── Public types ──────────────────────────────────────────────────────────
export interface ElementInfo {
    propName: string;
    role: string;
    name: string;
    locator: string;
    kind: 'interactive' | 'output';
}

export interface AssertionResult {
    asserionKind: string;
    assertionValue?: string;
    passed: boolean;
    locator: string;
    machtedPropName?: string;
    note: string;
}

export interface DiscoveredState {
    pageStateId: string;
    screenName: string;
    url: string;
    elements: ElementInfo[];
    screenshotPath: string;
    assertionResults: AssertionResult[];
    detectedBy: 'navigate' | 'url-change' | 'content-change' | 'plan';
}

export interface WalkResult {
    states: DiscoveredState[];
    success: boolean;
    failedAt?: string;
}

// ── SnapElement → ElementInfo ─────────────────────────────────────────────
function toElementInfo(el: SnapElement): ElementInfo {
    return {
        propName: el.propName,
        role: el.role,
        name: el.name,
        locator: el.locator,
        kind: el.interactive ? 'interactive' : 'output',
    };
}

// ── walkFlow ──────────────────────────────────────────────────────────────
 
export async function walkFlow(
    plan: AnalystPlan,
    startUrl: string,
    outputDir: string,
    projectDir: string,
): Promise<WalkResult> {
    const enc = new TextEncoder();
    await Deno.mkdir(outputDir, { recursive: true });
 
    const ts = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
 
    Deno.stdout.writeSync(enc.encode(
        `\n  🔍  Starting browser session: ${bold(startUrl)}\n` +
        `      ${plan.steps.length} step(s), ${plan.pageStates.length} planned page state(s)\n\n`,
    ));
 
    // ── Start inspector ───────────────────────────────────────────────
    let session: InspectorSession;
    try {
        session = await InspectorSession.start(projectDir);
    } catch (e) {
        Deno.stdout.writeSync(enc.encode(
            `\n  ${red('❌')}  Cannot start inspector\n` +
            `      ${String(e).slice(0, 200)}\n` +
            `      Make sure the project has @playwright/test installed:\n` +
            `      cd ${projectDir} && npm install\n\n`,
        ));
        return { states: [], success: false, failedAt: 'inspector start' };
    }
 
    const states: DiscoveredState[] = [];
    const stateByPlanId = new Map<string, DiscoveredState>();
    let planStateIdx = 0;
 
    const currentPlanState = () => plan.pageStates[planStateIdx];
 
    // Capture the current page as a DiscoveredState
    const capture = async (
        pageStateId: string,
        screenName: string,
        detectedBy: DiscoveredState['detectedBy'],
    ): Promise<DiscoveredState> => {
        const shotPath = `${outputDir}/${pageStateId}-${ts()}.png`;
        await session.screenshot(shotPath).catch(() => {});
 
        const snap = await session.snapshot();
        const elements = snap.elements.map(toElementInfo);
 
        const interactive = elements.filter(e => e.kind === 'interactive');
        const outputs     = elements.filter(e => e.kind === 'output');
 
        Deno.stdout.writeSync(enc.encode(
            `\n  ${cyan('📸')}  [${pageStateId}] ${screenName} (${detectedBy})\n` +
            `      URL: ${snap.url}\n` +
            `      ${interactive.length} interactive, ${outputs.length} output\n` +
            `      Screenshot: ${shotPath}\n`,
        ));
 
        const state: DiscoveredState = {
            pageStateId,
            screenName,
            url: snap.url,
            elements,
            screenshotPath: shotPath,
            assertionResults: [],
            detectedBy,
        };
 
        states.push(state);
        stateByPlanId.set(pageStateId, state);
        return state;
    };
 
    // Re-discover the current page and update the existing state
    const recapture = async (state: DiscoveredState): Promise<void> => {
        Deno.stdout.writeSync(enc.encode(
            `      ${cyan('🔄')}  Re-discovering ${state.screenName}...\n`,
        ));
        const shotPath = `${outputDir}/${state.pageStateId}-updated-${ts()}.png`;
        await session.screenshot(shotPath).catch(() => {});
 
        const snap = await session.snapshot();
        const freshElements = snap.elements.map(toElementInfo);
 
        state.elements = freshElements;
        state.screenshotPath = shotPath;
 
        const interactive = freshElements.filter(e => e.kind === 'interactive');
        const outputs     = freshElements.filter(e => e.kind === 'output');
 
        Deno.stdout.writeSync(enc.encode(
            `      ${cyan('📸')}  [${state.pageStateId}] ${state.screenName} — ` +
            `${interactive.length} interactive, ${outputs.length} output\n` +
            `      Screenshot: ${shotPath}\n`,
        ));
    };
 
    try {
        // Current snapshot state (cached between steps)
        let currentElements: SnapElement[] = [];
        let pendingRef: string | null = null; 

        for (let i = 0; i < plan.steps.length; i++) {
            const step = plan.steps[i];
            const label = `step ${i + 1}/${plan.steps.length}: ${step.kind}` +
                ('hint' in step && step.hint ? ` "${step.hint}"` : '') +
                ('value' in step && step.value ? ` = "${step.value}"` : '') +
                ('expected' in step && step.expected ? ` "${step.expected}"` : '');
 
            Deno.stdout.writeSync(enc.encode(`      ${yellow('→')} ${label}\n`));
 
            // ── waitForSelector ───────────────────────────────────────
            if (step.kind === 'waitForSelector') {
                const timeout = step.timeout ?? 10_000;
                const start = Date.now();
                let found = false; 

                while (Date.now() - start < timeout) {
                    const snap = await session.snapshot();
                    currentElements = snap.elements;
                    const ref = session.findRef(currentElements, step.hint, 'textbox')
                        ?? session.findRef(currentElements, step.hint, 'button')
                        ?? session.findRef(currentElements, step.hint, 'link')
                        ?? session.findRef(currentElements, step.hint);

                    if (ref) {
                        pendingRef = ref; 
                        found = true; 
                        Deno.stdout.writeSync(enc.encode(
                            `      ${green('👁')}  Found: "${step.hint}" (ref: ${ref})\n`,
                        ));
                        break;
                    }
                    await session.wait(500);
                }

                if (!found) {
                    Deno.stdout.writeSync(enc.encode(
                        `      ${yellow('⚠️')}  waitForSelector timeout: "${step.hint}"\n`,
                    ));    
                }
                continue;
            }
            // ── navigate ──────────────────────────────────────────────
            if (step.kind === 'navigate') {
                try {
                    await session.goto(startUrl);
                } catch (e) {
                    const msg = String(e);
                    Deno.stdout.writeSync(enc.encode(
                        `\n  ${red('❌')}  Cannot reach ${startUrl}\n` +
                        `      ${msg.slice(0, 200)}\n\n`,
                    ));
                    await session.quit();
                    return { states, success: false, failedAt: `navigate to ${startUrl}` };
                }
                await session.wait(500);
                const ps = currentPlanState();
                const state = await capture(ps.id, ps.screenName, 'navigate');
                const snap = await session.snapshot();
                currentElements = snap.elements;
                continue;
            }
 
            // ── fill ──────────────────────────────────────────────────
            if (step.kind === 'fill') {
                let ref = pendingRef;
                pendingRef = null;

                if (!ref) {
                    // Refresh snapshot to get current refs
                    const snap = await session.snapshot();
                    currentElements = snap.elements;
                    ref = session.findRef(currentElements, step.hint ?? '', 'textbox') 
                        ?? session.findRef(currentElements, step.hint ?? '');

                }

                if (ref) {
                    const el = currentElements.find(e => e.ref === ref);
                    const isRealInput = 
                        el?.role === 'textbox' ||
                        el?.role === 'searchbox' ||
                        el?.role === 'combobox';

                    if (!isRealInput) {
                        // ── Modal-Pattern ─────────────────────────────
                        // Element sieht aus wie eine Suche (hint passt),
                        // ist aber ein Button der ein Modal öffnet.
                        Deno.stdout.writeSync(enc.encode(
                            `      ${yellow('→')}  "${step.hint}" ist kein Input (${el?.role ?? 'unknown'}) — klicke zum Öffnen...\n`,
                        ));

                        await session.click(ref).catch(() => {});
                        await session.wait(600);

                        // Frischer Snapshot nach Modal-Öffnung
                        const modalSnap = await session.snapshot();
                        currentElements = modalSnap.elements;
                        // Erst mit Hint suchen, dann erstes verfügbares textbox als Fallback
                        ref = session.findRef(currentElements, step.hint, 'textbox')
                            ?? session.findRef(currentElements, '',         'textbox');
                        
                        if (ref) {
                            Deno.stdout.writeSync(enc.encode(
                                `      ${green('✓')}  Modal geöffnet — echtes Input gefunden\n`,
                            ));
                        } else {
                            Deno.stdout.writeSync(enc.encode(
                                `      ${yellow('⚠️')}  Kein Input nach Modal-Klick für "${step.hint}"\n`,
                            ));
                            continue;
                        }
                    }
                }

                if (ref) {
                    await session.fill(ref, step.value ?? '').catch(e =>
                        Deno.stdout.writeSync(enc.encode(
                            `      ${yellow('⚠️')}  fill failed: ${String(e).slice(0, 80)}\n`,
                        )),
                    );
                } else {
                    Deno.stdout.writeSync(enc.encode(
                        `      ${yellow('⚠️')}  no element for hint "${step.hint}"\n`,
                    ));
                }
                continue;
            }
 
                // ── click ─────────────────────────────────────────────────
    if (step.kind === 'click') {
        let ref = pendingRef;
        pendingRef = null;
 
        const snap = await session.snapshot();
        currentElements = snap.elements;
        const urlBefore = snap.url;
 
        if (!ref) {
            ref = session.findRef(currentElements, step.hint, 'button')
               ?? session.findRef(currentElements, step.hint, 'link')
               ?? session.findRef(currentElements, step.hint);
        }
 
        if (!ref) {
            Deno.stdout.writeSync(enc.encode(
                `      ${yellow('⚠️')}  no element for hint "${step.hint}"\n`,
            ));
            continue;
        }
 
        await session.click(ref).catch(e =>
            Deno.stdout.writeSync(enc.encode(
                `      ${yellow('⚠️')}  click failed: ${String(e).slice(0, 80)}\n`,
            )),
        );
 
        await session.wait(1200);
        const urlAfter = await session.url();
 
        if (urlAfter !== urlBefore) {
            const nextPlanState = plan.pageStates[planStateIdx + 1];
            if (nextPlanState) {
                planStateIdx++;
                await capture(nextPlanState.id, nextPlanState.screenName, 'url-change');
            } else {
                const autoId   = `page-${states.length + 1}`;
                const autoName = `Page${states.length + 1}Screen`;
                await capture(autoId, autoName, 'url-change');
            }
        } else {
            const currentState = states[states.length - 1];
            if (currentState) await recapture(currentState);
        }
 
        const newSnap = await session.snapshot();
        currentElements = newSnap.elements;
        continue;
    }
 
            // ── wait ──────────────────────────────────────────────────
            if (step.kind === 'wait') {
                Deno.stdout.writeSync(enc.encode(`      ⏳  Waiting for content...\n`));
                // Poll for content changes (up to 8s)
                const snapBefore = await session.snapshot();
                const countBefore = snapBefore.elements.length;
 
                for (let w = 0; w < 16; w++) {
                    await session.wait(500);
                    const snap = await session.snapshot();
                    if (snap.elements.length !== countBefore) {
                        currentElements = snap.elements;
                        break;
                    }
                }
 
                // Re-discover after wait
                const currentState = states[states.length - 1];
                if (currentState) await recapture(currentState);
                const fresh = await session.snapshot();
                currentElements = fresh.elements;
                continue;
            }
 
            // ── assert ────────────────────────────────────────────────
            if (step.kind === 'assert') {
                const snap = await session.snapshot();
                currentElements = snap.elements;
 
                // deno-lint-ignore no-explicit-any
                const targetState = stateByPlanId.get((step as any).pageStateId)
                    ?? states[states.length - 1];
                if (!targetState) continue;
 
                // deno-lint-ignore no-explicit-any
                if ((step as any).assertionKind === 'text' && (step as any).assertionValue) {
                    // Check via DOM eval — most reliable
                    // deno-lint-ignore no-explicit-any
                    const text = (step as any).assertionValue;
                    const found = await session.eval(
                        `document.body.textContent.includes(${JSON.stringify(text)})`,
                    ).then(r => r === 'true').catch(() => false);
 
                    // Find best matching Screen prop
                    const tl = text.toLowerCase();
                    let bestProp: string | undefined;
                    let bestScore = 0;
                    for (const el of targetState.elements) {
                        const nl = el.name.toLowerCase();
                        let score = 0;
                        for (let k = 0; k <= nl.length - 3; k++) {
                            if (tl.includes(nl.slice(k, k + 3))) score++;
                        }
                        score += nl.length * 0.1;
                        if (score > bestScore) { bestScore = score; bestProp = el.propName; }
                    }
 
                    const locator = bestProp
                        ? `${targetState.screenName}.${bestProp}`
                        : `page.getByText(${JSON.stringify(text)})`;
 
                    // deno-lint-ignore no-explicit-any
                    (targetState as any).assertionResults.push({
                        asserionKind: 'text',
                        assertionValue: text,
                        passed: found,
                        locator,
                        machtedPropName: bestProp,
                        note: found ? `✅ Text found: "${text}"` : `⚠️  Text NOT found: "${text}"`,
                    });
 
                    Deno.stdout.writeSync(enc.encode(
                        `      ${found ? green('✅') : yellow('⚠️')}  ` +
                        `"${text}": ${found ? 'FOUND' : 'NOT FOUND'}\n`,
                    ));
 
                } else if ((step as any).assertionKind === 'visible' && step.hint) {
                    const ref = session.findRef(currentElements, step.hint);
                    const el  = ref ? currentElements.find(e => e.ref === ref) : null;
                    const locator = el
                        ? `${targetState.screenName}.${el.propName}`
                        : `page.getByText(${JSON.stringify(step.hint)})`;
 
                    // deno-lint-ignore no-explicit-any
                    (targetState as any).assertionResults.push({
                        asserionKind: 'visible',
                        passed: !!ref,
                        locator,
                        machtedPropName: el?.propName,
                        note: ref ? `✅ Visible: "${step.hint}"` : `⚠️  Not found: "${step.hint}"`,
                    });
 
                } else if ((step as any).assertionKind === 'url' && (step as any).assertionValue) {
                    const currentUrl = await session.url();
                    // deno-lint-ignore no-explicit-any
                    const found = currentUrl.includes((step as any).assertionValue);
                    // deno-lint-ignore no-explicit-any
                    (targetState as any).assertionResults.push({
                        asserionKind: 'url',
                        assertionValue: (step as any).assertionValue,
                        passed: found,
                        locator: 'page.url()',
                        note: found ? `✅ URL matches` : `⚠️  URL mismatch (${currentUrl})`,
                    });
                }
                continue;
            }
 
            // ── screenshot ────────────────────────────────────────────
            if (step.kind === 'screenshot') {
                const shotPath = `${outputDir}/manual-${ts()}.png`;
                await session.screenshot(shotPath).catch(() => {});
                Deno.stdout.writeSync(enc.encode(`      📷  ${shotPath}\n`));
                continue;
            }
        }
 
        // ── Final snapshot of last page ───────────────────────────────
        Deno.stdout.writeSync(enc.encode(`\n  🔄  Final snapshot...\n`));
        const lastState = states[states.length - 1];
        if (lastState) await recapture(lastState);
 
        await session.quit();
 
        // ── Summary ───────────────────────────────────────────────────
        Deno.stdout.writeSync(enc.encode(
            `\n  ${cyan('✅')}  Walk complete: ${states.length} page state(s)\n`,
        ));
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
        await session.quit().catch(() => {});
        Deno.stdout.writeSync(enc.encode(
            `\n  ${red('❌')}  walkFlow crashed: ${String(err).slice(0, 200)}\n\n`,
        ));
        return { states: [], success: false, failedAt: String(err) };
    }
}
