import { join } from 'https://deno.land/std/path/mod.ts';
import { generatePlaywrightConfig } from './templates/playwrightConfig.ts';
import { generateEnvFile, generateGitignore, generateReadme } from './templates/projectFiles.ts';
import { generateDemoScreen, generateDemoTask, generateExampleTest, generateScreensIndex, generateTasksIndex, generateUserFixtures } from "./templates/testFiles.ts";

async function writeFileIfMissing(path: string, content: string): Promise<void> {
    try {
        await Deno.stat(path);
    } catch {
        await Deno.writeTextFile(path, content);
    }
}

export async function generateAllFiles(
    testDir: string,
    testCommand: string,
    cwd: string = Deno.cwd(),
): Promise<void> {
    await writeFileIfMissing(join(cwd, "playwright.config.ts"), generatePlaywrightConfig(testDir));
    await writeFileIfMissing(join(cwd, ".env"), generateEnvFile());
    await writeFileIfMissing(join(cwd, ".gitignore"), generateGitignore());
    await writeFileIfMissing(join(cwd, "README.md"), generateReadme(testDir, testCommand));

    // Test Files
    await writeFileIfMissing(join(cwd, testDir, "example.spec.ts"), generateExampleTest());
    await writeFileIfMissing(join(cwd, "fixtures", "user.ts"), generateUserFixtures());
    await writeFileIfMissing(join(cwd, "screenplay", "tasks", "demo-task.ts"), generateDemoTask());
    await writeFileIfMissing(join(cwd, "screenplay", "tasks", "index.ts"), generateTasksIndex());
    await writeFileIfMissing(join(cwd, "screenplay", "screens", "demo-screen.ts"), generateDemoScreen());
    await writeFileIfMissing(join(cwd, "screenplay", "screens", "index.ts"), generateScreensIndex());
}
