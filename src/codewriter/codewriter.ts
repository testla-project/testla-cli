// src/codewriter/codewriter.ts

import { ensureDir } from '@std/fs';
import { join } from '@std/path';
import { ScreenRegistry } from './screen-registry.ts';

export type ExecutedAction = {
  kind: 'navigate' | 'click' | 'fill' | 'assert';
  hint?: string;
  value?: string;
  locatorCode?: string;
};

function pascal(v: string) {
  return v.replace(/[^a-zA-Z0-9]+/g, ' ')
    .split(' ')
    .map(s => s[0].toUpperCase() + s.slice(1))
    .join('');
}

export async function runCodewriter(
  projectDir: string,
  subject: string,
  registry: ScreenRegistry,
  actions: ExecutedAction[],
  assertionConst: string,
  startUrl: string,
) {
  const screensDir = join(projectDir, 'screens');
  const tasksDir = join(projectDir, 'tasks');
  const testsDir = join(projectDir, 'tests');

  await ensureDir(screensDir);
  await ensureDir(tasksDir);
  await ensureDir(testsDir);

  // ── SCREENS ─────────────────────────────────────

  for (const screen of registry.all()) {
    const className = `${pascal(screen.name)}Screen`;

    const lines = [...screen.elements.entries()]
      .map(([k, v]) => `  static ${k}: LazySelector = (page: Page) => ${v};`)
      .join('\n');

    const content = `
import { type Page } from '@playwright/test';
import { type LazySelector } from '@testla/screenplay-playwright';

export class ${className} {
${lines}
}
`;

    await Deno.writeTextFile(join(screensDir, `${screen.name}.screen.ts`), content);
  }

  // ── TASK ───────────────────────────────────────

  const taskName = `${pascal(subject)}Task`;

  const taskLines = actions.map(a => {
    if (a.kind === 'click')
      return `      Click.on(${pascal('Home')}Screen.${assertionConst}),`;
    if (a.kind === 'fill')
      return `      Fill.in(${pascal('Home')}Screen.${assertionConst}, '${a.value}'),`;
    return '';
  }).join('\n');

  const taskContent = `
import { Actor, Task } from '@testla/screenplay-playwright';
import { Click, Fill, Navigate } from '@testla/screenplay-playwright/web';

export class ${taskName} extends Task {
  static from(startUrl: string) {
    return new ${taskName}(startUrl);
  }

  constructor(private startUrl: string) { super(); }

  performAs(actor: Actor) {
    return actor.attemptsTo(
      Navigate.to(this.startUrl),
${taskLines}
    );
  }
}
`;

  await Deno.writeTextFile(join(tasksDir, `${subject}.task.ts`), taskContent);

  // ── TEST ───────────────────────────────────────

  const testContent = `
import { test } from '@playwright/test';
import { Actor } from '@testla/screenplay-playwright';
import { BrowseTheWeb, Element } from '@testla/screenplay-playwright/web';
import { ${taskName} } from '../tasks/${subject}.task';

test('${subject}', async ({ page }) => {
  const Bob = Actor.named('Bob').can(BrowseTheWeb.using(page));
  await Bob.attemptsTo(${taskName}.from('${startUrl}'));
  await Bob.asks(Element.toBe.visible(${pascal('Home')}Screen.${assertionConst}));
});
`;

  await Deno.writeTextFile(join(testsDir, `${subject}.spec.ts`), testContent);
}