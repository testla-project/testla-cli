import { ensureDir } from 'https://deno.land/std@0.208.0/fs/mod.ts';
import { join } from 'https://deno.land/std@0.208.0/path/mod.ts';

export interface NovaConfig {
    ollama: {
        baseUrl: string;
        model: string;
    };
}

export const DEFAULTS: NovaConfig = {
    ollama: {
        baseUrl: 'http://localhost:11434',
        model: 'qwen3-coder',
    },
};

function getConfigDir(): string {
    const home = Deno.env.get('HOME') || Deno.env.get('USERPROFILE') || '.';
    return join(home, '.testla');
}

export function getConfigPath(): string {
    return join(getConfigDir(), 'config.json');
}

export async function loadConfig(): Promise<NovaConfig | null> {
    try {
        const path = getConfigPath();
        const content = await Deno.readTextFile(path);
        return JSON.parse(content);
    } catch {
        return null;
    }
}

export async function saveConfig(config: NovaConfig): Promise<void> {
    const dir = getConfigDir();
    const path = getConfigPath();
    await ensureDir(dir);
    await Deno.writeTextFile(path, JSON.stringify(config, null, 2));
}
