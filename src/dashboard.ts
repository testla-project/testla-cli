#!/usr/bin/env -S deno run --allow-read
import { colors } from '@cliffy/ansi/colors';
import { 
    loadStateFile, 
    getStateFilePath, 
    type TestlaRunState,
    type PipelineStep,
    type LogEntry,
    type AgentStatus,
    type LogLevel,
} from './utils/state.ts';

/**
 * Live Dashboard - Shows current pipeline status
 * Run in a separate terminal:
 *   deno run --allow-read src/dashboard.ts
 */

const STATUS_ICONS: Record<string, string> = {
    pending: colors.dim('◯'),
    running: colors.blue('◉'),
    success: colors.green('✓'),
    failed: colors.red('✗'),
    skipped: colors.gray('⊘'),
};

const AGENT_COLORS: Record<string, (s: string) => string> = {
    Orchestrator: colors.magenta,
    ProjectSetup: colors.yellow,
    Analyst: colors.blue,
    Explorer: colors.cyan,
    CodeWriter: colors.white,
    Runner: colors.green,
    Verdict: colors.yellow,
    Lens: colors.cyan,
};

function renderPipeline(): void {
    try {
        const state = getState();

        console.clear();
        console.log(colors.bold(colors.cyan('\n 📊 TESTLA PIPELINE STATUS\n')));
        console.log(colors.dim(`Run ID: ${state.runId}`));
        console.log(colors.dim(`Status: ${state.status.toUpperCase()}\n`));

        // Pipeline Steps
        console.log(colors.bold('Pipeline Steps:'));
        for (const step of state.pipeline) {
            const icon = STATUS_ICONS[step.status] || '?';
            const colorFn = AGENT_COLORS[step.agent] || colors.gray;
            const agentTag = colorFn(` ${step.agent.padEnd(14)} `);
            const detail = step.detail ? colors.dim(` → ${step.detail}`) : '';
            const duration = step.durationMs ? colors.gray(` (${step.durationMs}ms)`) : '';

            console.log(`  ${icon} ${agentTag} ${step.label}${detail}${duration}`);
        }

        // Recent Logs
        console.log(colors.bold('\n 📝 Recent Logs (last 8):\n'));
        const recentLogs = state.logs.slice(-8);
        for (const log of recentLogs) {
            const date = new Date(log.ts);
            const time = colors.dim(date.toLocaleTimeString());
            const agentTag = AGENT_COLORS[log.agent]
                ? AGENT_COLORS[log.agent](` ${log.agent.padEnd(14)} `)
                : ` ${log.agent.padEnd(14)} `;

            const levelIcon: Record<string, string> = {
                info: colors.blue('·'),
                success: colors.green('✓'),
                warn: colors.yellow('⚠'),
                error: colors.red('✗'),
                debug: colors.gray('○'),
            };

            console.log(`${time} ${agentTag} ${levelIcon[log.level]} ${log.msg}`);
        }

        console.log(colors.dim(`\n State File: ${getStateFilePath()}`));
        console.log(colors.dim(`\n Refreshing every 500ms... (Press Ctrl+C to stop)`));
    } catch (error) {
        console.error(colors.red(`Error: ${error.message}`));
    }
}

// Watch mode - refresh every 500ms
async function watch(): Promise<void> {
    let lastContent = '';

    while (true) {
        try {
            const state = getState();
            const currentContent = JSON.stringify(state);

            if (currentContent !== lastContent) {
                renderPipeline();
                lastContent = currentContent;
            }
        } catch {
            // State not initialized yet
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
    }
}

if (import.meta.main) {
    console.log(colors.yellow('Starting Dashboard...\n'));
    watch();
}
