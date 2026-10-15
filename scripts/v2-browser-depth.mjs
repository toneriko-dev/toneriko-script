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
 ['array', n => 'out(' + '['.repeat(n) + ']'.repeat(n) + '.length)'],
 ['parenthesis', n => '('.repeat(n) + '1' + ')'.repeat(n)],
 ['object', n => '(' + '{x:'.repeat(n) + '1' + '}'.repeat(n) + ')'],
 ['block', n => '{'.repeat(n) + ';' + '}'.repeat(n)],
 ['function', n => 'function f(){'.repeat(n) + 'return 1;' + '}'.repeat(n)],
 ['arrow', n => 'const f = ' + 'x => '.repeat(n) + '1'],
 ['typedConditionalArrow', n => 'x = ' + 'a ? (p): number => '.repeat(n) + '1' + ' : y'.repeat(n)],
 ['typedDefaultArrow', n => 'x = ' + '(p = '.repeat(n) + '1' + '): number => p'.repeat(n)],
 ['unary', n => '!'.repeat(n) + 'true'],
 ['rightBinary', n => '1 ** '.repeat(n) + '1'],
 ['leftBinary', n => '1 + '.repeat(n) + '1'],
 ['member', n => 'o' + '.x'.repeat(n)],
 ['conditional', n => 'true ? 1 : '.repeat(n) + '1'],
 ['if', n => 'if (true) '.repeat(n) + ';'],
 ['binding', n => 'let ' + '['.repeat(n) + 'x' + ']'.repeat(n) + ' = []'],
 ['typeParenthesis', n => 'let x: ' + '('.repeat(n) + 'number' + ')'.repeat(n)],
 ['typeArray', n => 'let x: number' + '[]'.repeat(n)],
 ['typeObject', n => 'let x: ' + '{x:'.repeat(n) + 'number' + '}'.repeat(n)],
 ['template', n => '\\x60x\\x24{'.repeat(n) + '1' + '}\\x60'.repeat(n)],
];
(globalThis as any).probeDepth = async () => {
 const rows = [];
 for (const [name, source] of forms) {
  let lastAccepted = 0;
  for (let n = 1; n <= 260; n++) {
   try { parse(source(n)); lastAccepted = n; }
   catch (error) {
    if (error.code !== 'NESTING_TOO_DEEP') throw new Error(name + ':' + n + ':' + error);
    break;
   }
  }
  const program = parse(source(lastAccepted)).program;
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) parse(source(lastAccepted));
  const parseMs = (performance.now() - t0) / 5;
  let thrown = false;
  try { parse(source(4000)); } catch (error) { if (error.code !== 'NESTING_TOO_DEEP') throw error; thrown = true; }
  if (!thrown) throw new Error(name + ': deep source accepted');
  let evaluated = false;
  if (!['member', 'binding', 'typedConditionalArrow', 'typedDefaultArrow'].includes(name)) {
   await new Interpreter({out(){}}, {maxSteps: 100_000}).exec(program);
   evaluated = true;
  }
  rows.push({name, lastAccepted, parseMs, evaluated});
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
