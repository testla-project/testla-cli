// ─────────────────────────────────────────────────────────────
// testla-cli · src/llm/ollama.ts
// Ollama provider — local models, no API key needed
// ─────────────────────────────────────────────────────────────

import type { LLMProvider, LLMResponse, LLMStreamChunk, Message, ToolDefinition } from './types.ts';

interface OllamaMessage {
    role: string;
    content: string;
    tool_calls?: Array<{
        function: { name: string; arguments: Record<string, unknown> };
    }>;
    // For tool result messages
    tool_call_id?: string;
}

interface OllamaResponse {
    model: string;
    message: OllamaMessage;
    done: boolean;
    done_reason?: string;
}

interface OllamaModelList {
    models: Array<{ name: string; size: number; modified_at: string }>;
}

export class OllamaProvider implements LLMProvider {
    readonly name = 'ollama';
    readonly model: string;
    private baseUrl: string;

    constructor(model: string, baseUrl = 'http://localhost:11434') {
        this.model = model;
        this.baseUrl = baseUrl.replace(/\/$/, '');
    }

    async chat(messages: Message[], tools?: ToolDefinition[]): Promise<LLMResponse> {
        const ollamaMessages = this.convertMessages(messages);

        const body: Record<string, unknown> = {
            model: this.model,
            messages: ollamaMessages,
            stream: false,
            options: { temperature: 0.2 },
        };

        if (tools && tools.length > 0) {
            body.tools = tools.map((t) => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                },
            }));
        }

        const res = await fetch(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Ollama API error ${res.status}: ${err}`);
        }

        const data: OllamaResponse = await res.json();
        const msg = data.message;

        // Normalize tool calls — Ollama returns arguments as objects, not strings
        const toolCalls = msg.tool_calls?.map((tc, i) => ({
            id: `call_${i}_${Date.now()}`,
            type: 'function' as const,
            function: {
                name: tc.function.name,
                arguments: JSON.stringify(tc.function.arguments),
            },
        }));

        return {
            content: msg.content || null,
            tool_calls: toolCalls,
            finish_reason: toolCalls?.length ? 'tool_calls' : 'stop',
            model: data.model,
        };
    }

    async stream(
        messages: Message[],
        onChunk: (chunk: LLMStreamChunk) => void,
    ): Promise<void> {
        const ollamaMessages = this.convertMessages(messages);

        const res = await fetch(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.model,
                messages: ollamaMessages,
                stream: true,
            }),
        });

        if (!res.ok) throw new Error(`Ollama stream error ${res.status}`);

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const lines = decoder.decode(value).split('\n').filter(Boolean);
            for (const line of lines) {
                try {
                    const chunk: OllamaResponse = JSON.parse(line);
                    onChunk({ delta: chunk.message?.content ?? '', done: chunk.done });
                    if (chunk.done) return;
                } catch {
                    // skip malformed
                }
            }
        }
    }

    async listModels(): Promise<string[]> {
        const res = await fetch(`${this.baseUrl}/api/tags`);
        if (!res.ok) return [];
        const data: OllamaModelList = await res.json();
        return data.models.map((m) => m.name);
    }

    async healthCheck(): Promise<boolean> {
        try {
            const res = await fetch(`${this.baseUrl}/api/tags`, {
                signal: AbortSignal.timeout(3000),
            });
            return res.ok;
        } catch {
            return false;
        }
    }

    /**
     * Convert internal Message[] to Ollama's message format.
     *
     * Critical: Ollama requires the FULL conversation history including
     * tool results so the model knows what happened and can continue.
     *
     * Ollama message format for tool calls:
     * - assistant message with tool_calls array
     * - tool result as role="tool" with content = result text
     */
    private convertMessages(messages: Message[]): OllamaMessage[] {
        const result: OllamaMessage[] = [];

        for (const m of messages) {
            if (m.role === 'tool') {
                // Tool result — Ollama accepts role: 'tool' directly
                result.push({
                    role: 'tool',
                    content: m.content,
                    tool_call_id: m.tool_call_id,
                });
            } else if (m.role === 'assistant' && m.tool_calls?.length) {
                // Assistant message with tool calls — pass tool_calls in Ollama format
                result.push({
                    role: 'assistant',
                    content: m.content ?? '',
                    tool_calls: m.tool_calls.map((tc) => ({
                        function: {
                            name: tc.function.name,
                            // Ollama expects arguments as object, not string
                            arguments: (() => {
                                try {
                                    return JSON.parse(tc.function.arguments);
                                } catch {
                                    return tc.function.arguments;
                                }
                            })(),
                        },
                    })),
                });
            } else {
                result.push({
                    role: m.role,
                    content: m.content,
                });
            }
        }

        return result;
    }
}