import { ensureDir } from "https://deno.land/std/fs/mod.ts";
import { join } from "https://deno.land/std/path/mod.ts";

const DOT_TESTLA = ".testla";

export async function saveArtifact(filename: string, data: any) {
  try {
    await ensureDir(DOT_TESTLA);
    const filePath = join(DOT_TESTLA, filename);
    await Deno.writeTextFile(filePath, JSON.stringify(data, null, 2));
    return filePath;
  } catch (err) {
    console.error(`[💾 Persistence] Fehler beim Speichern von ${filename}:`, err);
  }
}