import { ScreenRegistry } from './screen-registry.ts';
import { constName, selectorFromSnapshot } from './selector-mapper.ts';

export function mapToScreens(
  registry: ScreenRegistry,
  screenName: string,
  snapshotElements: any[],
  usedRefs: string[],
) {
  const elements = new Map<string, string>();

  for (const ref of usedRefs) {
    const el = snapshotElements.find((e) => e.ref === ref);
    if (!el) continue;

    const constKey = constName(el.name);
    elements.set(constKey, selectorFromSnapshot(el));
  }

  registry.register({ name: screenName, elements });
}