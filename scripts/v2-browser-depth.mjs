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
// --margin-only は深さの二つの上限と最終防御を外し、256段から一段ずつ測ります。
// MARGIN_CASE=altTyped で条件式の偽の枝に型付きアローの既定値を重ねた場合も測れます。
// ENGINES と MARGIN_START / MARGIN_END は、未測定の段数から続けるときに指定します。
const marginOnly = process.argv.includes('--margin-only');
const marginCase = process.env.MARGIN_CASE ?? 'mixedSyntax';
const marginStart = Number(process.env.MARGIN_START ?? 256);
const marginEnd = Number(process.env.MARGIN_END ?? 4096);
const engines = new Set((process.env.ENGINES ?? 'node,bun,chromium,firefox,webkit').split(','));
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
 ['altTyped', n => 'const f = ' + 'c ? d : (p = '.repeat(n) + '1' + '): number => p'.repeat(n)],
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
const operators = 'true || false && 0 === 1 < 2 + 3 * 1 ** - ';
const mixed = [
 ['mixedParenthesis', n => (operators + '(').repeat(n) + '1' + ')'.repeat(n)],
 ['mixedArray', n => ('[' + operators).repeat(n) + '1' + ']'.repeat(n)],
 ['mixedCall', n => ('identity(' + operators).repeat(n) + '1' + ')'.repeat(n)],
 ['mixedArrow', n => 'const f = ' + ('(p: number = false ? ' + operators + '1 : ').repeat(n - 1) + '(p: number = 1): number => p' + '): number => p'.repeat(n - 1)],
 ['mixedTemplate', n => ('\\x60\\x24{' + operators).repeat(n) + '1' + '}\\x60'.repeat(n)],
 ['mixedSyntax', n => {
  const pairs = [['(' + operators, ')', 1], ['[' + operators, ']', 1], ['identity(' + operators, ')', 1], ['\\x60\\x24{' + operators, '}\\x60', 1], ['(([p]: number[] = false ? ' + operators + '1 : ', '): number => p)', 3]];
  let prefix = '', suffix = '';
  for (let i = 0, depth = 0; depth < n; i++) {
   const pair = pairs[i % pairs.length];
   if (depth + pair[2] > n || (pair[2] === 3 && depth + 3 === n)) { prefix += '('; suffix = ')' + suffix; depth++; }
   else { prefix += pair[0]; suffix = pair[1] + suffix; depth += pair[2]; }
  }
  return prefix + '1' + suffix;
 }],
 ['evaluatedMixed', n => {
  const pairs = [['false || true && (0 === 1 < 2 + 3 * 1 ** -1 ? null : ', ')', 1], ['[', '][0]', 1], ['identity(', ')', 1], ['\\x60\\x24{', '}\\x60', 1], ['((p: string = ', '): string => p)()', 2], ['(([p]: string[] = [', ']): string => p)()', 4]];
  let prefix = '', suffix = '';
  for (let i = 0, used = 0; used < n - 1; i++) {
   const pair = pairs[i % pairs.length];
   if (used + pair[2] > n - 1) { prefix += '('; suffix = ')' + suffix; used++; }
   else { prefix += pair[0]; suffix = pair[1] + suffix; used += pair[2]; }
  }
  return prefix + 'probe()' + suffix;
 }],
 ['powerThenParenthesis', n => '1 ** '.repeat(1024) + '('.repeat(n) + '1' + ')'.repeat(n)],
 ['powerThenMixedArray', n => 'true || ' + '1 ** '.repeat(500) + ('[' + operators).repeat(n) + '1' + ']'.repeat(n)],
];
const additional = [
 ['unary', n => '!'.repeat(n) + 'true', 1024],
 ['rightBinary', n => '1 ** '.repeat(n) + '1', 1024],
 ['unaryThenParenthesis', n => '!'.repeat(1024) + '('.repeat(n) + 'true' + ')'.repeat(n), 256],
 ['parenthesisThenUnary', n => '('.repeat(n) + '!'.repeat(1024) + 'true' + ')'.repeat(n), 256],
];
(globalThis as any).depthCases = [...forms.map(([name]) => [name, 256]), ...mixed.map(([name]) => [name, 256]), ...additional.map(([name,,size]) => [name, size]), ...chains.map(([name]) => [name, 10000])];
(globalThis as any).probeDepthCase = async (name, depth, parseOnly = false) => {
 const descriptor = [...forms, ...mixed, ...additional, ...chains].find(item => item[0] === name);
 if (!descriptor) throw new Error('unknown case ' + name);
 let phase = 'parse';
 try {
  const start = performance.now();
  const source = descriptor[1](depth) + (name === 'altTyped' && !parseOnly ? '; let value = f; for (let i = 0; i < ' + depth + '; i++) value = value(); out(value);' : '');
  const program = parse(source).program;
  const parseMs = performance.now() - start;
  if (parseOnly) return { name, depth, parseMs, passed: true };
  phase = 'evaluate';
  const output = [], chain = {}; chain.next = chain;
  let reached = 0;
  const next = () => next;
  let data = 1, objectData = 1;
  for (let i = 0; i < depth; i++) { data = [data]; objectData = { x: objectData }; }
  await new Interpreter({ c: false, d: 0, data, objectData, identity: x => x, probe: () => { reached++; return 1; }, lookup: { 0: 0 }, chain, next, out: value => output.push(value) }, { maxSteps: 1000000 }).exec(program);
  if (name === 'altTyped' && (output.length !== 1 || output[0] !== 1)) throw new Error('型付きアローの既定値: ' + JSON.stringify(output));
  if (name === 'evaluatedMixed' && reached !== 1) throw new Error('最内側の呼び出し: ' + reached);
  const isChain = chains.includes(descriptor);
  if (isChain && (output.length !== 1 || output[0] !== descriptor[2])) throw new Error(name + ': ' + JSON.stringify(output));
  if (!isChain) {
   phase = 'reject';
   for (const size of [depth + 1, 10000]) {
    let refused = false;
    try { parse(descriptor[1](size)); } catch (error) { if (error.code !== 'NESTING_TOO_DEEP') throw error; refused = true; }
    if (!refused) throw new Error(name + ': ' + size + ' accepted');
   }
  }
  return { name, depth, parseMs, evaluated: true, reached: name === 'evaluatedMixed' ? reached : undefined, passed: true };
 } catch (error) { return { name, depth, phase, passed: false, error: { name: error.name, code: error.code, message: error.message } }; }
};
`);
	const build = spawnSync(process.env.BUN ?? 'bun', ['build', entry, '--target=browser', '--outfile', join(directory, 'bundle.js')], { cwd: root, encoding: 'utf8' });
	if (build.status !== 0) throw new Error(`ブラウザ用バンドルの作成に失敗しました: ${build.stderr || build.error}`);
	const original = await readFile(join(directory, 'bundle.js'), 'utf8');
	// 上限の検証では最終防御を無効にし、実際のスタック溢れを成功に数えません。
	const bundle = original.replace(/if \(isStackOverflow\(error\)\)(?=\s+throw syntaxError\("NESTING_TOO_DEEP")/, 'if (false)');
	if (bundle === original) throw new Error('スタック溢れの変換を無効にできませんでした');
	await writeFile(join(directory, 'checked.js'), bundle);
	const runner = join(directory, 'runner.mjs');
	await writeFile(runner, `await import('./checked.js'); const [name, depth] = process.argv.slice(2); console.log(JSON.stringify(name ? await globalThis.probeDepthCase(name, Number(depth), process.argv[4] === 'parse') : globalThis.depthCases));`);
	const listed = spawnSync(process.execPath, [runner], { encoding: 'utf8' });
	if (listed.status !== 0) throw new Error(listed.stderr);
	const cases = JSON.parse(listed.stdout);
	const withoutSyntaxGuard = bundle.replace(/MAX_SYNTAX_DEPTH = 256/, 'MAX_SYNTAX_DEPTH = 1000000');
	const unguarded = withoutSyntaxGuard.replace(/MAX_PARSER_DEPTH = \d+/, 'MAX_PARSER_DEPTH = 1000000');
	if (marginOnly && (withoutSyntaxGuard === bundle || unguarded === withoutSyntaxGuard)) throw new Error('深さの上限を測定用に解除できませんでした');
	if (marginOnly) await writeFile(join(directory, 'checked.js'), unguarded);
	for (const [engine, command] of [['node', process.execPath], ['bun', process.env.BUN ?? 'bun']]) {
		if (!engines.has(engine)) continue;
		const rows = [];
		for (const [name, depth] of marginOnly ? [] : cases) {
			const child = spawnSync(command, [runner, name, String(depth)], { encoding: 'utf8', timeout: 30000 });
			if (child.status !== 0) rows.push({ name, passed: false, error: child.stderr || String(child.error) });
			else rows.push(JSON.parse(child.stdout));
		}
		if (marginOnly) {
			for (let depth = marginStart; depth <= marginEnd; depth++) {
				const child = spawnSync(command, [runner, marginCase, String(depth), 'parse'], { encoding: 'utf8', timeout: 30000 });
				const row = child.status === 0 ? JSON.parse(child.stdout) : { passed: false, error: child.stderr || String(child.error) };
				if (!row.passed && (!['RangeError', 'InternalError'].includes(row.error?.name) || !/stack|recursion/i.test(row.error?.message))) throw new Error('スタック以外の失敗: ' + JSON.stringify(row));
				if (!row.passed || depth === marginEnd) { rows.push({ ...row, firstOverflow: row.passed ? null : depth, lastSuccess: row.passed ? depth : depth - 1, margin: row.passed ? null : depth / 256, attempts: depth - marginStart + 1 }); break; }
				if (depth % 100 === 0) console.error(engine + ' margin ' + depth);
			}
		}
		results.push({ engine, version: spawnSync(command, ['--version'], { encoding: 'utf8' }).stdout.trim(), cold: true, passed: marginOnly ? rows[0].lastSuccess >= 256 : rows.every(row => row.passed), rows });
	}
	for (const [name, type] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
		if (!engines.has(name)) continue;
		let browser;
		try {
			browser = await type.launch();
			const rows = [];
			for (const [caseName, depth] of marginOnly ? [] : cases) {
				const page = await browser.newPage();
				await page.addScriptTag({ content: bundle });
				rows.push(await page.evaluate(([caseName, depth]) => globalThis.probeDepthCase(caseName, depth), [caseName, depth]));
				await page.close();
			}
			if (marginOnly) {
				for (let depth = marginStart; depth <= marginEnd; depth++) {
					const page = await browser.newPage();
					await page.addScriptTag({ content: unguarded });
					const row = await page.evaluate(([name, depth]) => globalThis.probeDepthCase(name, depth, true), [marginCase, depth]);
					await page.close();
					if (!row.passed && (!['RangeError', 'InternalError'].includes(row.error?.name) || !/stack|recursion/i.test(row.error?.message))) throw new Error('スタック以外の失敗: ' + JSON.stringify(row));
					if (!row.passed || depth === marginEnd) { rows.push({ ...row, firstOverflow: row.passed ? null : depth, lastSuccess: row.passed ? depth : depth - 1, margin: row.passed ? null : depth / 256, attempts: depth - marginStart + 1 }); break; }
					if (depth % 100 === 0) console.error(name + ' margin ' + depth);
				}
			}
			results.push({ engine: name, version: browser.version(), cold: true, passed: marginOnly ? rows[0].lastSuccess >= 256 : rows.every(row => row.passed), rows });
		} catch (error) { results.push({ engine: name, passed: false, error: String(error) }); }
		finally { await browser?.close(); }
	}
} finally { await rm(directory, { recursive: true, force: true }); }
console.log(JSON.stringify({ results }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
