// ─────────────────────────────────────────────────────────────
// testla-cli · src/skills/types.ts + registry.ts
// Skills extend the agent with domain-specific tools & prompts
// ─────────────────────────────────────────────────────────────

import type { AgentTool } from '../agent/types.ts';

// ─── Skill definition ────────────────────────────────────────

export interface Skill {
    name: string;
    description: string;
    version: string;
    author?: string;
    /** Additional tools this skill provides */
    tools: AgentTool[];
    /** System prompt additions injected into the agent */
    systemPromptAddition?: string;
    /** Called once when skill is first loaded */
    onLoad?(): Promise<void>;
}

// ─── Skill manifest (skills/*/skill.json) ───────────────────

export interface SkillManifest {
    name: string;
    description: string;
    version: string;
    author?: string;
    entrypoint: string; // path to .ts file relative to skill dir
}

// ─── Registry ────────────────────────────────────────────────

export class SkillRegistry {
    private skills: Map<string, Skill> = new Map();

    register(skill: Skill): void {
        this.skills.set(skill.name, skill);
    }

    get(name: string): Skill | undefined {
        return this.skills.get(name);
    }

    getAll(): Skill[] {
        return Array.from(this.skills.values());
    }

    getAllTools(): AgentTool[] {
        return this.getAll().flatMap((s) => s.tools);
    }

    getSystemPromptAdditions(): string {
        return this.getAll()
            .filter((s) => s.systemPromptAddition)
            .map((s) => `### ${s.name}\n${s.systemPromptAddition}`)
            .join('\n\n');
    }

    async loadFromDirectory(skillsDir: string, enabled: string[]): Promise<void> {
        try {
            for await (const entry of Deno.readDir(skillsDir)) {
                if (!entry.isDirectory) continue;
                if (!enabled.includes(entry.name)) continue;

                const manifestPath = `${skillsDir}/${entry.name}/skill.json`;
                try {
                    const raw = await Deno.readTextFile(manifestPath);
                    const manifest: SkillManifest = JSON.parse(raw);
                    const entrypoint = `${skillsDir}/${entry.name}/${manifest.entrypoint}`;

                    const mod = await import(entrypoint);
                    if (mod.default && typeof mod.default === 'object') {
                        await mod.default.onLoad?.();
                        this.register(mod.default as Skill);
                    }
                } catch (e) {
                    console.warn(`⚠️  Failed to load skill "${entry.name}": ${e}`);
                }
            }
        } catch {
            // skills dir doesn't exist yet — fine
        }
    }
}
