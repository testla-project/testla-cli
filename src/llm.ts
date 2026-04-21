/**
 * src/llm.ts — LLM Provider Abstraction
 *
 * Reads config.json and returns the right LlmClient implementation.
 * Supported providers: ollama (OpenAI-compatible API) · anthropic
 *
 * Config shapes:
 *
 *   Ollama (current default):
 *     { "ollama": { "baseUrl": "http://localhost:11434", "model": "gemma4:latest" } }
 *
 *   Anthropic:
 *     { "anthropic": { "apiKey": "sk-ant-...", "model": "claude-opus-4-5" } }
 */

// ─── Config ────────────────────────────────────────────────────────────────────

export interface OllamaConfig {
  baseUrl: string; // e.g. "http://localhost:11434"
  model: string;   // e.g. "gemma4:latest"
}

export interface AnthropicConfig {
  apiKey?: string; // falls back to ANTHROPIC_API_KEY env var
  model: string;   // e.g. "claude-opus-4-5"
}

export interface NovaConfig {
  ollama?: OllamaConfig;
  anthropic?: AnthropicConfig;
}

export async function loadConfig(path = '~/.testla/config.json'): Promise<NovaConfig> {
  try {
    const home = Deno.env.get('HOME');
    const actualPath = home ? path.replace('~', home) : path;
    const raw = await Deno.readTextFile(actualPath);
    return JSON.parse(raw) as NovaConfig;
  } catch {
    throw new Error(
      `Could not read config.json at "${path}". ` +
        'Make sure the file exists and contains a valid provider config.',
    );
  }
}

// ─── Common Skill / Tool types ─────────────────────────────────────────────────

/** Provider-agnostic skill definition — mirrors Anthropic Tool but decoupled. */
export interface SkillDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** A single tool call returned by the LLM, normalised across providers. */
export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Normalised response from one LLM completion turn. */
export interface LlmResponse {
  stopReason: 'tool_use' | 'end_turn' | 'other';
  toolCalls: LlmToolCall[];
  /** Opaque — pass directly back to appendAssistantTurn(). */
  rawAssistant: unknown;
}

// ─── LlmClient interface ───────────────────────────────────────────────────────

export interface LlmClient {
  /**
   * Send one completion turn.
   *
   * @param system   System prompt (plain text).
   * @param messages Current message history (built with the methods below).
   * @param skills   Skills to expose as tools this turn.
   */
  complete(params: {
    system: string;
    messages: unknown[];
    skills: SkillDefinition[];
  }): Promise<LlmResponse>;

  /** Return an initial user message containing the plan text. */
  makePlanMessage(content: string): unknown;

  /**
   * Return an assistant message to append after a `complete()` call.
   * Pass in `response.rawAssistant` directly.
   */
  makeAssistantMessage(rawAssistant: unknown): unknown;

  /** Return the user-side tool-result message to append after executing tools. */
  makeToolResultMessage(
    results: Array<{ toolCallId: string; content: string }>,
  ): unknown;
}

// ─── Ollama Provider (OpenAI-compatible) ──────────────────────────────────────

interface OaiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OaiToolCall[];
  tool_call_id?: string;
}

interface OaiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OaiResponse {
  choices: Array<{
    message: OaiMessage;
    finish_reason: string;
  }>;
}

class OllamaClient implements LlmClient {
  private readonly completionsUrl: string;

  constructor(private readonly cfg: OllamaConfig) {
    // Normalise trailing slash
    const base = cfg.baseUrl.replace(/\/$/, '');
    this.completionsUrl = `${base}/v1/chat/completions`;
  }

  async complete(params: {
    system: string;
    messages: unknown[];
    skills: SkillDefinition[];
  }): Promise<LlmResponse> {
    const tools = params.skills.map(skillToOaiTool);

    const body = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: params.system } as OaiMessage,
        ...(params.messages as OaiMessage[]),
      ],
      tools,
      // Some Ollama builds need this to activate tool mode
      tool_choice: tools.length > 0 ? 'auto' : undefined,
    };

    const response = await fetch(this.completionsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as OaiResponse;
    const choice = data.choices[0];
    const msg = choice.message;

    const toolCalls: LlmToolCall[] = (msg.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: parseJson(tc.function.arguments),
    }));

    const stopReason = normaliseOaiFinish(choice.finish_reason, toolCalls.length);

    return { stopReason, toolCalls, rawAssistant: msg };
  }

  makePlanMessage(content: string): unknown {
    return { role: 'user', content } satisfies OaiMessage;
  }

  makeAssistantMessage(rawAssistant: unknown): unknown {
    return rawAssistant; // already OaiMessage shape
  }

  makeToolResultMessage(
    results: Array<{ toolCallId: string; content: string }>,
  ): unknown[] {
    // OpenAI: one message per tool result
    return results.map(
      (r) =>
        ({
          role: 'tool',
          tool_call_id: r.toolCallId,
          content: r.content,
        }) satisfies OaiMessage,
    );
  }
}

function skillToOaiTool(skill: SkillDefinition) {
  return {
    type: 'function' as const,
    function: {
      name: skill.name,
      description: skill.description,
      parameters: skill.input_schema,
    },
  };
}

function normaliseOaiFinish(
  finish: string,
  toolCallCount: number,
): LlmResponse['stopReason'] {
  if (finish === 'tool_calls' || toolCallCount > 0) return 'tool_use';
  if (finish === 'stop') return 'end_turn';
  return 'other';
}

// ─── Anthropic Provider ────────────────────────────────────────────────────────

// Lazy import so Ollama-only users don't need the SDK installed.
// deno-lint-ignore no-explicit-any
type AnthropicSdk = any;

class AnthropicClient implements LlmClient {
  private sdk: AnthropicSdk | null = null;

  constructor(private readonly cfg: AnthropicConfig) {}

  private async getClient(): Promise<AnthropicSdk> {
    if (!this.sdk) {
      const { default: Anthropic } = await import('npm:@anthropic-ai/sdk');
      this.sdk = new Anthropic({
        apiKey: this.cfg.apiKey ?? Deno.env.get('ANTHROPIC_API_KEY'),
      });
    }
    return this.sdk;
  }

  async complete(params: {
    system: string;
    messages: unknown[];
    skills: SkillDefinition[];
  }): Promise<LlmResponse> {
    const client = await this.getClient();

    const response = await client.messages.create({
      model: this.cfg.model,
      max_tokens: 4096,
      system: params.system,
      tools: params.skills.map(skillToAnthropicTool),
      messages: params.messages,
    });

    const toolCalls: LlmToolCall[] = response.content
      .filter((b: { type: string }) => b.type === 'tool_use')
      .map((b: { id: string; name: string; input: Record<string, unknown> }) => ({
        id: b.id,
        name: b.name,
        input: b.input,
      }));

    const stopReason = normaliseAnthropicStop(response.stop_reason, toolCalls.length);

    return { stopReason, toolCalls, rawAssistant: response.content };
  }

  makePlanMessage(content: string): unknown {
    return { role: 'user', content };
  }

  makeAssistantMessage(rawAssistant: unknown): unknown {
    return { role: 'assistant', content: rawAssistant };
  }

  makeToolResultMessage(
    results: Array<{ toolCallId: string; content: string }>,
  ): unknown {
    // Anthropic: one user message with all tool_result blocks
    return {
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.toolCallId,
        content: r.content,
      })),
    };
  }
}

function skillToAnthropicTool(skill: SkillDefinition) {
  return {
    name: skill.name,
    description: skill.description,
    input_schema: skill.input_schema,
  };
}

function normaliseAnthropicStop(
  stop: string,
  toolCallCount: number,
): LlmResponse['stopReason'] {
  if (stop === 'tool_use' || toolCallCount > 0) return 'tool_use';
  if (stop === 'end_turn') return 'end_turn';
  return 'other';
}

// ─── Factory ───────────────────────────────────────────────────────────────────

/**
 * Read config.json and return the configured LlmClient.
 * Priority: anthropic > ollama (so you can override by adding "anthropic" to config).
 */
export async function createLlmClient(configPath = '~/.testla/config.json'): Promise<LlmClient> {
  const config = await loadConfig(configPath);

  if (config.anthropic) {
    console.log(`[llm] Using Anthropic — model: ${config.anthropic.model}`);
    return new AnthropicClient(config.anthropic);
  }

  if (config.ollama) {
    console.log(
      `[llm] Using Ollama — model: ${config.ollama.model}  base: ${config.ollama.baseUrl}`,
    );
    return new OllamaClient(config.ollama);
  }

  throw new Error(
    'config.json must contain either an "ollama" or "anthropic" provider block.',
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function parseJson(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}