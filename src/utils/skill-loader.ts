import { join } from 'node:path';
const readTextFile = Deno.readTextFile;

/**
 * SkillLoader handles loading skills and their reference files.
 * Provides the implementation of the `read_skill` tool to the LLM agent.
 */
export class SkillLoader {
  private readonly baseDir: string;

  constructor(projectDir: string) {
    this.baseDir = join(projectDir, '.agents', 'skills');
  }

  /**
   * Reads the content of a skill document or one of its references.
   * Path is relative to .agents/skills/playwright-cli/
   */
  async readSkill(ref: string): Promise<string> {
    // Basic sanitization
    const safeRef = ref.replace(/\.\./g, '');
    const path = join(this.baseDir, 'playwright-cli', safeRef.endsWith('.md') ? safeRef : `${safeRef}.md`);
    try {
      return await readTextFile(path);
    } catch (e) {
      return `Error: Could not read skill reference "${ref}" at ${path}. ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /**
   * Returns the definition of the read_skill tool for the LLM.
   */
  getReadSkillToolDefinition() {
    return {
      name: 'read_skill',
      description: 'Read detailed documentation for a specific Testla skill or reference topic.',
      input_schema: {
        type: 'object' as const,
        properties: {
          ref: {
            type: 'string',
            description: 'Topic to read (e.g., "SKILL", "screen-generation", "playwright-cli").',
          },
        },
        required: ['ref'],
      },
    };
  }
}
