export type ScreenDefinition = {
  name: string;
  elements: Map<string, string>; // CONST → locator
};

export class ScreenRegistry {
  private screens = new Map<string, ScreenDefinition>();

  register(screen: ScreenDefinition) {
    const existing = this.screens.get(screen.name);
    if (!existing) {
      this.screens.set(screen.name, screen);
      return;
    }

    for (const [k, v] of screen.elements) {
      if (!existing.elements.has(k)) {
        existing.elements.set(k, v);
      }
    }
  }

  get(name: string): ScreenDefinition {
    const s = this.screens.get(name);
    if (!s) throw new Error(`Screen ${name} not registered`);
    return s;
  }

  all(): ScreenDefinition[] {
    return [...this.screens.values()];
  }
}