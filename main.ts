#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env
import { colors } from '@cliffy/ansi/colors';
import { Command, ValidationError } from '@cliffy/command';
import { CompletionsCommand } from '@cliffy/command/completions';
import { setupCommand } from './src/commands/setup.ts';
import { runCommand } from './src/commands/run.ts'; // NEU
import { logger } from './src/utils/logger.ts';
import { TESTLA_VERSION } from './src/version.ts';

// Initialize Testla-CLI
const program = new Command()
    .name('testla')
    .version(TESTLA_VERSION)
    .description('Testla - AI-driven Test generator powered by testla-screenplay project')
    .example('testla setup', 'Configure Testla')
    .example('testla run', 'Run test generation')
    .example('testla dashboard', 'Show live status dashboard')
    .default('help');

// Register commands
program
    .command('setup')
    .description('Configure Testla')
    .action(setupCommand)
    .command('run', runCommand)
    .command(
        'dashboard',
        new Command()
            .description('Show live status dashboard in separate terminal')
            .action(() => {
                logger.info('CLI', 'Open another terminal and run:');
                logger.info('CLI', '  deno run --allow-read src/dashboard.ts');
            }),
    )
    .command('completions', new CompletionsCommand());

// Add global error handling
program.error((error, cmd) => {
    if (error instanceof ValidationError) {
        cmd.showHelp();
        logger.error('CLI', error.message);
    } else {
        logger.error('CLI', error instanceof Error ? error.message : String(error));
        if (logger.isDebugEnabled()) {
            console.error(error);
        }
    }
    Deno.exit(1);
});

// Parse command-line arguments
if (import.meta.main) {
    // await ensureCliBrowsers();
    await program.parse(Deno.args);
}
