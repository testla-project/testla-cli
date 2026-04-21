import { ensureDir } from '@std/fs';
import { join } from '@std/path';

const CONFIG_DIR = join(Deno.env.get('HOME') ?? '~', '.testla');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface TestlaConfig {
    ollama: {
        baseUrl: string;
        model: string;
    };
    jira?: {
        baseUrl: string;
        email: string;
        token: string;
    };
    app?: {
        baseUrl: string;
    };
}

const DEFAULTS: TestlaConfig = {
    ollama: {
        baseUrl: 'http://localhost:11434',
        model: 'qwen3-coder',
    },
};

export async function loadConfig(): Promise<TestlaConfig | null> {
    try {
        const raw = await Deno.readTextFile(CONFIG_FILE);
        return JSON.parse(raw) as TestlaConfig;
    } catch {
        return null;
    }
}

export async function saveConfig(config: TestlaConfig): Promise<void> {
    await ensureDir(CONFIG_DIR);
    await Deno.writeTextFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function getConfigPath(): string {
    return CONFIG_FILE;
}

export { DEFAULTS };
