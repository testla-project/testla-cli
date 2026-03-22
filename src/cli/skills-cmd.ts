// @ts-nocheck: Skill command wiring intentionally uses dynamic types for flexibility.
// ─────────────────────────────────────────────────────────────
// testla-cli · src/cli/skills-cmd.ts
// Skill management commands
// ─────────────────────────────────────────────────────────────

import type { Command } from '@cliffy/command';
import { ConfigManager } from '../config/manager.ts';
import { existsSync } from '../utils/fs.ts';

export function registerSkillsCommands(parent: Command<unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown>): void {
    const configManager = new ConfigManager();

    parent
        .command('skills', 'Manage testla skills')
        .command('list', 'List installed skills')
        .option('-a, --all', 'Show all skills, including disabled', { default: false })
        .action(async (options: Record<string, unknown>) => {
            const all = options.all as boolean;
            const config = await configManager.load();
            const skillsDir = config.skills.dir;
            const enabled = new Set(config.skills.enabled);

            const rows: Array<{ name: string; status: string; path: string }> = [];

            if (!(await existsSync(skillsDir))) {
                console.log('No skills directory found:', skillsDir);
                return;
            }

            for await (const entry of Deno.readDir(skillsDir)) {
                if (!entry.isDirectory) continue;
                const name = entry.name;
                const status = enabled.has(name) ? 'enabled' : 'disabled';
                if (!all && status === 'disabled') continue;
                rows.push({ name, status, path: `${skillsDir}/${name}` });
            }

            if (rows.length === 0) {
                console.log(
                    'No skills found. Use `testla skills add` or `testla skills create` to add skills.',
                );
                return;
            }

            console.table(rows);
        })
        .command('enable <skill:string>', 'Enable an installed skill')
        .action(async (opts: Record<string, unknown>) => {
            const skill = opts.skill as string;
            const config = await configManager.load();
            if (!config.skills.enabled.includes(skill)) {
                config.skills.enabled.push(skill);
                await configManager.save(config);
                console.log(`✅ Enabled skill: ${skill}`);
            } else {
                console.log(`Skill already enabled: ${skill}`);
            }
        })
        .command('disable <skill:string>', 'Disable an installed skill')
        .action(async (opts: Record<string, unknown>) => {
            const skill = opts.skill as string;
            const config = await configManager.load();
            config.skills.enabled = config.skills.enabled.filter((s) => s !== skill);
            await configManager.save(config);
            console.log(`✅ Disabled skill: ${skill}`);
        })
        .command('add', 'Add a skill from Git or local path')
        .option('--git <url:string>', 'Git repository URL')
        .option('--path <path:string>', 'Local filesystem path')
        .action(async ({ git, path }) => {
            const config = await configManager.load();
            const skillsDir = config.skills.dir;
            if (!(await existsSync(skillsDir))) {
                await Deno.mkdir(skillsDir, { recursive: true });
            }

            if (!git && !path) {
                console.log('Please provide --git or --path');
                return;
            }

            if (git) {
                console.log('Cloning skill from', git);
                const skillName = git.split('/').pop()?.replace(/\.git$/, '') ?? 'skill';
                const dest = `${skillsDir}/${skillName}`;
                if (await existsSync(dest)) {
                    console.log('Destination already exists:', dest);
                    return;
                }
                type DenoCommandWithStatus = { status: () => Promise<{ success: boolean; code: number }>; };
                const proc = new Deno.Command('git', { args: ['clone', git, dest] }) as unknown as DenoCommandWithStatus;
                const status = await proc.status();
                if (status.success) {
                    console.log('✅ Cloned to', dest);
                    if (!config.skills.enabled.includes(skillName)) {
                        config.skills.enabled.push(skillName);
                        await configManager.save(config);
                    }
                } else {
                    console.error('Git clone failed (exit code', status.code, ')');
                }
                return;
            }

            if (path) {
                console.log('Copying skill from', path);
                const src = path;
                const skillName = src.split('/').pop() ?? 'skill';
                const dest = `${skillsDir}/${skillName}`;
                if (await existsSync(dest)) {
                    console.log('Destination already exists:', dest);
                    return;
                }

                await copyDir(src, dest);
                console.log('✅ Copied to', dest);
                if (!config.skills.enabled.includes(skillName)) {
                    config.skills.enabled.push(skillName);
                    await configManager.save(config);
                }
            }
        })
        .command('create <name:string>', 'Create a new skill scaffold')
        .action(async ({ name }) => {
            const config = await configManager.load();
            const skillsDir = config.skills.dir;
            if (!(await existsSync(skillsDir))) {
                await Deno.mkdir(skillsDir, { recursive: true });
            }

            const skillDir = `${skillsDir}/${name}`;
            if (await existsSync(skillDir)) {
                console.log('Skill already exists:', skillDir);
                return;
            }

            await Deno.mkdir(skillDir, { recursive: true });
            await Deno.writeTextFile(
                `${skillDir}/skill.json`,
                JSON.stringify(
                    {
                        name,
                        description: `Custom skill: ${name}`,
                        version: '0.1.0',
                        entrypoint: 'index.ts',
                    },
                    null,
                    2,
                ),
            );

            await Deno.writeTextFile(
                `${skillDir}/index.ts`,
                `import type { Skill } from '../../src/skills/types.ts';

export default {
  name: '${name}',
  description: 'A custom testla skill',
  version: '0.1.0',
  tools: [
    {
      name: '${name}_run',
      description: 'Sample tool for the ${name} skill',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Input' },
        },
        required: ['input'],
      },
      async execute({ input }) {
        return { success: true, output: 'Echo: ' + input };
      },
    },
  ],
  systemPromptAddition: '\nWhen the user asks about ${name}, consider using ${name}_run.\n',
} satisfies Skill;
`,
            );

            config.skills.enabled.push(name);
            await configManager.save(config);

            console.log('✅ Created new skill at', skillDir);
        });
}

// Utility helpers

async function copyDir(src: string, dest: string): Promise<void> {
    await Deno.mkdir(dest, { recursive: true });
    for await (const entry of Deno.readDir(src)) {
        const srcPath = `${src}/${entry.name}`;
        const destPath = `${dest}/${entry.name}`;
        if (entry.isDirectory) {
            await copyDir(srcPath, destPath);
        } else if (entry.isFile) {
            await Deno.copyFile(srcPath, destPath);
        }
    }
}
