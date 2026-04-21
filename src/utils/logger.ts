import { colors } from '@cliffy/ansi/colors';
import { appendLog, type LogLevel, updateStep } from './state.ts';

// ─── Level Styles mit Colors ──────────────────────────────────────────────────
const LEVEL_STYLE: Record<LogLevel, { icon: string; colorFn: (s: string) => string }> = {
    info: { icon: 'ℹ️', colorFn: colors.blue },
    success: { icon: '✅', colorFn: colors.green },
    warn: { icon: '⚠️', colorFn: colors.yellow },
    error: { icon: '❌', colorFn: colors.red },
    debug: { icon: '⚪', colorFn: colors.gray },
};

// ─── Agent Icons & Farben ─────────────────────────────────────────────────────
const AGENT_ICON: Record<string, string> = {
    Orchestrator: '🎭',
    ProjectSetup: '🏗️',
    Analyst: '🔍',
    Explorer: '🗺️',
    CodeWriter: '✍️',
    Runner: '🏃',
    Verdict: '⚖️',
    Lens: '🔎',
};

const AGENT_COLOR: Record<string, (s: string) => string> = {
    Orchestrator: colors.magenta,
    ProjectSetup: colors.yellow,
    Analyst: colors.blue,
    Explorer: colors.cyan,
    CodeWriter: colors.white,
    Runner: colors.green,
    Verdict: colors.yellow,
    Lens: colors.cyan,
};

/**
 * Logger Klasse für strukturiertes Logging über die gesamte CLI
 * - Agent-spezifische Farben & Emojis
 * - Automatisches State-Tracking
 * - Debug-Mode
 * - Child Logger für Sub-Kontexte
 * - passThrough für beliebige Console-Methoden
 */
export class Logger {
    private debugEnabled: boolean;
    private context: string;

    constructor(context: string, debug = false) {
        this.context = context;
        this.debugEnabled = debug;
    }

    // ─── Private Helpers ───────────────────────────────────────────────────────

    private getTimestamp(): string {
        const now = new Date();
        const h = String(now.getHours()).padStart(2, '0');
        const m = String(now.getMinutes()).padStart(2, '0');
        const s = String(now.getSeconds()).padStart(2, '0');
        return colors.dim(`${h}:${m}:${s}`);
    }

    private getAgentTag(agent: string): string {
        const icon = AGENT_ICON[agent] ?? '🤖';
        const colorFn = AGENT_COLOR[agent] ?? colors.gray;
        const padded = agent.padEnd(12);
        return `${colors.dim('[')}${icon} ${colorFn(colors.bold(padded))}${colors.dim(']')}`;
    }

    private formatLog(agent: string, level: LogLevel, msg: string): string {
        const { icon, colorFn } = LEVEL_STYLE[level];
        const coloredIcon = colorFn(icon);
        return `${this.getTimestamp()} ${this.getAgentTag(agent)} ${coloredIcon} ${msg}`;
    }

    private persistLog(agent: string, level: LogLevel, msg: string): void {
        appendLog({ ts: Date.now(), agent, level, msg }).catch(() => {});
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Log information
     */
    public info(agent: string, msg: string): void {
        const line = this.formatLog(agent, 'info', msg);
        console.log(line);
        this.persistLog(agent, 'info', msg);
    }

    /**
     * Log success
     */
    public success(agent: string, msg: string): void {
        const line = this.formatLog(agent, 'success', msg);
        console.log(line);
        this.persistLog(agent, 'success', msg);
    }

    /**
     * Log warning
     */
    public warn(agent: string, msg: string): void {
        const line = this.formatLog(agent, 'warn', msg);
        console.warn(line);
        this.persistLog(agent, 'warn', msg);
    }

    /**
     * Log error
     */
    public error(agent: string, msg: string): void {
        const line = this.formatLog(agent, 'error', msg);
        console.error(line);
        this.persistLog(agent, 'error', msg);
    }

    /**
     * Log debug (nur wenn debugEnabled)
     */
    public debug(agent: string, msg: string): void {
        if (this.debugEnabled) {
            const line = this.formatLog(agent, 'debug', msg);
            console.log(line);
            this.persistLog(agent, 'debug', msg);
        }
    }

    /**
     * Agent Lifecycle: Gestartet
     */
    public agentStart(agent: string, stepId: string, description?: string): void {
        const label = description ?? agent;
        const icon = AGENT_ICON[agent] ?? '•';
        const colorFn = AGENT_COLOR[agent] ?? colors.white;
        const line = `\n${colors.bold(colorFn(`${icon} ${agent}`))}  ${colors.dim(label)}`;
        console.log(line);
        updateStep(stepId, { status: 'running', startedAt: Date.now() }).catch(() => {});
        this.persistLog(agent, 'info', `▶ Gestartet: ${label}`);
    }

    /**
     * Agent Lifecycle: Beendet
     */
    public agentEnd(
        agent: string,
        stepId: string,
        status: 'success' | 'failed',
        detail?: string,
    ): void {
        const icon = status === 'success' ? colors.green('✓') : colors.red('✗');
        const detailStr = detail ? `  ${colors.dim(detail)}` : '';
        console.log(`${icon} ${colors.bold(agent)} abgeschlossen${detailStr}`);

        updateStep(stepId, {
            status,
            finishedAt: Date.now(),
            detail,
        }).catch(() => {});
        this.persistLog(
            agent,
            status === 'success' ? 'success' : 'error',
            `${status === 'success' ? '✓' : '✗'} Beendet${detail ? `: ${detail}` : ''}`,
        );
    }

    /**
     * Agent Lifecycle: Übersprungen
     */
    public agentSkip(agent: string, stepId: string, reason: string): void {
        console.log(colors.gray(`⊘ ${agent} übersprungen: ${reason}`));
        updateStep(stepId, { status: 'skipped', detail: reason }).catch(() => {});
        this.persistLog(agent, 'warn', `⊘ Übersprungen: ${reason}`);
    }

    /**
     * Create a child logger with a sub-context
     */
    public child(subContext: string): Logger {
        return new Logger(`${this.context}:${subContext}`, this.debugEnabled);
    }

    /**
     * Pass through any method call to console (table, trace, time, timeEnd, group, groupEnd, clear, etc.)
     */
    public passThrough(method: keyof Console, ...args: unknown[]): void {
        // @ts-ignore: Workaround für dynamische console-Methoden
        console[method](...args);
    }

    /**
     * Pretty-print JSON
     */
    public json(...args: unknown[]): void {
        this.passThrough('log', JSON.stringify(args, null, 2));
    }

    /**
     * Visual divider
     */
    public divider(label?: string): void {
        const line = label
            ? `\n${colors.dim(`─────  ${label}  ${`─`.repeat(Math.max(0, 40 - label.length))}`)}\n`
            : `\n${colors.dim(`${`─`.repeat(50)}`)}\n`;
        console.log(line);
    }

    /**
     * Enable or disable debug mode
     */
    public setDebug(enabled: boolean): void {
        this.debugEnabled = enabled;
    }

    /**
     * Get current debug state
     */
    public isDebugEnabled(): boolean {
        return this.debugEnabled;
    }
}

// ─── Default Logger Instance ──────────────────────────────────────────────────

export const logger = new Logger(
    'Testla',
    (() => {
        try {
            return Deno.env.get('TESTLA_DEBUG') === 'true';
        } catch {
            return false;
        }
    })(),
);
