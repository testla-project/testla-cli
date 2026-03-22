// ─────────────────────────────────────────────────────────────
// testla-cli · src/agent/types.ts
// ─────────────────────────────────────────────────────────────

export interface ToolInput {
    [key: string]: unknown;
}

export interface ToolResult {
    success: boolean;
    output: string;
    error?: string;
}

export interface AgentTool {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
    execute(input: ToolInput): Promise<ToolResult>;
}

export interface AgentStep {
    type: 'thought' | 'tool_call' | 'tool_result' | 'final';
    content: string;
    toolName?: string;
    toolInput?: ToolInput;
}

export interface AgentRunOptions {
    task: string;
    workingDir?: string;
    maxIterations?: number;
    confirmShellCommands?: boolean;
    onStep?: (step: AgentStep) => void;
}

export interface AgentRunResult {
    success: boolean;
    answer: string;
    steps: AgentStep[];
    iterations: number;
}
