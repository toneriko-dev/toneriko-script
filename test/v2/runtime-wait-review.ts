import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

test('context.call が停止済みでも unhandledRejection を出さない', () => {
	// 拒否の通知をテストランナーと分け、子プロセスのイベントを数える。
	const source = `
		import { Interpreter, hostFunction } from ${JSON.stringify(new URL('../../src/v2/interpreter.ts', import.meta.url).href)};
		import { parse } from ${JSON.stringify(new URL('../../src/v2/parser/index.ts', import.meta.url).href)};
		let unhandled = 0;
		process.on('unhandledRejection', () => { unhandled++; });
		const codes = [];
		for (const source of ['run(() => { while (true) {} });', 'run(() => run(() => { while (true) {} }));']) {
			const run = hostFunction(([fn], context) => context.call(fn, []));
			try { await new Interpreter({run}, {maxSteps: 200, yieldInterval: 1e9}).exec(parse(source).program); }
			catch (error) { codes.push(error.code); }
		}
		await new Promise(resolve => setTimeout(resolve, 50));
		console.log(JSON.stringify({unhandled, codes}));
	`;
	const result = spawnSync('bun', ['--eval', source], { encoding: 'utf8', timeout: 5000 });
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({ unhandled: 0, codes: ['STEP_LIMIT_EXCEEDED', 'STEP_LIMIT_EXCEEDED'] });
});
