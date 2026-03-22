// Test the output parsing
import { discoverPageTool } from './src/agent/discover.ts';

const testUrl = 'https://the-internet.herokuapp.com/login';
const outputDir = './test-results/discover-debug';

const result = await discoverPageTool.execute({
    url: testUrl,
    outputDir,
});

console.log('FULL OUTPUT:\n');
console.log(result.output);
console.log('\n\n=== PARSING TEST ===\n');

// Test the exact regex from parseDiscoveredElements
const pattern = /\{\s*propName:\s*"([^"]+)",\s*selector:\s*"([^"]+)",\s*isLazy:\s*(true|false)\s*\}/g;
let matches = 0;
let match;
while ((match = pattern.exec(result.output)) !== null) {
    matches++;
    console.log(`Match ${matches}: name="${match[1]}", selector="${match[2]}", isLazy=${match[3]}`);
}

console.log(`\n✅ Total matches: ${matches}`);
