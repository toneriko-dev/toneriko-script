import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// 意味を壊した試行が、コンパイル失敗ではなく対象のアサーションで落ちることを調べます。
const mutations = [
	{ name: '周回束縛の共有', file: 'src/v2/runtime/environment.ts',
		before: 'next.bindings.set(name, { ...binding });', after: 'next.bindings.set(name, binding);' },
	{ name: 'finally の上書き無視', file: 'src/v2/interpreter.ts',
		before: 'if (final) return final;', after: 'if (final) void final;' },
	{ name: '論理積の真偽値化', file: 'src/v2/interpreter.ts',
		before: "case 'LogicalExpression': {", after: "case 'LogicalExpression': {\n\t\t\t\tif (String(node.operator) === '&&') return !!(yield this.evaluate(node.left, env, execution)) && !!(yield this.evaluate(node.right, env, execution));" },
	{ name: 'optional chain のキー評価', file: 'src/v2/interpreter.ts',
		before: 'if (object === shortCircuit || (node.optional && object === null)) return shortCircuit;',
		after: 'if (object === shortCircuit || (node.optional && object === null)) { if (node.computed) yield this.evaluate(node.property, env, execution); return shortCircuit; }' },
	{ name: '複合代入の左辺再評価', file: 'src/v2/interpreter.ts',
		before: "const previous = node.operator === '=' ? null : this.read(ref, execution, pos);",
		after: "if (node.operator !== '=') yield this.reference(node.left, env, execution);\n\t\t\t\tconst previous = node.operator === '=' ? null : this.read(ref, execution, pos);" },
	{ name: 'TDZ の null 化', file: 'src/v2/runtime/environment.ts',
		before: "if (!binding.initialized) throw runtimeError('TDZ_ACCESS', pos, { name }, 'ReferenceError');",
		after: 'if (!binding.initialized) return null;' },
	{ name: 'キー列挙の逆転', file: 'src/v2/runtime/values.ts',
		before: 'Object.keys(Object(value))', after: 'Object.keys(Object(value)).reverse()' },
	{ name: '即時 Promise による時間リセット', file: 'src/v2/interpreter.ts',
		before: 'try { value = await this.wait(result.value.wait); }', after: 'try { value = await this.wait(result.value.wait); this.busy = 0; }' },
];
const temporary = mkdtempSync(join(process.cwd(), '.v2-mutations-'));
const originals = new Map(mutations.map(item => [item.file, readFileSync(item.file, 'utf8')]));
function check() {
	const result = spawnSync('bun', ['run', 'typecheck'], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
	assert.equal(result.status, 0, result.stdout + result.stderr);
}
function tests(name) {
	const output = join(temporary, `${name}.json`);
	const result = spawnSync('bun', ['run', 'test', 'test/v2/runtime-differential.ts', '-t', '変異検出:', '--reporter=json', `--outputFile=${output}`], {
		encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
	});
	assert.ok(result.status === 0 || result.status === 1, result.stdout + result.stderr);
	const report = JSON.parse(readFileSync(output, 'utf8'));
	const assertions = report.testResults.flatMap(suite => suite.assertionResults);
	assert.ok(assertions.filter(item => item.status !== 'pending').length >= 9, '対象テストが実行されていません');
	return { status: result.status, failed: assertions.filter(item => item.status === 'failed').map(item => item.fullName) };
}
try {
	check();
	assert.equal(tests('baseline').status, 0, '正常版のテストが通っていません');
	for (const [index, mutation] of mutations.entries()) {
		const original = originals.get(mutation.file);
		assert.equal(original.split(mutation.before).length - 1, 1, `${mutation.name}: 置換箇所が一意ではありません`);
		try {
			writeFileSync(mutation.file, original.replace(mutation.before, mutation.after));
			check();
			const result = tests(`mutant-${index}`);
			assert.equal(result.status, 1, `${mutation.name}: 変異が検出されませんでした`);
			assert.ok(result.failed.length > 0, `${mutation.name}: アサーション以外の失敗です`);
			console.log(JSON.stringify({ mutation: mutation.name, detectedBy: result.failed }));
		} finally { writeFileSync(mutation.file, original); }
	}
	check();
	assert.equal(tests('restored').status, 0, '復元後のテストが通っていません');
	console.log(JSON.stringify({ mutations: mutations.length, detected: mutations.length, restored: true }));
} finally {
	for (const [file, original] of originals) writeFileSync(file, original);
	rmSync(temporary, { recursive: true, force: true });
}
