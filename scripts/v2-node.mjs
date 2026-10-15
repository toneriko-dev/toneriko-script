import { existsSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// bun run --bun は PATH の先頭に Bun を指す node を置くため、参照実行には実体を確認した Node を使います。
function findNode() {
	if (!process.versions.bun) return process.execPath;
	const current = realpathSync(process.execPath);
	for (const directory of (process.env.PATH ?? '').split(delimiter)) {
		const candidate = join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
		if (!existsSync(candidate) || realpathSync(candidate) === current) continue;
		const result = spawnSync(candidate, ['--eval', 'if (process.versions.bun) process.exit(1); process.stdout.write(process.execPath);'], {
			encoding: 'utf8', timeout: 5000,
		});
		if (result.status === 0 && existsSync(result.stdout)) return result.stdout;
	}
	throw new Error('Node の参照実行には実際の Node.js 実行ファイルが必要です。');
}
export const nodeExecutable = findNode();
