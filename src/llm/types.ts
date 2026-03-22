// ─────────────────────────────────────────────────────────────
// testla-cli · src/llm/types.ts
// Shared interfaces for all LLM providers
// ─────────────────────────────────────────────────────────────

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
    role: MessageRole;
    content: string;
    /** For tool result messages */
    tool_call_id?: string;
    /** For assistant messages that call tools */
    tool_calls?: ToolCall[];
}

export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string; // JSON string
    };
}

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}

export interface LLMResponse {
    content: string | null;
    tool_calls?: ToolCall[];
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'error';
    model?: string;
}

export interface LLMStreamChunk {
    delta: string;
    done: boolean;
}

export interface LLMProvider {
    readonly name: string;
    readonly model: string;
    chat(messages: Message[], tools?: ToolDefinition[]): Promise<LLMResponse>;
    stream?(messages: Message[], onChunk: (chunk: LLMStreamChunk) => void): Promise<void>;
    listModels?(): Promise<string[]>;
    healthCheck?(): Promise<boolean>;
}

export type ProviderName = 'ollama' | 'openai' | 'anthropic' | 'gemini';

export interface ProviderConfig {
    provider: ProviderName;
    model: string;
    apiKey?: string;
    baseUrl?: string;
}
