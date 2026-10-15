import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// 型検査の失敗を検出成功にせず、それぞれの意味を検査するアサーションまで実行します。
const mutations = [
	{ name: 'sort-stability', file: 'src/v2/stdlib/collections.ts', before: 'Number.isNaN(order) || order <= 0', after: 'Number.isNaN(order) || order < 0' },
	{ name: 'slice-graphemes', file: 'src/v2/stdlib/strings.ts', before: "const clamp = name === 'slice' ? relative : bounded;", after: "if (name === 'slice') return (receiver as string).slice(args[0] as number, args[1] as number);\n\t\tconst clamp = name === 'slice' ? relative : bounded;" },
	{ name: 'replace-first-only', file: 'src/v2/stdlib/strings.ts', before: "matches(ctx, original, search, info, 0, name === 'replaceAll' ? Infinity : 1)", after: 'matches(ctx, original, search, info, 0, Infinity)' },
	{ name: 'range-excludes-end', file: 'src/v2/stdlib/services.ts', before: 'step > 0 ? value < end : value > end', after: 'step > 0 ? value <= end : value >= end' },
	{ name: 'map-sequential', file: 'src/v2/stdlib/arrays.ts', before: 'const xs = requireArray(ctx, r), fn = callable(ctx, args[0]); noThis(ctx, args[1]); const length = xs.length; const out: Value[] = [];', after: "const xs = requireArray(ctx, r), fn = callable(ctx, args[0]); noThis(ctx, args[1]); const length = xs.length; const out: Value[] = [];\n\t\tif (String(name) === 'map') return yield ctx.wait!(Promise.all(xs.map((value, i) => ctx.parallel!(fn, [value, i, xs]))));" },
	{ name: 'sort-yields', file: 'src/v2/stdlib/collections.ts', before: 'return ++work.count % 64 === 0;', after: 'work.count++; return false;' },
	{ name: 'catalog-complete', file: 'src/v2/stdlib/index.ts', before: 'export const catalog = [...catalogOf(definitions),', after: 'export const catalog = [...catalogOf(definitions).slice(1),' },
];
const temporary = mkdtempSync(join(process.cwd(), '.v2-stdlib-mutations-'));
const testPath = join('test/v2', `${basename(temporary).replace(/^\./, '')}.ts`);
const originals = new Map(mutations.map(item => [item.file, readFileSync(item.file, 'utf8')]));
const testSource = String.raw`
import { expect, test } from 'vitest';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';
import { catalog, definitions, constantDefinitions } from '../../src/v2/stdlib/index.js';
async function output(source: string, globals: Record<string, unknown> = {}, options = {}) {
  const result: unknown[] = [];
  await new Interpreter({ ...globals, emit: (value: unknown) => result.push(structuredClone(value)) }, options).exec(parse(source).program);
  return result;
}
test('sort-stability', async () => {
  expect(await output('emit([{k:1,i:0},{k:1,i:1},{k:0,i:2},{k:1,i:3}].sort((a,b)=>a.k-b.k).map(x=>x.i));')).toEqual([[2,0,1,3]]);
});
test('slice-graphemes', async () => {
  expect(await output('emit("👩🏽‍💻é\\r\\nx".slice(0,1));')).toEqual(['👩🏽‍💻']);
});
test('replace-first-only', async () => {
  expect(await output('emit("aba".replace("a","x"));')).toEqual(['xba']);
});
test('range-excludes-end', async () => {
  expect(await output('emit(range(1,3)); emit(range(3,1,-1));')).toEqual([[1,2],[3,2]]);
});
test('map-sequential', async () => {
  const trace: string[] = []; let active = 0, maximum = 0;
  const result = await output('emit([1,2,3].map(x=>work(x)));', { work: async (x: number) => {
    maximum = Math.max(maximum, ++active); trace.push('start'+x); await Promise.resolve(); trace.push('end'+x); active--; return x*2;
  } });
  expect(result).toEqual([[2,4,6]]); expect(maximum).toBe(1);
  expect(trace).toEqual(['start1','end1','start2','end2','start3','end3']);
});
test('sort-yields', async () => {
  let clock = 0, lastYield = 0, maximumGap = 0, yields = 0;
  const prefix = 'a'.repeat(32768);
  const result = await output('emit(items.sort());', { items: [prefix+'b',prefix+'a'] }, {
    now: () => ++clock, maxBusyTime: Infinity, yieldInterval: 8,
    yieldToHost: async () => { maximumGap = Math.max(maximumGap, clock-lastYield); lastYield = clock; yields++; },
  });
  expect(result).toEqual([[prefix+'a',prefix+'b']]); expect(yields).toBeGreaterThan(0); expect(maximumGap).toBeLessThanOrEqual(32);
});
test('catalog-complete', () => {
  expect(catalog.map(d=>d.receiver+':'+d.name)).toEqual([...definitions, ...constantDefinitions].map(d=>d.receiver+':'+d.name));
});
`;
function check() {
	const result = spawnSync('bun', ['run', 'typecheck'], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
	assert.equal(result.status, 0, `型検査失敗は変異検出として数えません。\n${result.stdout}${result.stderr}`);
}
function tests(label) {
	const reportPath = join(temporary, `${label}.json`);
	const result = spawnSync('bun', ['run', 'test', testPath, '--reporter=json', `--outputFile=${reportPath}`], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
	assert.ok(result.status === 0 || result.status === 1, result.stdout + result.stderr);
	const report = JSON.parse(readFileSync(reportPath, 'utf8'));
	const assertions = report.testResults.flatMap(suite => suite.assertionResults);
	assert.equal(assertions.length, mutations.length, '検査件数が一致しません');
	assert.equal(assertions.filter(item => item.status === 'passed' || item.status === 'failed').length, mutations.length, '未実行のテストがあります');
	return { status: result.status, failed: assertions.filter(item => item.status === 'failed').map(item => item.fullName) };
}
try {
	writeFileSync(testPath, testSource);
	check();
	assert.equal(tests('baseline').status, 0, '正常版の意味検査が通っていません');
	for (const [index, mutation] of mutations.entries()) {
		const original = originals.get(mutation.file);
		assert.equal(original.split(mutation.before).length - 1, 1, `${mutation.name}: 置換箇所が一意ではありません`);
		try {
			writeFileSync(mutation.file, original.replace(mutation.before, mutation.after));
			check();
			const result = tests(`mutant-${index}`);
			assert.equal(result.status, 1, `${mutation.name}: 変異が検出されませんでした`);
			assert.ok(result.failed.some(name => name === mutation.name), `${mutation.name}: 指定した意味のアサーションで失敗していません: ${result.failed.join(', ')}`);
			console.log(JSON.stringify({ mutation: mutation.name, detectedBy: result.failed }));
		} finally { writeFileSync(mutation.file, original); }
		check();
		assert.equal(tests(`restored-${index}`).status, 0, `${mutation.name}: 復元後に正常版が通りません`);
	}
	console.log(JSON.stringify({ mutations: mutations.length, detected: mutations.length, restored: true }));
} finally {
	for (const [file, original] of originals) writeFileSync(file, original);
	rmSync(testPath, { force: true });
	rmSync(temporary, { recursive: true, force: true });
}
