import { Confirm, Input, Secret, Select } from '@cliffy/prompt';
import { logger } from '../utils/logger.ts';
import { DEFAULTS, loadConfig, saveConfig, TestlaConfig } from '../config/config.ts';

export async function setupCommand(): Promise<void> {
    const existing = await loadConfig();

    logger.info('Testla', '🛠️  Starting Setup...');
    logger.info(
        'Testla',
        'Konfiguriere deine Testla-Umgebung. Leere Eingabe behält den aktuellen Wert',
    );

    // ─── AI Provider Management ────────────────────────────────────────────────────────────────
    logger.info('Testla', 'AI Provider Management:');
    const ollamaBaseUrl = await Input.prompt({
        message: 'Ollama URL (z.B. http://localhost:11434)',
        default: existing?.ollama.baseUrl ?? DEFAULTS.ollama.baseUrl,
        hint: 'e.g. http://localhost:11434',
    });

    // Ping Ollama and show available models
    let ollamaModels: string[] = [];
    try {
        const res = await fetch(`${ollamaBaseUrl}/api/tags`);
        if (res.ok) {
            const data = await res.json();
            ollamaModels = (data.models ?? []).map((m: { name: string }) => m.name);
            logger.success(
                'Testla',
                `Ollama connected – ${ollamaModels.length} model(s) available\n`,
            );
        }
    } catch {
        logger.error(
            'Testla',
            'Could not connect to Ollama. Please check the URL and ensure Ollama is running.\n',
        );
    }

    let ollamaModel: string;
    if (ollamaModels.length > 0) {
        const defaultModel = existing?.ollama.model ?? DEFAULTS.ollama.model;
        const defaultInList = ollamaModels.includes(defaultModel);

        ollamaModel = await Select.prompt({
            message: 'Ollama Model',
            options: ollamaModels,
            default: defaultInList ? defaultModel : ollamaModels[0],
        });
    } else {
        ollamaModel = await Input.prompt({
            message: 'Ollama Modell',
            default: existing?.ollama.model ?? DEFAULTS.ollama.model,
            hint: 'z.B. qwen3-coder, codellama, deepseek-coder',
        });
    }

    // ─── Speichern ─────────────────────────────────────────────────────────────
    const config: TestlaConfig = {
        ollama: { baseUrl: ollamaBaseUrl, model: ollamaModel },
    };
    await saveConfig(config);
    logger.success('Testla', 'Setup complete!');

    logger.info(
        'Testla',
        'Deine Testla-Umgebung ist jetzt konfiguriert. Du kannst Testla jetzt verwenden:',
    );
    logger.info('Testla', '  testla run --prompt "Teste den Login-Flow"');
    logger.info('Testla', '  testla run --ticket PROJ-123 (wenn Jira konfiguriert ist)');
}
