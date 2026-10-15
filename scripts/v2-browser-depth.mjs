import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Playwright を持つ package.json は PLAYWRIGHT_PACKAGE_JSON で指定できます。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(process.env.PLAYWRIGHT_PACKAGE_JSON ?? join(root, 'package.json')));
const { chromium, firefox, webkit } = require('@playwright/test');
const directory = await mkdtemp(join(root, '.git', 'v2-browser-depth-'));
const results = [];
try {
	const entry = join(directory, 'entry.ts');
	await writeFile(entry, `
import { parse } from ${JSON.stringify(join(root, 'src/v2/parser/index.ts'))};
import { Interpreter } from ${JSON.stringify(join(root, 'src/v2/interpreter.ts'))};
const forms = [
 ['array', n => 'const value = ' + '['.repeat(n) + '1' + ']'.repeat(n)],
 ['parenthesis', n => '('.repeat(n) + '1' + ')'.repeat(n)],
 ['object', n => 'const value = ' + '{x:'.repeat(n) + '1' + '}'.repeat(n)],
 ['block', n => '{'.repeat(n) + ';' + '}'.repeat(n)],
 ['function', n => 'function f(){'.repeat(n) + 'return 1;' + '}'.repeat(n)],
 ['arrow', n => 'const f = ' + 'x => '.repeat(n) + '1'],
 ['typedDefaultArrow', n => 'const f = ' + '(p = '.repeat(n) + '1' + '): number => p'.repeat(n)],
 ['arrayBinding', n => 'let ' + '['.repeat(n) + 'x' + ']'.repeat(n) + ' = data'],
 ['objectBinding', n => 'let ' + '{x:'.repeat(n) + 'x' + '}'.repeat(n) + ' = objectData'],
 ['typeParenthesis', n => 'let x: ' + '('.repeat(n) + 'number' + ')'.repeat(n) + ' = 1'],
 ['typeObject', n => 'let x: ' + '{x:'.repeat(n) + 'number' + '}'.repeat(n) + ' = null'],
 ['template', n => '\\x60x\\x24{'.repeat(n) + '1' + '}\\x60'.repeat(n)],
 ['arguments', n => 'identity('.repeat(n) + '1' + ')'.repeat(n)],
 ['computedMember', n => 'lookup['.repeat(n) + '0' + ']'.repeat(n)],
 ['ifBody', n => 'if (true) '.repeat(n) + ';'],
 ['switch', n => 'switch (0) { case 0: '.repeat(n) + ';' + '}'.repeat(n)],
 ['conditionalConsequent', n => 'true ? '.repeat(n) + '1' + ' : 0'.repeat(n)],
];
const chains = [
 ['addition', n => 'out(' + Array(n).fill('1').join(' + ') + ')', 10000],
 ['string', n => 'let x = "a"; out((' + Array(n).fill('x').join(' + ') + ').length)', 10000],
 ['logical', n => 'out(' + Array(n).fill('true').join(' && ') + ')', true],
 ['nullish', n => 'out(' + Array(n).fill('null').join(' ?? ') + ' ?? 1)', 1],
 ['member', n => 'out(chain' + '.next'.repeat(n) + ' === chain)', true],
 ['call', n => 'out(next' + '()'.repeat(n) + ' === next)', true],
 ['optional', n => 'out(null' + '?.next'.repeat(n) + ')', null],
 ['elseIf', n => 'let r = -1; ' + Array.from({ length: n }, (_, i) => 'if (' + i + ' === ' + (n - 1) + ') r = ' + i + '; else ').join('') + 'r = -2; out(r)', 9999],
 ['conditional', n => 'out(' + Array.from({ length: n }, (_, i) => i + ' === ' + (n - 1) + ' ? ' + i + ' : ').join('') + '-1)', 9999],
];
(globalThis as any).probeDepth = async () => {
 const rows = [];
 let data = 1, objectData = 1;
 for (let i = 0; i < 256; i++) { data = [data]; objectData = { x: objectData }; }
 for (const [name, source] of forms) {
  const t0 = performance.now();
  const program = parse(source(256)).program;
  const parseMs = performance.now() - t0;
  for (const depth of [257, 10000]) {
   let refused = false;
   try { parse(source(depth)); } catch (error) { if (error.code !== 'NESTING_TOO_DEEP') throw error; refused = true; }
   if (!refused) throw new Error(name + ': ' + depth + ' accepted');
  }
  await new Interpreter({ data, objectData, identity: x => x, lookup: { 0: 0 } }, { maxSteps: 1000000 }).exec(program);
  rows.push({ name, depth: 256, parseMs, evaluated: true, rejected: [257, 10000] });
 }
 for (const [name, source] of [['unary', n => '!'.repeat(n) + 'true'], ['rightBinary', n => '1 ** '.repeat(n) + '1']]) {
  const program = parse(source(1024)).program;
  await new Interpreter({}, { maxSteps: 100000 }).exec(program);
  for (const size of [1025, 10000]) {
   let refused = false;
   try { parse(source(size)); } catch (error) { if (error.code !== 'NESTING_TOO_DEEP') throw error; refused = true; }
   if (!refused) throw new Error(name + ': ' + size + ' accepted');
  }
  rows.push({ name, chainLimit: 1024, evaluated: true, rejected: [1025, 10000] });
 }
 for (const source of [
  '!'.repeat(1024) + '('.repeat(256) + 'true' + ')'.repeat(256),
  '('.repeat(256) + '!'.repeat(1024) + 'true' + ')'.repeat(256),
 ]) {
  await new Interpreter({}, { maxSteps: 100000 }).exec(parse(source).program);
  rows.push({ name: 'mixed-' + source[0], depth: 256, chainLimit: 1024, evaluated: true });
 }
 for (const [name, source, expected] of chains) {
  const output = [], chain = {}; chain.next = chain;
  const next = () => next;
  const t0 = performance.now();
  const program = parse(source(10000)).program;
  const parseMs = performance.now() - t0;
  await new Interpreter({ chain, next, out: value => output.push(value) }, { maxSteps: 1000000 }).exec(program);
  if (output.length !== 1 || output[0] !== expected) throw new Error(name + ': ' + JSON.stringify(output));
  rows.push({ name, chainLength: 10000, parseMs, evaluated: true });
 }
 return rows;
};
`);
	const build = spawnSync(process.env.BUN ?? 'bun', ['build', entry, '--target=browser', '--outfile', join(directory, 'bundle.js')], { cwd: root, encoding: 'utf8' });
	if (build.status !== 0) throw new Error(`ブラウザ用バンドルの作成に失敗しました: ${build.stderr || build.error}`);
	const bundle = await readFile(join(directory, 'bundle.js'), 'utf8');
	for (const [name, type] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
		let browser;
		try {
			browser = await type.launch();
			const page = await browser.newPage();
			await page.addScriptTag({ content: bundle });
			const rows = await page.evaluate(() => globalThis.probeDepth());
			results.push({ browser: name, version: browser.version(), passed: true, rows });
		} catch (error) {
			results.push({ browser: name, passed: false, error: String(error) });
		} finally { await browser?.close(); }
	}
} finally { await rm(directory, { recursive: true, force: true }); }
console.log(JSON.stringify({ results }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
