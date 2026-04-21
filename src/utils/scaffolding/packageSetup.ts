import { join } from "https://deno.land/std/path/mod.ts";

export async function updatePackageJson(projectRoot: string): Promise<void> {
    const packageJsonPath = join(projectRoot, "package.json");

    const raw = await Deno.readTextFile(packageJsonPath);
    const packageJson = JSON.parse(raw);

    packageJson.scripts = {
        ...packageJson.scripts,
        test: "npx playwright test",
    };

    await Deno.writeTextFile(
        packageJsonPath,
        JSON.stringify(packageJson, null, 2),
    );
}