// ─────────────────────────────────────────────────────────────
// testla-cli · src/agent/tools.ts
// Built-in tools: shell, filesystem, git
// ─────────────────────────────────────────────────────────────

import type { AgentTool, ToolInput, ToolResult } from './types.ts';
// discover_page is now called directly via discoverStartPage/discoverResultPage

// ─── Shell ───────────────────────────────────────────────────

export const shellTool: AgentTool = {
    name: 'shell',
    description: 'Execute a shell command in the working directory. Returns stdout and stderr. ' +
        'Use for npm/pnpm/deno commands, running scripts, checking versions, etc.',
    parameters: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'The shell command to execute' },
            cwd: {
                type: 'string',
                description: 'Working directory (optional, defaults to current)',
            },
        },
        required: ['command'],
    },
    async execute(input: ToolInput): Promise<ToolResult> {
        const command = input.command as string;
        const cwd = (input.cwd as string | undefined) ?? Deno.cwd();

        try {
            const proc = new Deno.Command('bash', {
                args: ['-c', command],
                cwd,
                stdout: 'piped',
                stderr: 'piped',
            });

            const { code, stdout, stderr } = await proc.output();
            const out = new TextDecoder().decode(stdout);
            const err = new TextDecoder().decode(stderr);

            const combined = [out, err].filter(Boolean).join('\n').trim();

            return {
                success: code === 0,
                output: combined || `(exit code ${code})`,
                error: code !== 0 ? `Exit code: ${code}` : undefined,
            };
        } catch (e) {
            return { success: false, output: '', error: String(e) };
        }
    },
};

// ─── Read File ───────────────────────────────────────────────

export const readFileTool: AgentTool = {
    name: 'read_file',
    description: 'Read the contents of a file. Returns the file content as text.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Absolute or relative file path' },
        },
        required: ['path'],
    },
    async execute(input: ToolInput): Promise<ToolResult> {
        try {
            const content = await Deno.readTextFile(input.path as string);
            return { success: true, output: content };
        } catch (e) {
            return { success: false, output: '', error: String(e) };
        }
    },
};

// ─── Write File ──────────────────────────────────────────────

export const writeFileTool: AgentTool = {
    name: 'write_file',
    description: 'Write content to a file, creating it and any parent directories if needed.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'File path to write to' },
            content: { type: 'string', description: 'Content to write' },
            append: { type: 'boolean', description: 'If true, append instead of overwrite' },
        },
        required: ['path', 'content'],
    },
    async execute(input: ToolInput): Promise<ToolResult> {
        const path = input.path as string;
        const content = input.content as string;
        const append = input.append as boolean | undefined;

        try {
            const dir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '.';
            if (dir && dir !== '.') await Deno.mkdir(dir, { recursive: true });

            if (append) {
                await Deno.writeTextFile(path, content, { append: true });
            } else {
                await Deno.writeTextFile(path, content);
            }

            return { success: true, output: `File written: ${path}` };
        } catch (e) {
            return { success: false, output: '', error: String(e) };
        }
    },
};

// ─── List Directory ──────────────────────────────────────────

export const listDirTool: AgentTool = {
    name: 'list_dir',
    description: 'List files and directories at a given path.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Directory path (defaults to current dir)' },
            recursive: { type: 'boolean', description: 'List recursively (default: false)' },
        },
        required: [],
    },
    async execute(input: ToolInput): Promise<ToolResult> {
        const path = (input.path as string | undefined) ?? '.';
        const recursive = input.recursive as boolean | undefined;

        try {
            const entries: string[] = [];
            for await (const entry of Deno.readDir(path)) {
                const prefix = entry.isDirectory ? '📁 ' : '📄 ';
                entries.push(`${prefix}${entry.name}`);

                if (recursive && entry.isDirectory) {
                    try {
                        for await (const sub of Deno.readDir(`${path}/${entry.name}`)) {
                            entries.push(
                                `  ${sub.isDirectory ? '📁' : '📄'} ${entry.name}/${sub.name}`,
                            );
                        }
                    } catch { /* skip inaccessible dirs */ }
                }
            }

            return { success: true, output: entries.sort().join('\n') || '(empty directory)' };
        } catch (e) {
            return { success: false, output: '', error: String(e) };
        }
    },
};

// ─── Delete File ─────────────────────────────────────────────

export const deleteFileTool: AgentTool = {
    name: 'delete_file',
    description: 'Delete a file or empty directory.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Path to delete' },
        },
        required: ['path'],
    },
    async execute(input: ToolInput): Promise<ToolResult> {
        try {
            await Deno.remove(input.path as string, { recursive: true });
            return { success: true, output: `Deleted: ${input.path}` };
        } catch (e) {
            return { success: false, output: '', error: String(e) };
        }
    },
};

// ─── Check if we're in a testla project ──────────────────────

export const checkTestlaProjectTool: AgentTool = {
    name: 'check_testla_project',
    description: 'Check if the current directory contains a testla-screenplay-playwright project',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Directory to check (default: current working directory)',
            },
        },
    },
    async execute(input: ToolInput): Promise<ToolResult> {
        const path = (input.path as string | undefined) ?? Deno.cwd();

        try {
            const packageJsonPath = `${path}/package.json`;
            const packageJson = JSON.parse(await Deno.readTextFile(packageJsonPath));

            const hasTestlaDeps = packageJson.dependencies &&
                (packageJson.dependencies['@testla/screenplay-playwright'] ||
                 packageJson.dependencies['testla-screenplay']);

            const hasPlaywrightConfig = await fileExists(`${path}/playwright.config.ts`) ||
                                       await fileExists(`${path}/playwright.config.js`);

            // Some scaffolds use `screenplay/*`, others use `src/screenplay/*`.
            const hasScreenplayStructure = await dirExists(`${path}/screenplay`) ||
                await dirExists(`${path}/src/screenplay`);

            if (hasTestlaDeps && hasPlaywrightConfig && hasScreenplayStructure) {
                return {
                    success: true,
                    output: `✅ Found testla project at ${path}\n` +
                           `   Dependencies: ${Object.keys(packageJson.dependencies).filter(d => d.includes('testla')).join(', ')}\n` +
                           `   Playwright config: ✅\n` +
                           `   Screenplay structure: ✅`
                };
            } else {
                return {
                    success: false,
                    output: `❌ Not a complete testla project at ${path}\n` +
                           `   testla deps: ${hasTestlaDeps ? '✅' : '❌'}\n` +
                           `   Playwright config: ${hasPlaywrightConfig ? '✅' : '❌'}\n` +
                           `   Screenplay structure: ${hasScreenplayStructure ? '✅' : '❌'}`
                };
            }
        } catch {
            return {
                success: false,
                output: `❌ No package.json found at ${path} - not a testla project`
            };
        }
    },
};

// ─── Helper functions ────────────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
    try {
        const stat = await Deno.stat(path);
        return stat.isFile;
    } catch {
        return false;
    }
}

async function dirExists(path: string): Promise<boolean> {
    try {
        const stat = await Deno.stat(path);
        return stat.isDirectory;
    } catch {
        return false;
    }
}

// ─── All built-in tools ──────────────────────────────────────

export const BUILTIN_TOOLS: AgentTool[] = [
    shellTool,
    readFileTool,
    writeFileTool,
    listDirTool,
    deleteFileTool,
    checkTestlaProjectTool,
];