// ─────────────────────────────────────────────────────────────────────────────
// testla-cli · src/agent/session.ts
//
// Manages a Playwright inspector subprocess.
// Spawns inspector.ts via Node.js + tsx in the test project directory
// (so it can resolve @playwright/test from the project's node_modules).
//
// Usage:
//   const session = await InspectorSession.start('/path/to/testproject');
//   const snap = await session.snapshot();
//   await session.goto('https://example.com');
//   await session.click('e5');
//   await session.quit();
// ─────────────────────────────────────────────────────────────────────────────
 
import { bold, cyan, red, yellow } from 'jsr:@std/fmt/colors';

export interface SnapElement {
    ref: string;
    role: string;
    name: string;
    locator: string;
    propName: string;
    interactive: boolean;
}

export interface SnapshotResult {
    url: string;
    elements: SnapElement[];
}

// ── Inspector session ─────────────────────────────────────────────────────
export class InspectorSession {
    private proc: Deno.ChildProcess;
    private writer: WritableStreamDefaultWriter<Uint8Array>;
    private pending = new Map<number, {
        resolve: (v: unknown) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    private idCounter = 1;
    private enc = new TextEncoder();
    private buf = '';

    private constructor(proc: Deno.ChildProcess, writer: WritableStreamDefaultWriter<Uint8Array>) {
        this.proc = proc;
        this.writer = writer;
    }

    // ── Start ───────────────────────────────────────────────────────────
    static async start(projectDir: string): Promise<InspectorSession> {
        // inspector.ts lives next to this file — resolve relative to import.meta.url
        const inspectorPath = new URL('./inspector.ts', import.meta.url).pathname;

        // 2. Deno Command statt Node/tsx nutzen
        // const cmd = new Deno.Command(Deno.execPath(), {
        //     args: [
        //         "run",
        //         "-A", // Erlaubt Netzwerk & Filesystem für Playwright
        //         "--unstable-node-globals",
        //         inspectorPath
        //     ],
        //     cwd: projectDir,
        //     stdin: 'piped',
        //     stdout: 'piped',
        //     stderr: 'inherit', // WICHTIG: Fehler vom Inspector direkt im Terminal sehen
        //     env: {
        //         ...Deno.env.toObject(),
        //         // Playwright braucht diesen Hinweis oft in Deno-Umgebungen
        //         PLAYWRIGHT_BROWSERS_PATH: Deno.env.get("PLAYWRIGHT_BROWSERS_PATH") || ""
        //     },
        // });

        const cmd = new Deno.Command('npx', {
            args: ['tsx', inspectorPath],
            cwd: projectDir,
            stdin: 'piped',
            stdout: 'piped',
            stderr: 'inherit',
            env: {
                ...Deno.env.toObject(),
                PLAYWRIGHT_BROWSERS_PATH: Deno.env.get('PLAYWRIGHT_BROWSERS_PATH') || '',
            }
        });

        const proc = cmd.spawn();
        const writer = proc.stdin.getWriter();
        const session = new InspectorSession(proc, writer);
        session.startReadLoop();

        // ── Liveness-Check statt blindem Sleep ──────────────────────────
        const alive = await session.ping(3000).catch(() => false);
        if (!alive) {
            proc.kill('SIGKILL');
            throw new Error(
                `Inspector subprocess failed to start.\n` +
                `Run manually to debug: cd ${projectDir} && npx tsx ${inspectorPath}`
            );
        }

        return session;
    }

    // ── Read loop ───────────────────────────────────────────────────────
    private startReadLoop(): void {
        const dec = new TextDecoder();
        (async () => {
            const reader = this.proc.stdout.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    this.buf += dec.decode(value);
                    this.flush();
                }
            } catch { /* process ended */ }
        })();
    }

    private flush(): void {
        const lines = this.buf.split('\n');
        this.buf = lines.pop() ?? '';
        for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            try {
                const msg = JSON.parse(t) as { id: number; ok: boolean; [k: string]: unknown };
                const h = this.pending.get(msg.id);
                if (h) {
                    this.pending.delete(msg.id);
                    clearTimeout(h.timer);
                    if (msg.ok) h.resolve(msg);
                    else h.reject(new Error((msg.error as string) ?? 'Inspector error'));
                }
            } catch {
                // Ignore JSON parse errors
            }
        }
    }

    // ── RPC ─────────────────────────────────────────────────────────────
    private rpc(cmd: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
        const id = this.idCounter++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Inspector timeout: ${cmd.cmd}`));
            }, timeoutMs);
            this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
            const msg = JSON.stringify({ id, ...cmd }) + '\n';
            this.writer.write(new TextEncoder().encode(msg)).catch(reject);
        });
    }

    // ── API ───────────────────────────────────────────────────────────
    async goto(url: string): Promise<string> {
        const r = await this.rpc({ cmd: 'goto', url });
        return r.url as string;
    }

    async snapshot(): Promise<SnapshotResult> {
        try {
        const r = await this.rpc({ cmd: 'snapshot' });
        
        if (!r) {
            throw new Error("Inspector antwortete mit 'undefined' auf den Snapshot-Befehl.");
        }

        return { 
            url: (r.url as string) || '', 
            elements: (r.elements as SnapElement[]) || [] 
        };
    } catch (error) {
        console.log("Inspector", `Snapshot fehlgeschlagen: ${error}`);
        // Fallback-Objekt zurückgeben, damit walkFlow weitermachen kann
        return { url: '', elements: [] };
    }
    }
 
    async click(ref: string): Promise<void> {
        await this.rpc({ cmd: 'click', ref });
    }
 
    async fill(ref: string, text: string): Promise<void> {
        await this.rpc({ cmd: 'fill', ref, text });
    }
 
    async screenshot(filePath: string): Promise<string> {
        const r = await this.rpc({ cmd: 'screenshot', path: filePath });
        return r.path as string;
    }
 
    async eval(js: string): Promise<string> {
        const r = await this.rpc({ cmd: 'eval', js });
        return r.result as string;
    }
 
    async url(): Promise<string> {
        const r = await this.rpc({ cmd: 'url' });
        return r.url as string;
    }
 
    async wait(ms: number): Promise<void> {
        await this.rpc({ cmd: 'wait', ms }, ms + 5000);
    }
 
    async waitForSelector(selector: string, timeout = 10000): Promise<void> {
        await this.rpc({ cmd: 'waitForSelector', selector, timeout }, timeout + 5000);
    }

    async quit(): Promise<void> {
        try { 
            // 1. Versuche höflich das 'quit' Kommando zu senden
            await this.rpc({ cmd: 'quit' }, 2000).catch(() => {});
            // 2. Stream sicher schließen (prüfen ob er noch offen ist)
            // Das verhindert den "Writable stream is closed" Fehler
            try {
                await this.writer.ready;
                await this.writer.close(); 
            } catch {}
        } catch(_e) {

        } finally {
            // 3. Prozess hart beenden, falls er noch hängt
            try {
                this.proc.kill('SIGKILL');
            } catch {
                
            }
        }
    }

    // ── Element matching helper ──────────────────────────────────────────
    // Find the best matching ref for a plain-language hint.

    findRef(elements: SnapElement[], hint: string, preferRole?: string): string | null {
        if (!hint) return null;
        const hl = hint.toLowerCase();
        let best = 0, bestRef: string | null = null;
        for (const el of elements) {
            const nl = el.name.toLowerCase();
            let score = 0; 

            if (preferRole && el.role === preferRole) score += 2;
            if (nl === hl) score += 20;
            if (nl.includes(hl) || hl.includes(nl)) score += 10; 

            for (const w of hl.split(/\W+/).filter(w => w.length > 2)) {
                if (nl.includes(w)) score += 3;
                if (el.propName.toLowerCase().includes(w)) score += 2;
            }

            if (score > best) { best = score; bestRef = el.ref; }
        }
        return best >= 3 ? bestRef : null;
    }

    async ping(timeoutMs = 3000): Promise<boolean> {
        try {
            await this.rpc({ cmd: 'url' }, timeoutMs);
            return true;
        } catch {
            return false;
        }
    }
}
