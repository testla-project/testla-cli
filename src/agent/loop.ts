// ─────────────────────────────────────────────────────────────────────────────
// testla-cli · src/agent/loop.ts
// The core agent loop — plan → act → observe → repeat
// ─────────────────────────────────────────────────────────────────────────────

import type { LLMProvider } from '../llm/types.ts';
import type { Message, ToolDefinition } from '../llm/types.ts';
import type { AgentTool, AgentRunOptions, AgentRunResult, AgentStep } from './types.ts';
import { bold, cyan, yellow } from 'jsr:@std/fmt/colors';
import { Confirm } from 'jsr:@cliffy/prompt';

// System prompt is loaded from a .txt file to avoid Deno's static import scanner
// treating example import statements in the prompt as real module imports.
const _promptPath = new URL('./loop-system-prompt.txt', import.meta.url);
export const SYSTEM_PROMPT: string = await Deno.readTextFile(_promptPath);

export class AgentLoop {
    private provider: LLMProvider;
    private tools: Map<string, AgentTool>;
    private maxIterations: number;
    private systemPromptAdditions: string;

    constructor(
        provider: LLMProvider,
        extraTools: AgentTool[] = [],
        maxIterations = 30,
        systemPromptAdditions = '',
    ) {
        this.provider = provider;
        this.maxIterations = maxIterations;
        this.systemPromptAdditions = systemPromptAdditions;
        this.tools = new Map();
        for (const tool of extraTools) {
            this.tools.set(tool.name, tool);
        }
    }

    registerTool(tool: AgentTool): void {
        this.tools.set(tool.name, tool);
    }

    async run(options: AgentRunOptions): Promise<AgentRunResult> {
        const {
            task,
            workingDir = Deno.cwd(),
            maxIterations = this.maxIterations,
            confirmShellCommands = false,
            onStep,
        } = options;

        const steps: AgentStep[] = [];
        const systemContent = this.systemPromptAdditions
            ? `${SYSTEM_PROMPT}\n\n${this.systemPromptAdditions}`
            : SYSTEM_PROMPT;

        const messages: Message[] = [
            { role: 'system', content: systemContent },
            { role: 'user', content: `Working directory: ${workingDir}\n\nTask: ${task}` },
        ];

        const toolDefs: ToolDefinition[] = Array.from(this.tools.values()).map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
        }));

        // Startup banner
        const enc = new TextEncoder();
        Deno.stdout.writeSync(enc.encode(
            `\n  🤖  testla agent starting\n` +
            `      Provider  : ${this.provider.name}\n` +
            `      Model     : ${this.provider.model}\n` +
            `      Tools     : ${this.tools.size}\n` +
            `      Max iters : ${maxIterations}\n` +
            `      Work dir  : ${workingDir}\n`,
        ));

        let iteration = 0;

        while (iteration < maxIterations) {
            iteration++;

            // Spinner
            const spinFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
            let spinIdx = 0;
            const spinLabel = `${this.provider.name}/${this.provider.model}`;
            const spinInterval = setInterval(() => {
                Deno.stdout.writeSync(enc.encode(
                    `\r  ${cyan(spinFrames[spinIdx % spinFrames.length])}  ${yellow(spinLabel)} ... (iteration ${iteration}/${maxIterations})`,
                ));
                spinIdx++;
            }, 80);

            const start = Date.now();
            let response;
            try {
                response = await this.provider.chat(messages, toolDefs);
            } catch (err) {
                clearInterval(spinInterval);
                return { success: false, answer: `LLM error: ${err}`, steps, iterations: iteration };
            }
            clearInterval(spinInterval);
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            Deno.stdout.writeSync(enc.encode(
                `\r  ${cyan('✦')}  ${yellow(spinLabel)} responded in ${bold(elapsed + 's')}\n`,
            ));

            // Thought content
            if (response.content?.trim()) {
                const step: AgentStep = { type: 'thought', content: response.content.trim().slice(0, 300) };
                steps.push(step);
                onStep?.(step);
            }

            // ── Recover tool calls embedded in content text ───────────
            // Some models (qwen2.5-coder) occasionally output the tool call
            // as JSON in the content field instead of in tool_calls.
            // Detect this and convert it into a proper tool call.
            if ((!response.tool_calls || response.tool_calls.length === 0) && response.content) {
                const recovered = tryExtractToolCallFromText(response.content, this.tools);
                if (recovered) {
                    response = { ...response, tool_calls: [recovered], content: null };
                    Deno.stdout.writeSync(enc.encode(
                        `  ℹ️  Recovered tool call from text: ${recovered.function.name}\n`,
                    ));
                }
            }

            // No tool calls → done
            if (!response.tool_calls || response.tool_calls.length === 0) {
                if (!response.content) {
                    Deno.stdout.writeSync(enc.encode(
                        `\n  ⚠️  Model returned no tool calls (iteration ${iteration}).\n` +
                        `     Model may be too small. Try: ollama pull qwen2.5-coder:7b\n\n`,
                    ));
                }
                const finalStep: AgentStep = {
                    type: 'final',
                    content: response.content ?? 'Task completed.',
                };
                steps.push(finalStep);
                onStep?.(finalStep);
                return {
                    success: true,
                    answer: response.content ?? 'Task completed.',
                    steps,
                    iterations: iteration,
                };
            }

            // Add assistant message
            messages.push({
                role: 'assistant',
                content: response.content ?? '',
                tool_calls: response.tool_calls,
            });

            // Execute tools
            for (const toolCall of response.tool_calls) {
                const toolName = toolCall.function.name;
                const toolInput = JSON.parse(toolCall.function.arguments);

                const callStep: AgentStep = {
                    type: 'tool_call',
                    content: `Calling ${toolName}(${JSON.stringify(toolInput, null, 2)})`,
                    toolName,
                    toolInput,
                };
                steps.push(callStep);
                onStep?.(callStep);

                const tool = this.tools.get(toolName);

                let result;
                if (!tool) {
                    result = { success: false, output: '', error: `Unknown tool: ${toolName}` };
                } else if (confirmShellCommands && toolName === 'shell') {
                    const proceed = await Confirm.prompt({
                        message: `Execute shell command?\n${toolInput.command}`,
                        default: true,
                    });
                    result = proceed
                        ? await tool.execute(toolInput)
                        : { success: false, output: '', error: 'Declined by user.' };
                } else {
                    result = await tool.execute(toolInput);
                }

                const resultStep: AgentStep = {
                    type: 'tool_result',
                    content: result.success
                        ? result.output
                        : `ERROR: ${result.error}\n${result.output}`,
                    toolName,
                };
                steps.push(resultStep);
                onStep?.(resultStep);

                messages.push({
                    role: 'tool',
                    content: resultStep.content,
                    tool_call_id: toolCall.id,
                });
            }
        }

        return {
            success: false,
            answer: `Max iterations (${maxIterations}) reached.`,
            steps,
            iterations: iteration,
        };
    }

    getTools(): AgentTool[] {
        return Array.from(this.tools.values());
    }
}

// ── Helper: recover tool call from model text output ─────────────────────
// Some small models output the tool invocation as JSON text in `content`
// instead of using the proper `tool_calls` field.
// Patterns handled:
//   {"name":"discover_page","arguments":{...}}
//   {"tool":"discover_page","input":{...}}
//   ```json\n{"name":...}\n```

function tryExtractToolCallFromText(
    text: string,
    tools: Map<string, AgentTool>,
): { id: string; type: 'function'; function: { name: string; arguments: string } } | null {
    // Strip markdown code fences
    const cleaned = text
        .replace(/```(?:json)?\n?/g, '')
        .trim();

    // Try parsing the whole content as JSON
    const candidates = [cleaned];

    // Also try to extract a JSON object from within the text
    const jsonMatch = cleaned.match(/\{[\s\S]+\}/);
    if (jsonMatch) candidates.push(jsonMatch[0]);

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);

            // Format: {"name": "tool_name", "arguments": {...}}
            const toolName = parsed.name ?? parsed.tool ?? parsed.tool_name;
            const args = parsed.arguments ?? parsed.input ?? parsed.params ?? parsed.parameters ?? {};

            if (typeof toolName === 'string' && tools.has(toolName)) {
                return {
                    id: `recovered_${Date.now()}`,
                    type: 'function',
                    function: {
                        name: toolName,
                        arguments: JSON.stringify(args),
                    },
                };
            }
        } catch {
            // Not valid JSON — ignore
        }
    }

    return null;
}