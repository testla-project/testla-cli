import { ensureDir } from '@std/fs';
import { join } from '@std/path';

const STATE_FILE = join(Deno.env.get('HOME') ?? '~', '.testla', 'state.json');

export type AgentStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';
export type RunStatus = 'idle' | 'running' | 'success' | 'failed';
export type LogLevel = 'info' | 'warn' | 'error' | 'success' | 'debug';

export interface PipelineStep {
    id: string;
    label: string;
    agent: string;
    status: AgentStatus;
    startedAt?: number;
    finishedAt?: number;
    durationMs?: number;
    detail?: string; // kurze Statuszeile (z.B. "TC-01, TC-02 erstellt")
    error?: string;
}

export interface LogEntry {
    ts: number;
    agent: string;
    level: LogLevel;
    msg: string;
}

export interface TestlaRunState {
    runId: string;
    startedAt: number;
    finishedAt?: number;
    status: RunStatus;
    input: { type: 'ticket' | 'prompt'; value: string };
    pipeline: PipelineStep[];
    activeAgent?: string;
    logs: LogEntry[]; // Rolling window, max 80 entries
}

const PIPELINE_TEMPLATE: Omit<PipelineStep, 'id' | 'label' | 'agent'>[] = [];

export function buildInitialState(
    input: TestlaRunState['input'],
    includeProjectSetup: boolean,
): TestlaRunState {
    const steps: PipelineStep[] = [
        ...(includeProjectSetup
            ? [{
                id: 'setup',
                label: 'Projekt anlegen',
                agent: 'ProjectSetup',
                status: 'pending' as AgentStatus,
            }]
            : []),
        { id: 'analyst', label: 'Anforderungen analysieren', agent: 'Analyst', status: 'pending' },
        { id: 'explorer', label: 'App erkunden', agent: 'Explorer', status: 'pending' },
        { id: 'writer', label: 'Tests schreiben', agent: 'CodeWriter', status: 'pending' },
        { id: 'runner', label: 'Tests ausführen & debuggen', agent: 'Runner', status: 'pending' },
        { id: 'verdict', label: 'Bug vs. Test-Fehler', agent: 'Verdict', status: 'pending' },
        { id: 'lens', label: 'Test-Qualität prüfen', agent: 'Lens', status: 'pending' },
    ];

    return {
        runId: `run-${Date.now()}`,
        startedAt: Date.now(),
        status: 'running',
        input,
        pipeline: steps,
        activeAgent: undefined,
        logs: [],
    };
}

let _state: TestlaRunState | null = null;

export function getState(): TestlaRunState {
    if (!_state) throw new Error('State not initialized');
    return _state;
}

export async function initState(state: TestlaRunState): Promise<void> {
    _state = state;
    await persist();
}

export async function updateStep(
    id: string,
    patch: Partial<
        Pick<
            PipelineStep,
            'status' | 'detail' | 'error' | 'startedAt' | 'finishedAt' | 'durationMs'
        >
    >,
): Promise<void> {
    const step = _state!.pipeline.find((s) => s.id === id);
    if (!step) return;
    Object.assign(step, patch);
    if (patch.status === 'running') _state!.activeAgent = step.agent;
    if (patch.status === 'success' || patch.status === 'failed') {
        if (_state!.activeAgent === step.agent) _state!.activeAgent = undefined;
    }
    await persist();
}

export async function appendLog(entry: LogEntry): Promise<void> {
    _state!.logs.push(entry);
    if (_state!.logs.length > 80) _state!.logs = _state!.logs.slice(-80);
    await persist();
}

export async function finishRun(status: 'success' | 'failed'): Promise<void> {
    _state!.status = status;
    _state!.finishedAt = Date.now();
    _state!.activeAgent = undefined;
    await persist();
}

async function persist(): Promise<void> {
    await ensureDir(join(Deno.env.get('HOME') ?? '~', '.nova'));
    await Deno.writeTextFile(STATE_FILE, JSON.stringify(_state, null, 2));
}

export async function loadStateFile(): Promise<TestlaRunState | null> {
    try {
        const raw = await Deno.readTextFile(STATE_FILE);
        return JSON.parse(raw) as TestlaRunState;
    } catch {
        return null;
    }
}

export function getStateFilePath(): string {
    return STATE_FILE;
}
