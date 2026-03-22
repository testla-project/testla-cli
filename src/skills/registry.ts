// ─────────────────────────────────────────────────────────────
// testla-cli · src/skills/registry.ts
// Loads and exposes all built-in + external skills
// ─────────────────────────────────────────────────────────────

export { SkillRegistry } from './types.ts';
export type { Skill, SkillManifest } from './types.ts';

import { SkillRegistry } from './types.ts';
import { testlaCreateSkill } from './builtin/testla-create.ts';
import { testlaLensSkill } from './builtin/testla-lens.ts';
import { playwrightScreenplaySkill } from './builtin/playwright-screenplay.ts';

const BUILTIN_SKILLS = [
    testlaCreateSkill,
    testlaLensSkill,
    playwrightScreenplaySkill,
];

/**
 * Create a SkillRegistry pre-loaded with all built-in skills.
 * External skills from the `skills/` directory are loaded separately
 * via registry.loadFromDirectory().
 */
export function createSkillRegistry(enabled: string[]): SkillRegistry {
    const registry = new SkillRegistry();

    for (const skill of BUILTIN_SKILLS) {
        if (enabled.includes(skill.name)) {
            registry.register(skill);
        }
    }

    return registry;
}
