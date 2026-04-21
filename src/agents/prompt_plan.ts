import type { AnalystPlan, PageState, PlanStep } from './analyst.ts';

function toTitle(value: string): string {
    return value
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

function stripTrailingGenerationHints(value: string): string {
    return value
        .replace(/\s+and generate .*$/i, '')
        .replace(/\s+mit video.*$/i, '')
        .replace(/\s+with video.*$/i, '')
        .trim();
}

export function normalizeUrl(candidate: string): string | null {
    const trimmed = candidate.trim().replace(/[),.!?]+$/g, '');
    if (!trimmed) return null;

    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

    try {
        return new URL(normalized).toString();
    } catch {
        return null;
    }
}

export function extractBaseUrlFromPrompt(prompt: string): string | null {
    const urlMatch = prompt.match(/https?:\/\/[^\s),]+/i);
    if (urlMatch) {
        return normalizeUrl(urlMatch[0]);
    }

    const openMatch = prompt.match(/\b(?:open|goto|go to|öffne)\s+([a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s),]*)?)/i);
    if (openMatch) {
        return normalizeUrl(openMatch[1]);
    }

    const domainMatch = prompt.match(/\b([a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s),]*)?)\b/i);
    return domainMatch ? normalizeUrl(domainMatch[1]) : null;
}

function extractSegments(prompt: string): string[] {
    return prompt
        .replace(/\n+/g, ' ')
        .replace(/^using the playwright cli skill,?\s*/i, '')
        .split(/,(?![^'"]*['"])/)
        .flatMap((segment) => segment.split(/\b(?:and then|then)\b/i))
        .map((segment) => segment.trim())
        .filter(Boolean);
}

function createPageState(index: number, label: string): PageState {
    return {
        id: `state_${index + 1}`,
        screenName: toTitle(label || `Step ${index + 1}`),
    };
}

function ensureFinalAssertion(steps: PlanStep[], finalClickHint: string | null): void {
    const hasAssertion = steps.some((step) => step.kind === 'assert');
    if (hasAssertion || !finalClickHint) return;

    steps.push({
        kind: 'assert',
        hint: finalClickHint,
        condition: 'text',
        expected: finalClickHint,
        description: `Check that "${finalClickHint}" is visible`,
    });
}

export function buildPromptPlan(prompt: string, baseUrl: string): AnalystPlan {
    const steps: PlanStep[] = [];
    const pageStates: PageState[] = [createPageState(0, 'Start Page')];
    let pageStateIndex = 1;
    let finalClickHint: string | null = null;

    steps.push({
        kind: 'navigate',
        url: baseUrl,
        description: 'Open the requested page',
    });
    steps.push({ kind: 'wait', ms: 1000 });

    for (const segment of extractSegments(prompt)) {
        const cleanSegment = stripTrailingGenerationHints(segment);
        if (!cleanSegment) continue;

        const fillMatch = cleanSegment.match(/fill(?: in)?\s+(.+?)\s+['"]([^'"]+)['"]/i);
        if (fillMatch) {
            const hint = fillMatch[1].replace(/^the\s+/i, '').trim();
            const value = fillMatch[2].trim();
            steps.push({ kind: 'waitForSelector', hint, timeout: 10000 });
            steps.push({ kind: 'fill', hint, value, description: `Fill ${hint}` });
            continue;
        }

        const visibleMatch = cleanSegment.match(/check if (?:the )?text\s+['"]([^'"]+)['"]\s+is visible/i);
        if (visibleMatch) {
            const expected = visibleMatch[1].trim();
            steps.push({
                kind: 'assert',
                hint: expected,
                condition: 'text',
                expected,
                description: `Verify "${expected}" is visible`,
            });
            continue;
        }

        const clickMatch = cleanSegment.match(/click(?: on)?\s+(.+)/i);
        if (clickMatch) {
            const hint = clickMatch[1]
                .replace(/^the\s+/i, '')
                .replace(/\bmenu\b/i, 'menu')
                .trim();
            if (hint) {
                steps.push({ kind: 'waitForSelector', hint, timeout: 10000 });
                steps.push({ kind: 'click', hint, description: `Click ${hint}` });
                pageStates.push(createPageState(pageStateIndex++, hint));
                finalClickHint = hint;
            }
            continue;
        }
    }

    ensureFinalAssertion(steps, finalClickHint);

    return {
        goal: prompt,
        summary: `Navigate through the requested flow on ${baseUrl} and capture a reusable Playwright test.`,
        pageStates,
        steps,
    };
}
