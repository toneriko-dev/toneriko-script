import { describe, expect, test, vi } from 'vitest';
import { GraphemeCache } from '../../src/v2/runtime/strings.js';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const partsOf = (value: string): string[] => [...segmenter.segment(value)].map(part => part.segment);

describe('巨大な書記素と同じ長さのキャッシュ', () => {
	test('巨大な一書記素もコード単位で数え、短い文脈だけを Intl に渡す', () => {
		const value = 'a' + '\u0301'.repeat(262_144);
		const original = Intl.Segmenter.prototype.segment;
		let longest = 0;
		const spy = vi.spyOn(Intl.Segmenter.prototype, 'segment').mockImplementation(function (this: Intl.Segmenter, input: string) {
			longest = Math.max(longest, input.length);
			return original.call(this, input);
		});
		try {
			let steps = 0;
			let previous = 0;
			let pauses = 0;
			const cache = new GraphemeCache(() => steps++);
			for (const _ of cache.prepare(value)) {
				expect(steps - previous).toBeLessThanOrEqual(64);
				previous = steps; pauses++;
			}
			expect(steps - previous).toBeLessThanOrEqual(64);
			expect(steps).toBeGreaterThanOrEqual(value.length);
			expect(pauses).toBeGreaterThanOrEqual(Math.floor(value.length / 64));
			expect(longest).toBeLessThanOrEqual(8);
			expect(cache.graphemes(value)).toEqual([value]);
		} finally { spy.mockRestore(); }
	});

	test('巨大な一書記素の走査中にステップ上限で止まる', async () => {
		const interpreter = new Interpreter({ text: 'a' + '\u0301'.repeat(262_144) }, { maxSteps: 1000 });
		await expect(interpreter.exec(parse('text.length;').program)).rejects.toMatchObject({ code: 'STEP_LIMIT_EXCEEDED' });
	});

	test('巨大な一書記素の走査中に abort できる', async () => {
		let clock = 0;
		let yields = 0;
		const interpreter = new Interpreter({ text: 'a' + '\u0301'.repeat(262_144) }, {
			now: () => ++clock, yieldInterval: 1, maxBusyTime: 100_000,
			yieldToHost: async () => { if (++yields === 2) interpreter.abort(); },
		});
		await expect(interpreter.exec(parse('text.length;').program)).rejects.toMatchObject({ code: 'EXECUTION_ABORTED' });
		expect(yields).toBe(2);
	});

	test('同じ長い接頭辞を持つ同長文字列を交互に読んでも再比較しない', () => {
		const prefix = 'あ'.repeat(10_000);
		const values = [prefix + 'a', prefix + 'b', prefix + 'c'];
		const cache = new GraphemeCache();
		for (const value of values) cache.info(value);
		const before = cache.stats.stringComparisons;
		for (let i = 0; i < 1000; i++) expect(cache.info(values[i % values.length]!).length).toBe(10_001);
		expect(cache.stats.stringComparisons - before).toBe(0);
	});

	test('同じ連結結果の再登録でも LRU と長さ別の索引が一致する', () => {
		const cache = new GraphemeCache(undefined, { maxEntries: 4 });
		cache.info('a'); cache.info('b');
		for (let i = 0; i < 100; i++) expect(cache.concat('a', 'b')).toBe('ab');
		expect(cache.stats.cacheEntries).toBe(3);
		expect(cache.stats.cacheCharacters).toBe(4);
		cache.info('xyz'); cache.info('other');
		const scanned = cache.stats.scannedCharacters;
		expect(cache.info('ab').length).toBe(2);
		expect(cache.stats.scannedCharacters).toBe(scanned);
	});

	test('有限状態の分割が広い文字集合と小さいキャッシュで Intl と一致する', () => {
		const alphabet = ['a', '\r', '\n', '\u0001', 'क', '्', '़', 'ष', 'ा', 'ः', 'ᄀ', 'ᅡ', 'ᆨ', '가', '각',
			'؀', 'ൎ', 'ำ', 'ຳ', 'ก', '©', '❤', '️', '🏽', '\u200d', '\u{e0067}', '\u{e007f}', '🏴', '🇯', '🇵',
			'́', '\ud83d', '\ude00', '👍', '👨', '👩', 'é', 'א', 'م', 'ٰ', '\u200c', 'ক', '্', 'क्\u0301\u200d'];
		let state = 0x36a92f14;
		const random = (): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
		for (const limits of [{}, { maxEntries: 0 }, { maxEntries: 2, maxCharacters: 10 }]) {
			const cache = new GraphemeCache(undefined, limits);
			for (let trial = 0; trial < 1000; trial++) {
				let value = '';
				for (let i = 0, count = 1 + Math.floor(random() * 60); i < count; i++) value += alphabet[Math.floor(random() * alphabet.length)]!;
				const parts = partsOf(value);
				expect(cache.info(value).length, JSON.stringify(value)).toBe(parts.length);
				expect(cache.graphemes(value), JSON.stringify(value)).toEqual(parts);
				expect(cache.at(value, parts.length - 1)).toBe(parts.at(-1));
			}
		}
	});
});
