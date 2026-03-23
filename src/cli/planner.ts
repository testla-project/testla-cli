// ─────────────────────────────────────────────────────────────────────────────
// testla-cli · src/cli/planner.ts
//
// Two LLM calls:
//
//   1. planTask()     → FlowPlan (page states + ordered steps, no element names)
//   2. resolveTargets() → fill in target propNames from discovered elements
//
// The LLM never sees file paths, project dirs, or TypeScript.
// ─────────────────────────────────────────────────────────────────────────────

import type { LLMProvider } from '../llm/types.ts';

// ── Types ─────────────────────────────────────────────────────────────────

export type StepKind = 'navigate' | 'fill' | 'click' | 'wait' | 'assert' | 'screenshot';
export type AssertionKind = 'text' | 'visible' | 'url';

export interface FlowStep {
    pageStateId: string;
    kind: StepKind;
    // fill / click / assert(visible)
    hint?: string;              // describes the element in plain language
    target?: string;            // resolved propName after discovery
    // fill
    value?: string;
    // assert
    assertionKind?: AssertionKind;
    assertionValue?: string;    // exact text or URL fragment
}

export interface PageState {
    id: string;           // kebab, e.g. "login", "secure-area"
    screenName: string;   // PascalCase, e.g. "LoginScreen"
    description: string;
}

export interface FlowPlan {
    taskName: string;
    describeLabel: string;
    pageStates: PageState[];
    steps: FlowStep[];
}

// ── planTask ──────────────────────────────────────────────────────────────

const PLAN_SYSTEM = `You are a test flow planner for Playwright + testla-screenplay.

Analyze the task and return a FlowPlan as strict JSON. No markdown, no explanation.

Rules for pageStates:
- One entry per distinct page/route the user visits
- A new pageState begins only when a click causes a full navigation (new URL)
- Same-page dynamic updates (content changes, dropdowns, etc.) stay in the same pageState

Rules for steps:
- "navigate"   → always the first step, no hint needed
- "fill"       → add hint (e.g. "username input"), add value (exact text to type)
- "click"      → add hint (e.g. "login button") — the browser auto-detects if navigation follows
- "assert"     → placed immediately after the action it validates
    - kind "text"    → assertionValue = exact visible text to find
    - kind "visible" → hint = which element should be visible
    - kind "url"     → assertionValue = URL substring to check
- "screenshot" → optional, after key interactions
- "wait"       → only if task explicitly says to wait

Do NOT invent element propNames — leave target as null everywhere.
Use plain-language hints only.

Example for "login then verify message":
{
  "taskName": "LoginTask",
  "describeLabel": "Login at the-internet",
  "pageStates": [
    { "id": "login", "screenName": "LoginScreen", "description": "Login form" },
    { "id": "secure", "screenName": "SecureAreaScreen", "description": "Post-login page" }
  ],
  "steps": [
    { "pageStateId": "login",  "kind": "navigate" },
    { "pageStateId": "login",  "kind": "fill",   "hint": "username input",  "value": "tomsmith" },
    { "pageStateId": "login",  "kind": "fill",   "hint": "password input",  "value": "SuperSecretPassword!" },
    { "pageStateId": "login",  "kind": "click",  "hint": "login button" },
    { "pageStateId": "secure", "kind": "assert", "assertionKind": "text",   "assertionValue": "You logged into a secure area!" },
    { "pageStateId": "secure", "kind": "screenshot" }
  ]
}`;

export async function planTask(
    provider: LLMProvider,
    task: string,
    url: string,
    featureName: string,
): Promise<FlowPlan | null> {
    let response;
    try {
        response = await provider.chat([
            { role: 'system', content: PLAN_SYSTEM },
            { role: 'user', content: `Task: ${task}\nStart URL: ${url}\nFeature: ${featureName}\n\nReturn FlowPlan JSON.` },
        ], []);
    } catch (err) {
        console.error('planTask failed:', err);
        return null;
    }

    const raw = (response.content ?? '').trim()
        .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

    try {
        return JSON.parse(raw) as FlowPlan;
    } catch {
        console.error('planTask: invalid JSON\n', raw.slice(0, 400));
        return null;
    }
}

// ── resolveTargets ────────────────────────────────────────────────────────

export interface DiscoveredPageState {
    id: string;
    elements: Array<{ propName: string; role: string; name: string }>;
}

const RESOLVE_SYSTEM = `Match plain-language hints to element propNames.
Use ONLY propNames from the provided element lists. Never invent names.
Return ONLY JSON: { "targets": { "0": "PROP_NAME_OR_NULL", ... } }`;

export async function resolveTargets(
    provider: LLMProvider,
    plan: FlowPlan,
    discovered: DiscoveredPageState[],
): Promise<FlowPlan> {
    // Only steps that need a target and don't have one yet
    const toResolve = plan.steps
        .map((s, i) => ({ s, i }))
        .filter(({ s }) =>
            (s.kind === 'fill' || s.kind === 'click' ||
            (s.kind === 'assert' && s.assertionKind === 'visible')) &&
            !s.target && s.hint,
        );

    if (toResolve.length === 0) return plan;

    const elementContext = discovered
        .map(d => {
            const list = d.elements.length
                ? d.elements.map(e => `  - ${e.propName} (${e.role}: "${e.name}")`).join('\n')
                : '  (no elements found)';
            return `Page "${d.id}":\n${list}`;
        }).join('\n\n');

    const stepsText = toResolve
        .map(({ s }, n) =>
            `${n}: ${s.kind} on page "${s.pageStateId}" — hint: "${s.hint}"` +
            (s.value ? ` value: "${s.value}"` : ''),
        ).join('\n');

    let response;
    try {
        response = await provider.chat([
            { role: 'system', content: RESOLVE_SYSTEM },
            { role: 'user', content: `Elements:\n${elementContext}\n\nSteps to resolve:\n${stepsText}` },
        ], []);
    } catch {
        return plan; // unresolved is better than crash
    }

    const raw = (response.content ?? '').trim()
        .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

    try {
        const { targets } = JSON.parse(raw) as { targets: Record<string, string | null> };
        const steps = [...plan.steps];
        toResolve.forEach(({ i }, n) => {
            const t = targets[String(n)];
            if (t) steps[i] = { ...steps[i], target: t };
        });
        return { ...plan, steps };
    } catch {
        return plan;
    }
}