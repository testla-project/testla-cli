// ─────────────────────────────────────────────────────────────
// testla-cli · src/llm/provider.ts
// Provider factory — resolves config → LLMProvider instance
// ─────────────────────────────────────────────────────────────

import type { LLMProvider, ProviderConfig } from './types.ts';
import { OllamaProvider } from './ollama.ts';
// import { OpenAIProvider } from './openai.ts';
// import { AnthropicProvider } from './anthropic.ts';

export function createProvider(config: ProviderConfig): LLMProvider {
    switch (config.provider) {
        case 'ollama':
            return new OllamaProvider(config.model, config.baseUrl);

        // case 'openai':
        //   if (!config.apiKey) throw new Error('OpenAI requires an API key');
        //   return new OpenAIProvider(config.model, config.apiKey, config.baseUrl);

        // case 'anthropic':
        //   if (!config.apiKey) throw new Error('Anthropic requires an API key');
        //   return new AnthropicProvider(config.model, config.apiKey, config.baseUrl);

        // case 'gemini':
        //   // Gemini uses the OpenAI-compatible endpoint
        //   if (!config.apiKey) throw new Error('Gemini requires an API key');
        //   return new OpenAIProvider(
        //     config.model,
        //     config.apiKey,
        //     'https://generativelanguage.googleapis.com/v1beta/openai',
        //   );

        default:
            throw new Error(`Unknown provider: ${(config as ProviderConfig).provider}`);
    }
}

export type { LLMProvider };
