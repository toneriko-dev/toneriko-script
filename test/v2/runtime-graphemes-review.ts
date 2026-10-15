import { describe, expect, test } from 'vitest';
import { GraphemeCache } from '../../src/v2/runtime/strings.js';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const partsOf = (value: string): string[] => [...segmenter.segment(value)].map(part => part.segment);
const alphabet = ['a', '\r', '\n', '\r\n', '\u0301', '\u200d', '👍', '🇯', '🇵', '🏽', 'é', '👨', 'x', 'ab\r', '\nb', 'ᄀ', 'ᅡ', 'ᆨ', 'a'.repeat(20) + '\r', '\n' + 'b'.repeat(20), '\ud83d', '\ude00', 'क', '्', 'ष'];
const random = (initial: number): (() => number) => {
	let seed = initial;
	return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
};

describe('書記素境界とキャッシュの回帰', () => {
	test('繰り返し読む長い文章を LRU で保持する', async () => {
		const interpreter = new Interpreter({ text: 'あ'.repeat(8000) }, { maxSteps: 400_000 });
		await interpreter.exec(parse('let o = ""; for (let i = 0; i < text.length; i++) { o = o + i + ","; }').program);
		expect(interpreter.stepCount).toBeLessThan(400_000);
	});

	for (const [left, right] of [
		['👩', '‍👩'], ['👩', '🏽‍👩'], ['क्', 'ष'], ['क', '्ष'],
		['🇯', '🇵🇯🇵🇯'], ['🇯🇵🇯', '🇵🇯🇵'], ['\ud83c', '\uddef🇵'],
		['a' + '\u0301'.repeat(100), '\u0301b'],
	]) {
		test(`境界の影響が後続へ及ぶ連結 ${JSON.stringify([left, right])}`, () => {
			const cache = new GraphemeCache();
			cache.info(left!); cache.info(right!);
			const value = cache.concat(left!, right!);
			const parts = partsOf(value);
			expect(cache.info(value).length).toBe(parts.length);
			expect(cache.graphemes(value)).toEqual(parts);
		});
	}

	for (const character of ['あ', '👍🏽']) {
		test(`${character} の長さだけを読む 10 万回の連結は境界だけを分割する`, () => {
			let steps = 0;
			const limit = character.length * 200_000 + 100;
			const cache = new GraphemeCache(() => { if (++steps > limit) throw new Error('走査回数の上限'); });
			let value = '';
			for (let i = 0; i < 100_000; i++) {
				expect(cache.info(value).length).toBe(i);
				value = cache.concat(value, character);
			}
			expect(cache.info(value).length).toBe(100_000);
			expect(cache.info(value).parts).toBeNull();
			expect(steps).toBeLessThan(limit);
			expect(cache.stats.cacheEntries).toBeLessThanOrEqual(64);
			expect(cache.stats.cacheCharacters).toBeLessThanOrEqual(1_048_576);
		});
	}

	test('非 ASCII 連結の添字用分割も 64 ステップ以内で譲る', () => {
		let steps = 0;
		const cache = new GraphemeCache(() => steps++);
		const left = '👍🏽'.repeat(1000);
		cache.info(left);
		const value = cache.concat(left, 'あ');
		let previous = steps;
		for (const _ of cache.prepareParts(value)) {
			expect(steps - previous).toBeLessThanOrEqual(64);
			previous = steps;
		}
		expect(steps - previous).toBeLessThanOrEqual(64);
		expect(cache.at(value, 1000)).toBe('あ');
	});

	test('混在した文字を +・+=・テンプレートで連結して Intl.Segmenter と一致する', async () => {
		const rnd = random(0x1a2b3c4d);
		for (let trial = 0; trial < 300; trial++) {
			const pieces = Array.from({ length: 2 + Math.floor(rnd() * 9) }, () => alphabet[Math.floor(rnd() * alphabet.length)]!);
			let source = 'let s = "";';
			let value = '';
			const expected: unknown[] = [];
			for (const piece of pieces) {
				const literal = JSON.stringify(piece);
				source += trial % 3 === 0 ? `s = s + ${literal};` : trial % 3 === 1 ? `s += ${literal};` : 's = `${s}${' + literal + '}`;';
				value += piece;
				source += 'out(s.length);'; expected.push(partsOf(value).length);
			}
			source += 'out(s[0]); out(s.at(-1)); const parts = []; for (const ch of s) parts.push(ch); out(parts);';
			const parts = partsOf(value);
			expected.push(parts[0], parts.at(-1), parts);
			const output: unknown[] = [];
			await new Interpreter({ out: (item: unknown) => { output.push(item); } }).exec(parse(source).program);
			expect(output, JSON.stringify(pieces)).toEqual(expected);
		}
	});

	test('極端に小さいキャッシュでも境界と添字を保つ', () => {
		const rnd = random(7);
		for (const limits of [{ maxEntries: 0 }, { maxEntries: 1 }, { maxEntries: 2, maxCharacters: 10 }, { maxEntries: 3, maxCharacters: 40 }, {}]) {
			for (let trial = 0; trial < 500; trial++) {
				const cache = new GraphemeCache(undefined, limits);
				const pool = [''];
				for (let i = 0; i < 12; i++) {
					const left = pool[Math.floor(rnd() * pool.length)]!;
					const right = rnd() < 0.5 ? alphabet[Math.floor(rnd() * alphabet.length)]! : pool[Math.floor(rnd() * pool.length)]!;
					pool.push(cache.concat(left, right));
					const value = pool[Math.floor(rnd() * pool.length)]!;
					const parts = partsOf(value);
					expect(cache.info(value).length).toBe(parts.length);
					expect(cache.at(value, parts.length - 1)).toBe(parts.at(-1));
					expect(cache.graphemes(value)).toEqual(parts);
				}
			}
		}
	});
});
