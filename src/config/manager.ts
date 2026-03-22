// ─────────────────────────────────────────────────────────────
// testla-cli · src/config/manager.ts
// Reads and writes ~/.testla/config.json
// ─────────────────────────────────────────────────────────────

import type { ProviderConfig, ProviderName } from '../llm/types.ts';

export interface MCPServerConfig {
    name: string;
    url: string;
    enabled: boolean;
    description?: string;
}

export interface TestlaConfig {
    version: string;
    llm: ProviderConfig;
    mcp: {
        servers: MCPServerConfig[];
    };
    skills: {
        dir: string;
        enabled: string[];
    };
    agent: {
        maxIterations: number;
        confirmShellCommands: boolean;
        workingDirectory?: string;
    };
}

const DEFAULT_CONFIG: TestlaConfig = {
    version: '1',
    llm: {
        provider: 'ollama',
        model: 'llama3.2',
        baseUrl: 'http://localhost:11434',
    },
    mcp: {
        servers: [
            {
                name: 'github',
                url: 'https://mcp.github.com/sse',
                enabled: false,
                description: 'GitHub — repos, PRs, issues',
            },
            {
                name: 'docker',
                url: 'https://mcp.docker.com/sse',
                enabled: false,
                description: 'Docker — containers, images',
            },
        ],
    },
    skills: {
        dir: './skills',
        enabled: ['testla-create', 'testla-lens', 'testla-screenplay'],
    },
    agent: {
        maxIterations: 30,
        confirmShellCommands: true,
    },
};

export class ConfigManager {
    private configDir = '';
    private configPath = '';

    constructor() {
        let home = '.';
        try {
            home = Deno.env.get('HOME') || Deno.env.get('USERPROFILE') || '.';
        } catch {
            // No permission to access env (e.g., in sandboxed environments)
            home = '.';
        }
        this.configDir = `${home}/.testla`;
        this.configPath = `${this.configDir}/config.json`;
    }

    async exists(): Promise<boolean> {
        try {
            await Deno.stat(this.configPath);
            return true;
        } catch {
            return false;
        }
    }

    async load(): Promise<TestlaConfig> {
        if (!(await this.exists())) {
            return structuredClone(DEFAULT_CONFIG);
        }
        const raw = await Deno.readTextFile(this.configPath);
        const config = JSON.parse(raw) as TestlaConfig;
        return migrateConfig(config);
    }

    async save(config: TestlaConfig): Promise<void> {
        await Deno.mkdir(this.configDir, { recursive: true });
        await Deno.writeTextFile(this.configPath, JSON.stringify(config, null, 2));
    }

    async update(partial: Partial<TestlaConfig>): Promise<TestlaConfig> {
        const current = await this.load();
        const updated = deepMerge(current, partial) as TestlaConfig;
        await this.save(updated);
        return updated;
    }

    get path(): string {
        return this.configPath;
    }

    get dir(): string {
        return this.configDir;
    }

    static getDefaultConfig(): TestlaConfig {
        return structuredClone(DEFAULT_CONFIG);
    }

    static getProviderChoices(): Array<{ name: string; value: ProviderName }> {
        return [
            { name: 'Ollama (local, no API key)', value: 'ollama' },
            { name: 'OpenAI (GPT-4o, GPT-4-turbo)', value: 'openai' },
            { name: 'Anthropic (Claude)', value: 'anthropic' },
            { name: 'Google Gemini', value: 'gemini' },
        ];
    }

    static getDefaultModels(): Record<ProviderName, string[]> {
        return {
            ollama: ['llama3.2', 'llama3.1', 'qwen2.5-coder', 'mistral', 'codellama', 'phi3'],
            openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
            anthropic: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
            gemini: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash'],
        };
    }
}

// deno-lint-ignore no-explicit-any
// Strip entries that used to exist but are no longer valid
function migrateConfig(config: TestlaConfig): TestlaConfig {
    // Remove the playwright HTTP server — it was added by mistake in an early version.
    // discover_page now spawns @playwright/mcp as a stdio subprocess directly.
    config.mcp.servers = (config.mcp.servers ?? []).filter(
        (s) => !(s.name === 'playwright' && s.url?.includes('localhost:8931')),
    );
    return config;
}

function deepMerge(target: any, source: any): any {
    if (typeof source !== 'object' || source === null) return source;
    const out = { ...target };
    for (const key of Object.keys(source)) {
        if (typeof source[key] === 'object' && !Array.isArray(source[key])) {
            out[key] = deepMerge(target[key] ?? {}, source[key]);
        } else {
            out[key] = source[key];
        }
    }
    return out;
}