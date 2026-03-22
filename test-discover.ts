// Test script to debug discover_page tool
import { discoverPageTool } from './src/agent/discover.ts';

const testUrl = 'https://the-internet.herokuapp.com/login';
const outputDir = './test-results/discover-debug';

console.log('🧪 Testing discover_page tool...\n');
console.log(`URL: ${testUrl}`);
console.log(`Output dir: ${outputDir}\n`);

try {
    const result = await discoverPageTool.execute({
        url: testUrl,
        outputDir,
    });

    console.log('\n📊 Result:');
    console.log(`Success: ${result.success}`);
    console.log(`\n📝 Output (first 1000 chars):`);
    console.log(result.output.slice(0, 1000));
    
    if (result.output.length > 1000) {
        console.log(`\n... (${result.output.length} total characters)`);
    }
    
    if (result.error) {
        console.log(`\n❌ Error: ${result.error}`);
    }

    // Try to parse elements
    const re = /\{\s*propName:\s*"([^"]+)",\s*selector:\s*"([^"]+)",\s*isLazy:\s*(true|false)\s*\}/g;
    const elements = [];
    let m;
    while ((m = re.exec(result.output)) !== null) {
        elements.push({ name: m[1], selector: m[2], isLazy: m[3] === 'true' });
    }
    
    console.log(`\n✅ Parsed ${elements.length} elements:`);
    elements.forEach((el, i) => {
        console.log(`  ${i + 1}. ${el.name}`);
    });

} catch (error) {
    console.error('\n💥 Exception thrown:');
    console.error(error);
}
