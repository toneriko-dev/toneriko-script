import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		coverage: {
			include: ['src'],
		},
		// 時間を検証するテストが差分生成の CPU 負荷と競合しないよう、群の間で実行を待つ。
		projects: [
			{
				test: {
					name: 'v1',
					include: ['test/**'],
					exclude: ['test/testutils.ts', 'test/v2/**'],
					sequence: { groupOrder: 0 },
				},
			},
			{
				test: {
					name: 'v2',
					include: ['test/v2/**'],
					exclude: ['test/v2/differential.ts', 'test/v2/runtime-differential.ts'],
					sequence: { groupOrder: 1 },
				},
			},
			{
				test: {
					name: 'v2-differential',
					include: ['test/v2/differential.ts', 'test/v2/runtime-differential.ts'],
					fileParallelism: false,
					sequence: { groupOrder: 2 },
				},
			},
		],
	},
});
