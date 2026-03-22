// ─────────────────────────────────────────────────────────────
// testla-cli · src/mcp/client.ts
// MCP (Model Context Protocol) client
// Connects to MCP servers and exposes their tools as AgentTools
// ─────────────────────────────────────────────────────────────

import type { AgentTool, ToolResult } from '../agent/types.ts';
import type { MCPServerConfig } from '../config/manager.ts';

interface MCPTool {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}

interface MCPListToolsResponse {
    tools: MCPTool[];
}

interface MCPCallToolResponse {
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
}

export class MCPClient {
    private serverUrl: string;
    private serverName: string;
    private sessionId: string | null = null;

    constructor(config: MCPServerConfig) {
        this.serverUrl = config.url;
        this.serverName = config.name;
    }

    async connect(): Promise<void> {
        // MCP uses SSE — initialize the session
        const res = await fetch(`${this.serverUrl}/initialize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                clientInfo: { name: 'testla-cli', version: '0.1.0' },
            }),
        });

        if (!res.ok) {
            throw new Error(`MCP connect failed for ${this.serverName}: ${res.status}`);
        }

        const data = await res.json();
        this.sessionId = data.sessionId ?? null;
    }

    async listTools(): Promise<MCPTool[]> {
        const res = await this.rpc('tools/list', {});
        const data = res as MCPListToolsResponse;
        return data.tools ?? [];
    }

    async callTool(name: string, input: Record<string, unknown>): Promise<MCPCallToolResponse> {
        return await this.rpc('tools/call', { name, arguments: input }) as MCPCallToolResponse;
    }

    /** Convert MCP tools to AgentTools for the loop */
    async getAgentTools(): Promise<AgentTool[]> {
        const mcpTools = await this.listTools();
        return mcpTools.map((t): AgentTool => ({
            name: `${this.serverName}__${t.name}`,
            description: `[${this.serverName} MCP] ${t.description}`,
            parameters: {
                type: 'object',
                properties: t.inputSchema.properties ?? {},
                required: t.inputSchema.required,
            },
            execute: async (input): Promise<ToolResult> => {
                try {
                    const result = await this.callTool(t.name, input as Record<string, unknown>);
                    const text = result.content
                        .filter((c) => c.type === 'text')
                        .map((c) => c.text ?? '')
                        .join('\n');

                    return {
                        success: !result.isError,
                        output: text,
                        error: result.isError ? text : undefined,
                    };
                } catch (e) {
                    return { success: false, output: '', error: String(e) };
                }
            },
        }));
    }

    private async rpc(method: string, params: unknown): Promise<unknown> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };
        if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

        const res = await fetch(this.serverUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: Date.now(),
                method,
                params,
            }),
        });

        if (!res.ok) throw new Error(`MCP RPC ${method} failed: ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(`MCP error: ${JSON.stringify(data.error)}`);
        return data.result;
    }
}

/** Load tools from all enabled MCP servers */
export async function loadMCPTools(
    servers: MCPServerConfig[],
): Promise<AgentTool[]> {
    const allTools: AgentTool[] = [];

    for (const server of servers.filter((s) => s.enabled)) {
        try {
            const client = new MCPClient(server);
            await client.connect();
            const tools = await client.getAgentTools();
            allTools.push(...tools);
        } catch (e) {
            console.warn(`⚠️  MCP server "${server.name}" unavailable: ${e}`);
        }
    }

    return allTools;
}
