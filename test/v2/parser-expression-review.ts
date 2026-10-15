import assert from 'node:assert/strict';
import { describe, test, vi } from 'vitest';
import { parse } from '../../src/v2/parser/index.js';

describe('式の再検査の回帰', () => {
	test('255段の括弧で包んでも中の2000項の連鎖を検査し直さない', () => {
		const source = Array(2_000).fill('a').join('+');
		const checks = (depth: number): number => {
			const isArray = vi.spyOn(Array, 'isArray');
			try {
				const program = parse('out(' + '('.repeat(depth) + source + ')'.repeat(depth) + ')').program;
				assert.equal(program.body.length, 1);
				return isArray.mock.calls.length;
			} finally { isArray.mockRestore(); }
		};
		// 括弧は AST の節を増やさず、子の検査回数も増やしません。
		assert.equal(checks(255), checks(0));
	});
});
