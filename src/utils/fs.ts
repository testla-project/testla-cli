// ─────────────────────────────────────────────────────────────
// testla-cli · src/utils/fs.ts
// Small filesystem utilities
// ─────────────────────────────────────────────────────────────

export async function exists(path: string): Promise<boolean> {
    try {
        await Deno.stat(path);
        return true;
    } catch {
        return false;
    }
}

export function existsSync(path: string): boolean {
    try {
        Deno.statSync(path);
        return true;
    } catch {
        return false;
    }
}
