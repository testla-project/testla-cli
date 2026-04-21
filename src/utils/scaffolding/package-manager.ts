import { existsSync } from 'https://deno.land/std/fs/mod.ts';

export function detectPackageManager(): "npm" | "yarn" | "pnpm" {
    const packageManager = Deno.env.get("npm_config_user_agent");
    if (packageManager) {
        if (packageManager.startsWith("pnpm")) return "pnpm";
        if (packageManager.startsWith("yarn")) return "yarn";
        if (packageManager.startsWith("npm")) return "npm";
    }
    return "npm"; // Default
}

export async function run(
    command: string,
    options: { cwd?: string } = {},
): Promise<void> {
    const { cwd = Deno.cwd() } = options;
    const cmd = new Deno.Command("sh", {
        args: ["-c", command],
        cwd,
        stdout: "inherit",
        stderr: "inherit",
    });
    const { success } = await cmd.output();
    if (!success) {
        throw new Error(`Command failed: ${command}`);
    }
}

export async function installDeps(
    deps: string[] = [],
    dev: boolean = false,
    cwd: string = Deno.cwd(),
): Promise<void> {
    const pm = detectPackageManager();
    const devFlag = dev ? (pm === "yarn" ? "--dev" : pm === "pnpm" ? "-D" : "--save-dev") : "";
    const cmd = {
        npm: `npm install ${devFlag} ${deps.join(" ")}`,
        yarn: `yarn add ${devFlag} ${deps.join(" ")}`,
        pnpm: `pnpm add ${devFlag} ${deps.join(" ")}`,
    }[pm];
    await run(cmd, { cwd });
}

export async function installAll(cwd: string = Deno.cwd()): Promise<void>{
    const pm = detectPackageManager();
    const cmd = {
        npm: "npm install",
        yarn: "yarn install",
        pnpm: "pnpm install",
    }[pm];
    await run(cmd, { cwd });
}