import { expect, test } from 'vitest';
import { diagnostic, formatDiagnostic } from '../../src/v2/diagnostics.js';
import type { CatalogEntry } from '../../src/v2/catalog.js';
import { catalog } from '../../src/v2/stdlib/index.js';

test('型の診断を日英と範囲付きで表示する', () => {
	const loc = { start: { line: 3, column: 5 }, end: { line: 3, column: 11 } };
	const d = diagnostic('TYPE_ANNOTATION_MISMATCH', loc.start, { name: 'x', expected: 'number', actual: 'string', value: '"text"' }, { loc });
	expect(d.loc).toEqual(loc);
	expect(formatDiagnostic(d, 'ja')).toContain('x は number と書かれていますが、string の値 "text" が入りました。 (3 行目、5 列目)');
	expect(formatDiagnostic(d, 'en')).toContain('x is annotated as number, but received the string value "text". (line 3, column 5)');
	expect(d.severity).toBe('error');
	expect(diagnostic('CASE_FALLTHROUGH', loc.start, {}, { severity: 'warning', loc }).severity).toBe('warning');
});

test('標準一覧とホスト定義は同じ公開型を使う', () => {
	const host: CatalogEntry = { name: 'Mk.api', receiver: 'global', args: [{ name: 'endpoint', type: 'string' }, { name: 'params', type: 'any', optional: true }], returns: 'any', description: { ja: 'API を呼び出します。', en: 'Calls the API.' } };
	const entries: readonly CatalogEntry[] = [...catalog, host];
	expect(entries.at(-1)).toEqual(JSON.parse(JSON.stringify(host)));
	expect(entries.some(entry => 'kind' in entry && entry.kind === 'constant')).toBe(true);
});


test('実行時の型不一致も位置付きの日英文を持つ', async () => {
	const { runtimeError } = await import('../../src/v2/runtime/errors.js');
	const error = runtimeError('TYPE_ANNOTATION_MISMATCH', { line: 3, column: 5 }, { name: 'x', expected: 'number', actual: 'string', value: '\"text\"' }, 'TypeError');
	expect(error.message).toContain('(3 行目、5 列目)');
	expect(formatDiagnostic(error, 'en')).toContain('(line 3, column 5)');
});
