// Show the raw output format
import { discoverPageTool } from './src/agent/discover.ts';

const result = await discoverPageTool.execute({
    url: 'https://the-internet.herokuapp.com/login',
    outputDir: './test-results/discover-debug',
});

// Find the section with the copy-paste array
const startIdx = result.output.indexOf('## Copy-paste for screenplay_screen');
if (startIdx !== -1) {
    const section = result.output.substring(startIdx, startIdx + 800);
    console.log('FOUND SECTION:\n');
    console.log(section);
} else {
    console.log('Copy-paste section NOT found!');
    console.log('\n\nFull output (last 2000 chars):\n');
    console.log(result.output.slice(-2000));
}
