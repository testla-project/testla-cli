// ─────────────────────────────────────────────────────────────────────────────
// testla-cli · src/agent/discover.ts
//
// discover_page tool — wraps @playwright/mcp via stdio transport
//
// @playwright/mcp is a stdio MCP server:
//   npx @playwright/mcp@latest
// It reads JSON-RPC from stdin, writes responses to stdout.
// No HTTP server, no port — pure process communication.
// ─────────────────────────────────────────────────────────────────────────────

import type { AgentTool, ToolInput, ToolResult } from './types.ts';
import { bold, cyan, red } from 'jsr:@std/fmt/colors';

// ── Stdio MCP client ──────────────────────────────────────────────────────

class StdioMCPClient {
    private proc: Deno.ChildProcess | null = null;
    private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    private idCounter = 1;
    private readLoop: Promise<void> | null = null;
    private enc = new TextEncoder();
    private dec = new TextDecoder();
    private buffer = '';

    async start(): Promise<void> {
        // Try global install first, fall back to npx
        const hasBinary = await new Deno.Command('which', {
            args: ['playwright-mcp'],
            stdout: 'null', stderr: 'null',
        }).output().then((r) => r.code === 0).catch(() => false);

        const cmd = hasBinary
            ? new Deno.Command('playwright-mcp', {
                args: ['--headless'],
                stdin: 'piped', stdout: 'piped', stderr: 'null',
            })
            : new Deno.Command('npx', {
                args: ['--yes', '@playwright/mcp@latest', '--headless'],
                stdin: 'piped', stdout: 'piped', stderr: 'null',
            });

        this.proc = cmd.spawn();
        this.writer = this.proc.stdin.getWriter();

        // Start reading responses
        this.readLoop = this.startReadLoop();

        // Initialize the MCP session
        await this.request('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            clientInfo: { name: 'testla-cli', version: '1.0' },
        });
    }

    private async startReadLoop(): Promise<void> {
        const reader = this.proc!.stdout.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                this.buffer += this.dec.decode(value);
                this.processBuffer();
            }
        } catch { /* process ended */ }
    }

    private processBuffer(): void {
        // MCP over stdio uses newline-delimited JSON
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() ?? '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const msg = JSON.parse(trimmed);
                if (msg.id !== undefined) {
                    const handler = this.pending.get(msg.id);
                    if (handler) {
                        this.pending.delete(msg.id);
                        if (msg.error) {
                            handler.reject(new Error(JSON.stringify(msg.error)));
                        } else {
                            handler.resolve(msg.result);
                        }
                    }
                }
            } catch { /* skip malformed */ }
        }
    }

    async request(method: string, params: unknown): Promise<unknown> {
        const id = this.idCounter++;
        const message = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });

            // Timeout per request
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP request timed out: ${method}`));
            }, 25_000);

            this.writer!.write(this.enc.encode(message)).then(() => {
                // Wrap resolve to clear timeout
                const origResolve = resolve;
                this.pending.set(id, {
                    resolve: (v) => { clearTimeout(timeout); origResolve(v); },
                    reject:  (e) => { clearTimeout(timeout); reject(e); },
                });
            }).catch(reject);
        });
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text?: string; data?: string }> }> {
        const result = await this.request('tools/call', { name, arguments: args });
        return result as { content: Array<{ type: string; text?: string; data?: string }> };
    }

    async stop(): Promise<void> {
        try { await this.callTool('browser_close', {}); } catch { /* ignore */ }
        try { this.writer?.close(); } catch { /* ignore */ }
        try { this.proc?.kill('SIGTERM'); } catch { /* ignore */ }
    }
}

// ── Parse accessibility snapshot text → locators ─────────────────────────

interface DiscoveredElement {
    kind: 'interactive' | 'output';
    role: string;
    name: string;
    locator: string;
    propName: string;
}

const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio',
    'combobox', 'listbox', 'menuitem', 'switch', 'tab', 'spinbutton',
]);

function roleToLocator(role: string, name: string): string {
    if (!name) return `page.getByRole('${role}')`;

    // Inputs: use getByLabel
    if (['textbox', 'searchbox', 'spinbutton', 'combobox'].includes(role)) {
        return `page.getByLabel(${JSON.stringify(name)})`;
    }
    // Everything else: getByRole with name
    return `page.getByRole('${role}', { name: ${JSON.stringify(name)} })`;
}

function toPropName(name: string, role: string): string {
    const base = (name || role)
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40);
    return base || 'ELEMENT';
}

// playwright-mcp snapshot format (text):
//   - button "Login" [ref=e1]
//   - textbox "Username" [ref=e2]
//   - link "Home" [ref=e3]
function parseSnapshot(snapshot: string): DiscoveredElement[] {
    const elements: DiscoveredElement[] = [];
    const seen = new Set<string>();

    for (const line of snapshot.split('\n')) {
        // Match: optional indent + "- role "name""
        const m = line.match(/^\s*-\s+(\w[\w-]*)\s+"([^"]+)"/);
        if (!m) continue;

        const [, role, name] = m;

        if (INTERACTIVE_ROLES.has(role)) {
            const locator = roleToLocator(role, name);
            if (seen.has(locator)) continue;
            seen.add(locator);

            elements.push({
                kind: 'interactive',
                role,
                name,
                locator,
                propName: toPropName(name, role),
            });
        } else if (/alert|status|region/.test(role)) {
            const locator = roleToLocator(role, name);
            if (seen.has(locator)) continue;
            seen.add(locator);

            elements.push({
                kind: 'output',
                role,
                name,
                locator,
                propName: toPropName(name, role) + '_OUTPUT',
            });
        }
    }

    return elements;
}

// ── The AgentTool ─────────────────────────────────────────────────────────

export const discoverPageTool: AgentTool = {
    name: 'discover_page',
    description:
        'Navigate to a URL with a real Playwright browser, take a screenshot, ' +
        'and extract all interactive elements with verified accessibility-based locators ' +
        '(getByRole, getByLabel). Uses @playwright/mcp via stdio. ' +
        'Always call this FIRST before generating screenplay files.',
    parameters: {
        type: 'object',
        properties: {
            url: { type: 'string', description: 'The URL to visit' },
            outputDir: {
                type: 'string',
                description: 'Where to save screenshots (default: test-results/discover)',
            },
            waitForSelector: {
                type: 'string',
                description: 'Optional text/selector to wait for before extracting',
            },
        },
        required: ['url'],
    },

    async execute(input: ToolInput): Promise<ToolResult> {
        const url = input.url as string;
        const outputDir = (input.outputDir as string | undefined) ??
            `${Deno.cwd()}/test-results/discover`;
        const waitForSelector = input.waitForSelector as string | undefined;

        const enc = new TextEncoder();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const screenshotPath = `${outputDir}/snapshot-${timestamp}.png`;

        Deno.stdout.writeSync(enc.encode(
            `\n  🔍  Discovering page: ${bold(url)}\n`,
        ));

        await Deno.mkdir(outputDir, { recursive: true });

        const client = new StdioMCPClient();

        try {
            // ── Start MCP process ─────────────────────────────────────
            Deno.stdout.writeSync(enc.encode(`      Starting @playwright/mcp...\n`));
            try {
                await client.start();
            } catch (startErr) {
                Deno.stdout.writeSync(enc.encode(
                    `\n  ${red('❌')}  Could not start @playwright/mcp\n` +
                    `      Run: npm install -g @playwright/mcp@latest\n` +
                    `      Error: ${String(startErr).slice(0, 120)}\n\n`,
                ));
                return {
                    success: false,
                    output: '',
                    error: `@playwright/mcp not available. Run: npm install -g @playwright/mcp@latest`,
                };
            }

            // ── Navigate ─────────────────────────────────────────────
            Deno.stdout.writeSync(enc.encode(`      Navigating...\n`));

            let navResult: { content: Array<{ type: string; text?: string }> };
            try {
                navResult = await client.callTool('browser_navigate', { url });
            } catch (navErr) {
                const msg = String(navErr);
                // Take screenshot of error state
                await client.callTool('browser_screenshot', {
                    filename: screenshotPath, raw: false,
                }).catch(() => {});
                await client.stop();

                const isNet = /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ENOTFOUND|ECONNREFUSED/i.test(msg);
                Deno.stdout.writeSync(enc.encode(
                    `\n  ${red('❌')}  Page not reachable\n` +
                    `      URL    : ${url}\n` +
                    `      Reason : ${msg.slice(0, 150)}\n` +
                    (isNet ? `      Hint   : Check URL spelling and network connection.\n` : '') +
                    `      Screenshot: ${screenshotPath}\n\n`,
                ));
                return {
                    success: false,
                    output: '',
                    error: `Page not reachable: ${msg.slice(0, 200)}. Screenshot: ${screenshotPath}`,
                };
            }

            // Check for HTTP error in response text
            const navText = (navResult.content ?? []).map((c) => c.text ?? '').join('\n');
            // Only flag real HTTP error codes — not timing values like "535ms"
            // playwright-mcp nav errors include text like "failed: net::ERR_..." or "HTTP 404"
            const statusMatch = navText.match(/\bHTTP[/ ]+(4\d\d|5\d\d)\b|\bstatus[: ]+(4\d\d|5\d\d)\b/i);
            if (statusMatch) {
                const status = parseInt(statusMatch[1] ?? statusMatch[2], 10);
                await client.callTool('browser_screenshot', { filename: screenshotPath, raw: false }).catch(() => {});
                await client.stop();

                const hint = status === 404 ? 'Page not found — check the URL.'
                    : status === 401 ? 'Unauthorized — page requires login first.'
                    : status === 403 ? 'Forbidden — access denied.'
                    : status >= 500 ? 'Server error — the site may be down.'
                    : `HTTP ${status} error.`;

                Deno.stdout.writeSync(enc.encode(
                    `\n  ${red('❌')}  HTTP ${status}\n` +
                    `      Hint  : ${hint}\n` +
                    `      Screenshot: ${screenshotPath}\n\n`,
                ));
                return {
                    success: false,
                    output: '',
                    error: `HTTP ${status}: ${hint} Screenshot: ${screenshotPath}`,
                };
            }

            // ── Optional wait ─────────────────────────────────────────
            if (waitForSelector) {
                await client.callTool('browser_wait_for', {
                    text: waitForSelector, timeout: 5000,
                }).catch(() => {});
            }

            // ── Screenshot ────────────────────────────────────────────
            Deno.stdout.writeSync(enc.encode(`      Taking screenshot...\n`));
            await client.callTool('browser_screenshot', {
                filename: screenshotPath, raw: false,
            }).catch(() => {});

            // ── Accessibility snapshot ────────────────────────────────
            Deno.stdout.writeSync(enc.encode(`      Reading accessibility tree...\n`));
            const snapResult = await client.callTool('browser_snapshot', {});
            await client.stop();

            const snapText = (snapResult.content ?? [])
                .filter((c) => c.type === 'text')
                .map((c) => c.text ?? '')
                .join('\n');

            const elements = parseSnapshot(snapText);
            const interactive = elements.filter((e) => e.kind === 'interactive');
            const outputs = elements.filter((e) => e.kind === 'output');

            // ── Terminal summary ──────────────────────────────────────
            Deno.stdout.writeSync(enc.encode(
                `\n  ${cyan('📸')}  Done\n` +
                `      Screenshot  : ${screenshotPath}\n` +
                `      Interactive : ${interactive.length}\n` +
                `      Outputs     : ${outputs.length}\n\n`,
            ));

            if (elements.length === 0) {
                return {
                    success: true,
                    output:
                        `Page loaded but no elements found.\n` +
                        `Screenshot: ${screenshotPath}\n` +
                        `Page may require authentication or dynamic content.\n` +
                        `Raw snapshot:\n${snapText.slice(0, 800)}`,
                };
            }

            // ── LLM report ────────────────────────────────────────────
            let report = `# Discovered elements at ${url}\n`;
            report += `Screenshot: ${screenshotPath}\n\n`;

            if (interactive.length) {
                report += `## Interactive elements\n\n`;
                for (const el of interactive) {
                    report += `- **${el.propName}** (${el.role}: "${el.name}")\n`;
                    report += `  Locator: \`${el.locator}\`\n`;
                }
                report += `\n`;
            }

            if (outputs.length) {
                report += `## Output elements\n\n`;
                for (const el of outputs) {
                    report += `- **${el.propName}** (${el.role}: "${el.name}")\n`;
                    report += `  Locator: \`${el.locator}\`\n`;
                }
                report += `\n`;
            }

            report += `## Copy-paste for screenplay_screen elements array\n\n`;
            for (const el of elements) {
                report += `{ propName: ${JSON.stringify(el.propName)}, selector: ${JSON.stringify(el.locator)}, isLazy: true },\n`;
            }

            return { success: true, output: report };

        } catch (err) {
            await client.stop().catch(() => {});
            Deno.stdout.writeSync(enc.encode(
                `\n  ${red('❌')}  discover_page error: ${String(err).slice(0, 200)}\n\n`,
            ));
            return { success: false, output: '', error: `discover_page: ${err}` };
        }
    },
};