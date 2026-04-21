import { chromium, type Browser, type BrowserContext, type Page, type Locator } from 'playwright';
import type { AnalystPlan, ToonIntention } from './analyst.ts';
import type { TestlaConfig } from '../config/config.ts';
import { logger } from '../utils/logger.ts';
// import { saveArtifact } from "../utils/persistence.ts";

// ─── Types ────────────────────────────────────────────────────

type ExplorerResult = {
  actions: ExecutedAction[];
  snapshot: SnapshotElement[];
};

export type ActionKind = 'navigate' | 'click' | 'fill' | 'assert' | 'snapshot';

export interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  locatorCode: string;
}

export interface ExecutedAction {
  kind: ActionKind;
  ref?: string;
  value?: string;
  url?: string;
  locatorCode?: string;
  timestamp: number;
}

// ─── LLM Resolver ─────────────────────────────────────────────

async function resolveIntention(
  intention: ToonIntention,
  snapshot: SnapshotElement[],
  config: TestlaConfig,
): Promise<SnapshotElement | null> {
  const snapshotText = snapshot
    .map((e) => `${e.ref}: role=${e.role}, name="${e.name}"`)
    .join('\n');

  const prompt = `
You are a DOM element resolver.
Given a snapshot of interactive elements and a test intention, return the ref of the best matching element.

Intention: ${intention.action} → "${intention.target}"
${intention.value ? `Fill value: "${intention.value}"` : ''}

Snapshot:
${snapshotText}

Respond ONLY with the ref (e.g. "e3"). Nothing else. No explanation.
`;

  const url = `${config.ollama.baseUrl}/api/chat`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollama.model,
      stream: false,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    logger.warn('Explorer', `Resolver HTTP ${response.status} – skipping intention`);
    return null;
  }

  const data = await response.json();
  const ref = data.message?.content?.trim();
  const resolved = snapshot.find((e) => e.ref === ref) ?? null;

  if (!resolved) {
    logger.warn('Explorer', `Resolver returned unknown ref "${ref}" for target "${intention.target}"`);
  } else {
    logger.info('Explorer', `Resolved "${intention.target}" → ${ref} ("${resolved.name}")`);
  }

  return resolved;
}

// ─── Explorer Agent ────────────────────────────────────────────

class ExplorerAgent {
  private browser!: Browser;
  private context!: BrowserContext;
  private page!: Page;

  private actions: ExecutedAction[] = [];
  private currentSnapshot: SnapshotElement[] = [];

  constructor(
    private readonly plan: AnalystPlan,
    private readonly startUrl: string,
    private readonly config: TestlaConfig,
  ) {}

  async run(): Promise<ExplorerResult> {
    await this.setup();

    for (const intention of this.plan.intentions) {
      await this.executeIntention(intention);
    }

    await this.teardown();
    return { actions: this.actions, snapshot: this.currentSnapshot };
  }

  private async setup() {
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
  }

  private async teardown() {
    await this.context.close();
    await this.browser.close();
  }

  // ─── Intention Execution ───────────────────────────────────

  private async executeIntention(intention: ToonIntention) {
    // navigate braucht keinen Snapshot-Lookup
    if (intention.action === 'navigate') {
      await this.navigate(intention.target);
      return;
    }

    // Für alle anderen: frischer Snapshot, dann LLM-Resolve
    await this.snapshot();
    const el = await resolveIntention(intention, this.currentSnapshot, this.config);

    if (!el) {
      logger.warn('Explorer', `Skipping "${intention.action}" on "${intention.target}" – no element resolved`);
      return;
    }

    switch (intention.action) {
      case 'click':  return this.click(el);
      case 'fill':   return this.fill(el, intention.value ?? '');
      case 'assert': return this.assert(el);
    }
  }

  // ─── Actions ──────────────────────────────────────────────

  private async navigate(url: string) {
    await this.page.goto(url);
    this.actions.push({ kind: 'navigate', url, timestamp: Date.now() });
  }

  private async snapshot() {
    const elements = await this.page.evaluate(() => {
      return Array.from(
  // @ts-ignore: runs in browser context
  document.querySelectorAll('a, button, input, textarea, select, [role], h1, h2, h3')
).map((el, i) => {
  // @ts-ignore: runs in browser context
  const htmlEl = el as HTMLElement;
  const tag = htmlEl.tagName.toLowerCase();
  const testId = htmlEl.getAttribute('data-testid');
  const id = htmlEl.id;

  // 1. Verbesserte Namensfindung
  const name = (
    htmlEl.getAttribute('aria-label') || 
    htmlEl.innerText?.trim() || 
    htmlEl.getAttribute('placeholder') || 
    // @ts-ignore: runs in browser context
    (htmlEl as HTMLInputElement).value ||
    ""
  ).replace(/\n/g, ' ').substring(0, 50); // Kürzen für LLM-Übersicht

  const finalName = name || `unnamed_${tag}_${i}`;

  // 2. Sicherer Locator-Generator
  let locatorCode: string;
  if (testId) {
    locatorCode = `page.getByTestId('${testId}')`;
  } else if (tag === 'a' || htmlEl.getAttribute('role') === 'link') {
    locatorCode = `page.getByRole('link', { name: '${finalName.replace(/'/g, "\\'")}', exact: false })`;
  } else if (tag === 'button' || htmlEl.getAttribute('role') === 'button') {
    locatorCode = `page.getByRole('button', { name: '${finalName.replace(/'/g, "\\'")}', exact: false })`;
  } else if (id) {
    // Nur wenn ID wirklich existiert!
    locatorCode = `page.locator('#${id}')`;
  } else {
    // Fallback: Einzigartiger CSS Selector (Tag + Text-Inhalt)
    locatorCode = `page.locator('${tag}').filter({ hasText: '${finalName.replace(/'/g, "\\'")}' }).first()`;
  }

  return { ref: `e${i + 1}`, role: tag, name: finalName, locatorCode };
});
    });

    this.currentSnapshot = elements;
    this.actions.push({ kind: 'snapshot', timestamp: Date.now() });
  }

  private locator(el: SnapshotElement): Locator {
    const page = this.page;
    return eval(el.locatorCode); // locatorCode ist kontrollierter Output aus snapshot()
  }

  private async click(el: SnapshotElement) {
    await this.locator(el).click();
    this.actions.push({ kind: 'click', ref: el.ref, locatorCode: el.locatorCode, timestamp: Date.now() });
  }

  private async fill(el: SnapshotElement, value: string) {
    await this.locator(el).fill(value);
    this.actions.push({ kind: 'fill', ref: el.ref, value, locatorCode: el.locatorCode, timestamp: Date.now() });
  }

  private async assert(el: SnapshotElement) {
    this.actions.push({ kind: 'assert', ref: el.ref, locatorCode: el.locatorCode, timestamp: Date.now() });
  }
}

// ─── Public API ────────────────────────────────────────────────

export async function runPlaywrightCliPlan(
  plan: AnalystPlan,
  startUrl: string,
  config: TestlaConfig,
): Promise<ExplorerResult> {
  const agent = new ExplorerAgent(plan, startUrl, config);
  return agent.run();
}