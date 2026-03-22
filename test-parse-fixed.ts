// Test the fixed parsing function
import { discoverPageTool } from './src/agent/discover.ts';

// Import the parseDiscoveredElements function by re-implementing it with the new logic
function parseDiscoveredElements(report: string): Array<{ name: string; selector: string; isLazy: boolean }> {
    const elements: Array<{ name: string; selector: string; isLazy: boolean }> = [];
    const lines = report.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        if (!trimmed.includes('propName:')) continue;
        
        try {
            const jsonStr = trimmed
                .replace(/,\s*$/, '')
                .replace(/propName:/g, '"propName":')
                .replace(/selector:/g, '"selector":')
                .replace(/isLazy:/g, '"isLazy":');
            
            const obj = JSON.parse(jsonStr);
            if (obj.propName && obj.selector && typeof obj.isLazy === 'boolean') {
                elements.push({ 
                    name: obj.propName, 
                    selector: obj.selector, 
                    isLazy: obj.isLazy 
                });
            }
        } catch (e) {
            continue;
        }
    }
    return elements;
}

const result = await discoverPageTool.execute({
    url: 'https://the-internet.herokuapp.com/login',
    outputDir: './test-results/discover-debug',
});

console.log('🧪 Testing parseDiscoveredElements() with fixed implementation\n');

const elements = parseDiscoveredElements(result.output);

console.log(`✅ Parsed ${elements.length} elements:\n`);
elements.forEach((el, i) => {
    console.log(`${i + 1}. ${el.name}`);
    console.log(`   Selector: ${el.selector}`);
    console.log(`   Lazy: ${el.isLazy}\n`);
});
