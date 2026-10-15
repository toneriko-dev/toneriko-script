import { defineConfig } from 'tsdown';

export default defineConfig({
	// 利用側が toneriko-script/interpreter/value.js のように下の階層を直接 import するので、
	// まとめずに src のファイルごとに出す
	entry: ['./src/**/*.ts'],
	unbundle: true,
	format: 'esm',
	platform: 'browser',
	target: 'es2022',
	outDir: 'built',
	onSuccess: 'node scripts/v2-stdlib-catalog.mjs',
	// package.json の exports が指す .js と .d.ts の名前で出す
	fixedExtension: false,
	sourcemap: true,
	minify: process.env.NODE_ENV === 'production',
	// 型定義の source map も出す。出さない設定でも .d.ts に参照のコメントが付くため
	dts: { sourcemap: true },
});
