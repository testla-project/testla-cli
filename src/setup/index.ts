

export async function setupCommand(): Promise<void> {
    const existing = await loadConfig();

    logger.info('Testla', '🛠️  Starting Setup...');
    logger.info(
        'Testla',
        'Konfiguriere deine Testla-Umgebung. Leere Eingabe behält den aktuellen Wert',
    );

    // ─── Schritt 1: Ollama ─────────────────────────────────────────────────────
    const ollama = await setupOllama(existing);

    // ─── Schritt 2: Playwright MCP ────────────────────────────────────────────
    await setupPlaywrightMcp();

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