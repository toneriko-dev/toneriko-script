import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const file = 'src/v2/parser/index.ts';
const original = readFileSync(file, 'utf8');
const before = "\t\twhile (true) {\n\t\t\tif (this.at('(') || this.at('[') || this.peek().kind === 'template'";
const after = "\t\twhile (true) {\n\t\t\tif (this.at('(') && this.peek().lineBreakBefore) break;\n\t\t\tif (this.at('(') || this.at('[') || this.peek().kind === 'template'";
const temporary = mkdtempSync(join(process.cwd(), '.git', 'v2-parser-mutations-'));

function typecheck() {
	const result = spawnSync('bun', ['run', 'typecheck'], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
	assert.equal(result.status, 0, result.stdout + result.stderr);
}

function test(name, pattern) {
	const output = join(temporary, `${name}.json`);
	const result = spawnSync('bun', ['run', 'test', 'test/v2/differential.ts', '-t', pattern, '--reporter=json', `--outputFile=${output}`], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
	assert.ok(result.status === 0 || result.status === 1, result.stdout + result.stderr);
	const report = JSON.parse(readFileSync(output, 'utf8'));
	const assertions = report.testResults.flatMap(suite => suite.assertionResults).filter(item => item.status === 'passed' || item.status === 'failed');
	assert.equal(assertions.length, 1, '対象のテストを一件だけ実行します。');
	return { status: result.status, failed: assertions.filter(item => item.status === 'failed').map(item => ({ name: item.fullName, message: item.failureMessages.join('\n') })) };
}

const pattern = '変異検出: 改行の後の括弧を呼び出しとして解析する';
try {
	typecheck();
	assert.equal(test('baseline', pattern).status, 0);
	assert.equal(original.split(before).length - 1, 1, '変異する箇所は一意でなければなりません。');
	writeFileSync(file, original.replace(before, after));
	typecheck();
	// 一般の文の組み合わせと、改行をまたぐ呼び出しを別々に観測する。
	const general = test('general-generator', '生成した式を含む文と文の組み合わせ');
	const mutant = test('mutant', pattern);
	assert.equal(mutant.status, 1, '改行後の呼び出しを切る変異が検出されていません。');
	assert.equal(mutant.failed.length, 1, 'コンパイル失敗を変異の検出として数えません。');
	assert.match(mutant.failed[0].message, /Property failed after \d+ tests/u);
	assert.match(mutant.failed[0].message, /Counterexample:/u);
	console.log(JSON.stringify({ mutation: '改行後の括弧を呼び出しとして読まない', generalGeneratorStatus: general.status, detectedBy: mutant.failed.map(item => item.name) }));
} finally {
	writeFileSync(file, original);
	rmSync(temporary, { recursive: true, force: true });
}
typecheck();
// 復元後のテストも同じ出力形式で実行する。
const restored = spawnSync('bun', ['run', 'test', 'test/v2/differential.ts', '-t', pattern], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
assert.equal(restored.status, 0, restored.stdout + restored.stderr);
console.log(JSON.stringify({ mutations: 1, detected: 1, restored: true }));
