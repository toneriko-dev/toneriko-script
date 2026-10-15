import { expect, test } from 'vitest';
import ts from 'typescript-js';
import { parse } from '../../src/v2/parser/index.js';
import { Interpreter } from '../../src/v2/interpreter.js';
import { check } from '../../src/v2/checker/index.js';

const seeds = [1, 17, 2027, 65537, 123456789];
function programs(seed: number): string[] {
	let state = seed;
	const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
	return Array.from({ length: 100 }, (_, index) => {
		const n = next() % 100, m = next() % 20, word = `word${next() % 1000}`;
		const choices = [
			`let s: number = ${n}; for (let i: number = 0; i < ${m}; i++) s += i; out(s);`,
			`function f(x: number = ${n}): number { return x + ${m}; } out(f()); out(f(${m}));`,
			`let x: string | null = null; out(x); x = "${word}"; out(x);`,
			`let row: { id: string, count: number } = { id: "${word}", count: ${n} }; out(row.id); out(row.count);`,
			`const xs: number[] = [${n}, ${m}]; out(xs.map((x: number): number => x + 1));`,
			`let { n }: { n: number } = { n: ${n} }; n += ${m}; out(n);`,
			`function sum(...xs: number[]): number { let n: number = 0; for (const x of xs) n += x; return n; } out(sum(${n}, ${m}));`,
			`function f(): number { try { return ${n}; } finally { out("finally"); } } out(f());`,
			`const row: { n?: number } = {}; out(row.n ?? ${n});`,
			`const f: Function = (x: number): number => x + ${m}; out(f(${n}));`,
		];
		return choices[index % choices.length]!;
	});
}
const fixtures = seeds.flatMap(programs);
const erase = (source: string) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

// 全例を独立した関数へ入れ、一度の意味検査で宣言や推論型の干渉を防ぎます。
test('TypeScript の意味検査を通る固定 seed 500 例', () => {
	const filename = '/v2-types-differential.ts';
	const source = 'declare function out(value: any): void;\n' + fixtures.map((fixture, index) => `function example${index}() {\n${fixture}\n}`).join('\n');
	const options: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, types: [], skipLibCheck: true };
	const host = ts.createCompilerHost(options);
	const read = host.readFile, get = host.getSourceFile, exists = host.fileExists;
	host.readFile = name => name === filename ? source : read(name);
	host.fileExists = name => name === filename || exists(name);
	host.getSourceFile = (name, version, onError, create) => name === filename ? ts.createSourceFile(name, source, version, true) : get(name, version, onError, create);
	const program = ts.createProgram([filename], options, host);
	const errors = ts.getPreEmitDiagnostics(program).map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n'));
	expect(errors).toEqual([]);
});

for (const seed of seeds) test(`型注釈除去・実行前検査・JavaScript 差分 seed=${seed} 100例`, async () => {
	for (const source of programs(seed)) {
		const ast = parse(source).program;
		expect(check(ast, { globals: ['out'] }), source).toEqual([]);
		const erased = erase(source);
		const expected: unknown[] = [];
		new Function('out', erased)((value: unknown) => { expected.push(structuredClone(value)); });
		for (const program of [ast, parse(erased).program]) {
			const actual: unknown[] = [];
			await new Interpreter({ out: (value: unknown) => { actual.push(structuredClone(value)); } }).exec(program);
			expect(actual, source).toEqual(expected);
		}
	}
});

test('型注釈を除くと型不一致だけが消え、副作用の順序は変わらない', async () => {
	const source = 'let x: number = 1; out("before"); x = value(); out("after");';
	for (const typed of [true, false]) {
		const trace: unknown[] = [];
		const vm = new Interpreter({ out: (x: unknown) => { trace.push(x); }, value: () => { trace.push('value'); return 'bad'; } });
		const run = vm.exec(parse(typed ? source : erase(source)).program);
		if (typed) {
			await expect(run).rejects.toMatchObject({ code: 'TYPE_ANNOTATION_MISMATCH' });
			expect(trace).toEqual(['before', 'value']);
			expect(vm.getGlobal('x')).toBe(1);
		} else {
			await run;
			expect(trace).toEqual(['before', 'value', 'after']);
			expect(vm.getGlobal('x')).toBe('bad');
		}
	}
});
