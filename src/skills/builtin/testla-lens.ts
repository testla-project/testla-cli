import type { Skill } from '../types.ts';
import type { AgentTool } from '../../agent/types.ts';

const lensTool: AgentTool = {
    name: 'testla_lens',
    description: 'Analyzes a URL using Playwright to find real selectors.',
    parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url']
    },
    async execute(input) {
        const url = input.url as string;
        // Simuliertes Script für Deno/Node Umgebung
        const script = `
const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto('${url}');
    const data = await page.evaluate(() => {
        const btn = document.querySelector('button');
        return { 
            button: btn ? (btn.id ? '#' + btn.id : 'button:has-text("' + btn.innerText + '")') : 'button',
            heading: 'h1'
        };
    });
    console.log(JSON.stringify(data));
    await browser.close();
})();`;

        const proc = new Deno.Command("node", { args: ["-e", script], stdout: "piped" });
        const { stdout } = await proc.output();
        return { success: true, output: new TextDecoder().decode(stdout) };
    }
};

export const testlaLensSkill: Skill = {
    name: 'testla-lens',
    description: 'Web analysis',
    version: '1.0.0',
    author: 'testla',
    tools: [lensTool]
};