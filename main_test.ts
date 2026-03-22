import { assert } from 'https://deno.land/std@0.203.0/testing/asserts.ts';
import { buildCLI } from './src/cli/index.ts';

Deno.test('builds CLI command', () => {
  const cli = buildCLI();
  assert(cli);
});
