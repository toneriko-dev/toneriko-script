import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import { parse } from '../../src/v2/parser/index.js';
import { Interpreter } from '../../src/v2/interpreter.js';

function altTyped(depth: number): string {
	return 'const f = ' + 'c ? d : (p = '.repeat(depth) + '1' + '): number => p'.repeat(depth);
}

test('条件式の偽の枝に置いた型付きアローの既定値は256段まで読み評価できる', async () => {
	const output: unknown[] = [];
	const source = altTyped(256) + '; let value = f; for (let i = 0; i < 256; i++) value = value(); out(value);';
	await new Interpreter({ c: false, d: 0, out: (value: unknown) => output.push(value) }).exec(parse(source).program);
	assert.deepEqual(output, [1]);
	assert.throws(() => parse(altTyped(257)), { code: 'NESTING_TOO_DEEP' });
});
