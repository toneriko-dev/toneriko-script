import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Playwright を持つ package.json は PLAYWRIGHT_PACKAGE_JSON で指定できます。
// 例: PLAYWRIGHT_PACKAGE_JSON=/path/to/package.json node scripts/v2-browser-errors.mjs
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(process.env.PLAYWRIGHT_PACKAGE_JSON ?? join(root, 'package.json')));
const { chromium, firefox, webkit } = require('@playwright/test');
const hiddenKeys = ['stack', 'sourceURL', 'line', 'column', 'originalLine', 'originalColumn', 'fileName', 'lineNumber', 'columnNumber'];
const directory = await mkdtemp(join(root, '.git', 'v2-browser-errors-'));
const results = [];
try {
	const entry = join(directory, 'entry.ts');
	await writeFile(entry, `
import { parse } from ${JSON.stringify(join(root, 'src/v2/parser/index.ts'))};
import { Interpreter } from ${JSON.stringify(join(root, 'src/v2/interpreter.ts'))};
const hiddenKeys = ${JSON.stringify(hiddenKeys)};
let hostError: any;
function hostBoom() {
	try { JSON.parse('{'); }
	catch (error) { hostError = error; throw error; }
}
function decoratedBoom() {
	const error = new Error('decorated');
	for (const key of hiddenKeys) Object.defineProperty(error, key, { value: 'private', enumerable: true, configurable: true });
	Object.assign(error, { code: 'APP_ERROR', status: 409 });
	Object.defineProperty(error, 'privateDetail', { value: 'private' });
	throw error;
}
(globalThis as any).probeErrors = async () => {
	const cases = [];
	for (const [name, action] of [['host', 'hostBoom()'], ['decoratedHost', 'decoratedBoom()'], ['runtime', 'null.x']]) {
		const output: unknown[] = [];
		const body = 'try { ' + action + '; } catch (e) { const copy = {...e}; '
			+ 'for (const key of keys) { out({ key: key, value: e[key], present: key in e, spread: key in copy }); } '
			+ 'out({ name: e.name, code: e.code, status: e.status, privateDetail: e.privateDetail }); }';
		await new Interpreter({ keys: hiddenKeys, hostBoom, decoratedBoom, out: (value: unknown) => { output.push(value); } }).exec(parse(body).program);
		cases.push({ name, output });
	}
	return { cases, nativeOwnKeys: Object.getOwnPropertyNames(hostError), nativeStackHasBundleUrl: String(hostError.stack).includes('/host/bundle.js') };
};
`);
	const build = spawnSync(process.env.BUN ?? 'bun', ['build', entry, '--target=browser', '--outfile', join(directory, 'bundle.js')], { cwd: root, encoding: 'utf8' });
	if (build.status !== 0) throw new Error(`ブラウザ用バンドルの作成に失敗しました: ${build.stderr || build.error}`);
	const bundle = await readFile(join(directory, 'bundle.js'), 'utf8');
	// ブラウザを順番に閉じ、複数エンジンのメモリを同時に保持しません。
	for (const [name, type] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
		let browser;
		try {
			browser = await type.launch();
			const page = await browser.newPage();
			await page.route('http://probe.test/**', route => route.request().url().endsWith('/host/bundle.js')
				? route.fulfill({ body: bundle, contentType: 'text/javascript' })
				: route.fulfill({ body: '<script src="/host/bundle.js"></script>', contentType: 'text/html' }));
			await page.goto('http://probe.test/');
			const observed = await page.evaluate(() => globalThis.probeErrors());
			const failures = [];
			if (!observed.nativeStackHasBundleUrl) failures.push('ホストの例外がバンドルの URL を持っていません');
			for (const item of observed.cases) {
				for (let i = 0; i < hiddenKeys.length; i++) {
					const row = item.output[i];
					if (row.key !== hiddenKeys[i] || row.value !== null || row.present !== false || row.spread !== false) failures.push({ case: item.name, ...row });
				}
				const metadata = item.output[hiddenKeys.length];
				const expectedName = item.name === 'host' ? 'SyntaxError' : item.name === 'runtime' ? 'TypeError' : 'Error';
				if (metadata.name !== expectedName) failures.push({ case: item.name, metadata });
				if (item.name === 'decoratedHost' && (metadata.code !== 'APP_ERROR' || metadata.status !== 409 || metadata.privateDetail !== null)) failures.push({ case: item.name, metadata });
			}
			results.push({ browser: name, version: browser.version(), passed: failures.length === 0, cases: observed.cases.length,
				hiddenKeysPerCase: hiddenKeys.length, operationsPerKey: ['read', 'in', 'spread'],
				nativeOwnKeys: observed.nativeOwnKeys, nativeStackHasBundleUrl: observed.nativeStackHasBundleUrl, failures });
		} catch (error) {
			results.push({ browser: name, passed: false, error: String(error) });
		} finally {
			await browser?.close();
		}
	}
} finally {
	await rm(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ results }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
