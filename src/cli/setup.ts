// ─────────────────────────────────────────────────────────────
// testla-cli · src/cli/setup.ts
// Interactive setup wizard
// ─────────────────────────────────────────────────────────────

import { Confirm, Input, Select } from 'jsr:@cliffy/prompt';
import { bold, cyan, green, red, yellow } from 'jsr:@std/fmt/colors';
import { ConfigManager } from '../config/manager.ts';
import type { ProviderName } from '../llm/types.ts';

// ── Install @playwright/mcp globally via npm ──────────────────────────────

async function installPlaywrightMcp(): Promise<{ ok: boolean; message: string }> {
    // Check if already available
    try {
        const check = new Deno.Command('npx', {
            args: ['--no', '@playwright/mcp@latest', '--version'],
            stdout: 'piped',
            stderr: 'piped',
        });
        const { code } = await check.output();
        if (code === 0) {
            return { ok: true, message: 'already installed' };
        }
    } catch { /* not found — proceed to install */ }

    console.log(cyan('  ⬇  Installing @playwright/mcp...'));

    try {
        const proc = new Deno.Command('npm', {
            args: ['install', '-g', '@playwright/mcp@latest'],
            stdout: 'inherit',
            stderr: 'inherit',
        });
        const { code } = await proc.output();

        if (code !== 0) {
            // Try npx --yes as fallback (will cache for future use)
            return { ok: true, message: 'will use npx on first run' };
        }

        return { ok: true, message: 'installed globally' };
    } catch (err) {
        return { ok: false, message: String(err) };
    }
}

// ── Verify Playwright browsers are installed ──────────────────────────────

async function checkPlaywrightBrowsers(): Promise<boolean> {
    try {
        const check = new Deno.Command('npx', {
            args: ['playwright', 'install', '--dry-run'],
            stdout: 'piped',
            stderr: 'piped',
        });
        const { code } = await check.output();
        return code === 0;
    } catch {
        return false;
    }
}

// ── Main setup ────────────────────────────────────────────────────────────

export async function runSetup(): Promise<void> {
    const configManager = new ConfigManager();
    const current = await configManager.load();

    console.log('');
    console.log(bold('  testla setup'));
    console.log('  Creates or updates ~/.testla/config.json');
    console.log('');

    // ── 1) Install @playwright/mcp (always, silently if already present) ──
    console.log(cyan('  📦  Playwright MCP (required for page discovery)'));
    const installResult = await installPlaywrightMcp();

    if (installResult.ok) {
        console.log(green(`  ✅  @playwright/mcp — ${installResult.message}`));
    } else {
        console.log(yellow(`  ⚠️   @playwright/mcp could not be installed: ${installResult.message}`));
        console.log(yellow(`       It will be downloaded via npx on first use.`));
    }
    console.log('');

    // ── 2) Check Playwright browsers ──────────────────────────────────────
    const hasBrowsers = await checkPlaywrightBrowsers();
    if (!hasBrowsers) {
        const installBrowsers = await Confirm.prompt({
            message: 'Install Playwright browsers (Chromium, Firefox, WebKit)?',
            default: true,
        });
        if (installBrowsers) {
            console.log(cyan('  ⬇  Installing Playwright browsers...'));
            const proc = new Deno.Command('npx', {
                args: ['playwright', 'install', '--with-deps'],
                stdout: 'inherit',
                stderr: 'inherit',
            });
            const { code } = await proc.output();
            if (code === 0) {
                console.log(green('  ✅  Browsers installed'));
            } else {
                console.log(red('  ❌  Browser install failed — run: npx playwright install'));
            }
            console.log('');
        }
    }

    // ── 3) LLM provider ───────────────────────────────────────────────────
    console.log(cyan('  🤖  LLM Configuration'));
    const providerChoices = ConfigManager.getProviderChoices();
    const provider = (await Select.prompt({
        message: 'LLM provider',
        options: providerChoices.map((p) => ({ name: p.name, value: p.value })),
        default: current.llm.provider,
    })) as ProviderName;

    const defaultModels = ConfigManager.getDefaultModels();
    const model = await Input.prompt({
        message: 'Model',
        default: current.llm.model || (defaultModels[provider]?.[0] ?? ''),
        validate: (v) => v ? true : 'Model is required',
    });

    const baseUrl = await Input.prompt({
        message: 'LLM base URL (leave empty for default)',
        default: current.llm.baseUrl ?? '',
    });

    const apiKey = provider === 'ollama' ? current.llm.apiKey : await Input.prompt({
        message: `API key for ${provider}`,
        default: current.llm.apiKey ?? '',
    });
    console.log('');

    // ── 4) Agent settings ─────────────────────────────────────────────────
    console.log(cyan('  ⚙️   Agent Settings'));
    const skillsDir = await Input.prompt({
        message: 'Skills directory',
        default: current.skills.dir ?? './skills',
    });

    const confirmShell = await Confirm.prompt({
        message: 'Confirm each shell command before executing?',
        default: current.agent.confirmShellCommands ?? true,
    });
    console.log('');

    // ── 5) Optional MCP servers (playwright is always enabled) ───────────
    const optionalServers = current.mcp.servers.filter((s) => s.name !== 'playwright');

    if (optionalServers.length > 0) {
        console.log(cyan('  🔌  Optional MCP servers'));
        for (const server of optionalServers) {
            server.enabled = await Confirm.prompt({
                message: `Enable ${server.name}? (${server.description})`,
                default: server.enabled,
            });
        }
        console.log('');
    }

    // Ensure playwright server is always present and enabled
    const playwrightServer = {
        name: 'playwright',
        url: 'http://localhost:8931',
        enabled: true,
        description: 'Playwright MCP — browser automation & page discovery (required)',
    };

    const finalServers = [
        playwrightServer,
        ...optionalServers,
    ];

    // ── 6) Save ───────────────────────────────────────────────────────────
    await configManager.save({
        ...current,
        llm: {
            provider,
            model,
            baseUrl: baseUrl || current.llm.baseUrl,
            apiKey: apiKey || current.llm.apiKey,
        },
        skills: { ...current.skills, dir: skillsDir },
        agent: { ...current.agent, confirmShellCommands: confirmShell },
        mcp: { servers: finalServers },
    });

    console.log(green('  ✅  Configuration saved to') + '  ' + bold(configManager.path));
    console.log('');
    console.log('  Run ' + bold('testla run "<your task>"') + ' to get started.');
    console.log('');
}