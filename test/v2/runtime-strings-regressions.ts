import { describe, expect, test } from 'vitest';
import { GraphemeCache } from '../../src/v2/runtime/strings.js';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';

describe('連結文字列の書記素キャッシュ', () => {
	test('10 万回の ASCII 連結で過去の全文を走査しない', () => {
		let steps = 0;
		const cache = new GraphemeCache(() => steps++);
		let value = '';
		for (let i = 0; i < 100_000; i++) {
			expect(cache.info(value).length).toBe(i);
			value = cache.concat(value, 'a');
		}
		expect(value).toBe('a'.repeat(100_000));
		expect(cache.info(value).length).toBe(100_000);
		expect(steps).toBeLessThan(300_000);
		expect(cache.stats.scannedCharacters).toBeLessThan(200_000);
		expect(cache.stats.segmentedStrings).toBe(0);
		expect(cache.stats.cacheEntries).toBeLessThanOrEqual(64);
		expect(cache.stats.cacheCharacters).toBeLessThanOrEqual(1_048_576);
	});

	test('保持する件数と文字数を個別に制限する', () => {
		const cache = new GraphemeCache(undefined, { maxEntries: 3, maxCharacters: 12 });
		for (let i = 0; i < 50; i++) {
			cache.info(String(i).padStart(4, 'x'));
			expect(cache.stats.cacheEntries).toBeLessThanOrEqual(3);
			expect(cache.stats.cacheCharacters).toBeLessThanOrEqual(12);
		}
		const oversized = 'x'.repeat(13);
		cache.info(oversized);
		expect(cache.stats.cacheCharacters).toBe(13);
		expect(cache.stats.cacheEntries).toBe(1);
		const scanned = cache.stats.scannedCharacters;
		for (let i = 0; i < 100; i++) {
			expect(cache.info(oversized).length).toBe(13);
			expect(cache.at(oversized, i % 13)).toBe('x');
		}
		expect(cache.stats.scannedCharacters).toBe(scanned);
		cache.info('short');
		expect(cache.stats.cacheCharacters).toBe(5);
		expect(cache.stats.cacheEntries).toBe(1);
		cache.clear();
		expect(cache.stats.cacheEntries).toBe(0);
		expect(cache.stats.cacheCharacters).toBe(0);
	});

	test('未知の長い連結値を同期区間では走査しない', () => {
		let steps = 0;
		const cache = new GraphemeCache(() => steps++);
		const value = cache.concat('x'.repeat(20_000), 'y'.repeat(20_000));
		expect(steps).toBe(0);
		let pauses = 0;
		for (const _ of cache.prepare(value)) pauses++;
		expect(pauses).toBe(625);
		expect(steps).toBe(40_000);
		expect(cache.info(value).length).toBe(40_000);
		expect(steps).toBe(40_000);
	});

	test('巨大な一件を保持中に短い右辺を調べても連結後の情報が残る', () => {
		const cache = new GraphemeCache(undefined, { maxEntries: 64, maxCharacters: 12 });
		let value = 'a'.repeat(100);
		cache.info(value);
		for (let i = 0; i < 100; i++) {
			value = cache.concat(value, 'b');
			expect(cache.info(value).length).toBe(101 + i);
			expect(cache.stats.cacheEntries).toBe(1);
			expect(cache.stats.cacheCharacters).toBe(value.length);
		}
		expect(cache.stats.scannedCharacters).toBe(200);
		expect(value).toBe('a'.repeat(100) + 'b'.repeat(100));
	});

	test('CRLF を連結の境界でも一つと数える', () => {
		const cache = new GraphemeCache();
		let value = '';
		for (const character of ['a', '\r', '\n', 'b', '\r', '\n']) {
			value = cache.concat(value, character);
			cache.info(value);
		}
		expect(cache.info(value).length).toBe(4);
		expect(cache.graphemes(value)).toEqual(['a', '\r\n', 'b', '\r\n']);
		expect(cache.at(value, 2)).toBe('b');
		expect(cache.at(value, 4)).toBeUndefined();
		expect(cache.stats.segmentedStrings).toBe(0);
	});

	test('CRLF の長さだけを読む連結は書記素配列を作らない', () => {
		let steps = 0;
		const cache = new GraphemeCache(() => steps++);
		let value = '';
		for (let i = 0; i < 10_000; i++) {
			value = cache.concat(value, i % 2 ? '\n' : '\r');
			expect(cache.info(value).length).toBe(Math.ceil((i + 1) / 2));
			expect(cache.info(value).parts).toBeNull();
		}
		expect(steps).toBeLessThan(30_000);
		const pauses = [...cache.prepareParts(value)];
		expect(pauses.length).toBe(79);
		expect(cache.at(value, 4999)).toBe('\r\n');
		const scanned = cache.stats.scannedCharacters;
		for (let i = 0; i < 5000; i++) expect(cache.at(value, i)).toBe('\r\n');
		expect(cache.stats.scannedCharacters).toBe(scanned);
	});

	test('文字種判定から分割へ移る区間も 64 ステップ以内で譲る', () => {
		for (const value of ['a'.repeat(63) + 'é', 'a'.repeat(63) + '\r\n']) {
			let steps = 0;
			let previous = 0;
			const gaps: number[] = [];
			const cache = new GraphemeCache(() => steps++);
			for (const _ of cache.prepareParts(value)) {
				gaps.push(steps - previous);
				previous = steps;
			}
			gaps.push(steps - previous);
			expect(Math.max(...gaps)).toBeLessThanOrEqual(64);
			expect(cache.info(value).length).toBe(64);
		}
	});

	for (const [left, right, expected] of [
		['e', '\u0301', ['e\u0301']],
		['👩', '🏽', ['👩🏽']],
		['🇯', '🇵', ['🇯🇵']],
		['👩‍', '👩‍👧‍👦', ['👩‍👩‍👧‍👦']],
		['\r', '\n', ['\r\n']],
	] as const) {
		test(`境界をまたぐ書記素 ${JSON.stringify(left + right)}`, () => {
			const cache = new GraphemeCache();
			cache.info(left); cache.info(right);
			const value = cache.concat(left, right);
			expect(cache.info(value).length).toBe(expected.length);
			expect(cache.graphemes(value)).toEqual(expected);
		});
	}
});

describe('スクリプトからの文字列連結', () => {
	for (const update of ['s += "a";', 's = s + "a";', 's = `${s}a`;']) {
		test(`${update} を 10 万回実行してもステップ数が二乗にならない`, async () => {
			const output: unknown[] = [];
			const interpreter = new Interpreter({ out: (value: unknown) => { output.push(value); } }, { maxSteps: 5_000_000 });
			await interpreter.exec(parse(`let s = ""; while (s.length < 100000) { ${update} } out(s.length); out(s[99999]);`).program);
			expect(output).toEqual([100_000, 'a']);
			expect(interpreter.stepCount).toBeLessThan(5_000_000);
		}, 15_000);
	}

	test('連結で作る CRLF の length、添字、at、反復を一致させる', async () => {
		const output: unknown[] = [];
		await new Interpreter({ out: (value: unknown) => { output.push(value); } }).exec(parse(`
			let s = "a\\r"; s += "\\nb";
			out(s.length); out(s[1]); out(s.at(2));
			for (const character of s) out(character);
		`).program);
		expect(output).toEqual([3, '\r\n', 'b', 'a', '\r\n', 'b']);
	});
});
