import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// JSON の数値変換で -0・非有限数を失わず、呼び出し時のキー順を記録します。
export function snapshot(value) {
	if (value === null) return ['null'];
	if (typeof value === 'number') return ['number', Object.is(value, -0) ? '-0' : String(value)];
	if (typeof value === 'string' || typeof value === 'boolean') return [typeof value, value];
	if (Array.isArray(value)) return ['array', value.map(snapshot)];
	if (typeof value === 'object') return ['object', Object.keys(value).map(key => [key, snapshot(value[key])])];
	throw new Error(`比較対象外の値: ${typeof value}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (process.versions.bun) throw new Error('参照実行には Bun ではなく Node.js を使います。');
	const sources = JSON.parse(readFileSync(0, 'utf8'));
	const results = [];
	for (const source of sources) {
		const output = [];
		let reached = 0;
		const context = vm.createContext({ out: value => output.push(snapshot(value)), reach: () => { reached++; } });
		let error = null;
		try {
			const module = new vm.SourceTextModule(source, { context });
			await module.link(() => { throw new Error('import は生成しません'); });
			await module.evaluate({ timeout: 1000 });
		} catch (caught) {
			error = caught.name;
		}
		results.push({ output, reached, error });
	}
	process.stdout.write(JSON.stringify(results));
}
