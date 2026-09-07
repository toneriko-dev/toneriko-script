import { decodeUnicodeEscapeSequence, isHighSurrogate, isLowSurrogate, isSurrogatePair } from '../src/utils/characters';
import { describe, expect, test } from 'vitest';

describe('isHighSurrogate', () => {
	const cases: [string, boolean][] = [
		['', false],
		['\uD7FF', false],
		['\uD800', true],
		['\uDBFF', true],
		['\uDC00', false],
		['\uDFFF', false],
		['\uE000', false],
	];

	test.concurrent.each(cases)('"%s" -> %s', (input, expected) => {
		expect(isHighSurrogate(input)).toBe(expected);
	});

	test.concurrent('index out of range', () => {
		expect(isHighSurrogate('\uD800', 1)).toBe(false);
	});
});

describe('isLowSurrogate', () => {
	const cases: [string, boolean][] = [
		['', false],
		['\uD7FF', false],
		['\uD800', false],
		['\uDBFF', false],
		['\uDC00', true],
		['\uDFFF', true],
		['\uE000', false],
	];

	test.concurrent.each(cases)('"%s" -> %s', (input, expected) => {
		expect(isLowSurrogate(input)).toBe(expected);
	});

	test.concurrent('index out of range', () => {
		expect(isLowSurrogate('\DC00', 1)).toBe(false);
	});
});

describe('isSurrogatePair', () => {
	const cases: [string, boolean][] = [
		['\uD842\uDFB7', true],
		['\uD83E\uDD2F', true],
		['a', false],
		['\u85CD', false],
		['\uD842', false],
		['\uD8000', false],
		['0\uDC00', false],
		['_\uD842\uDFB7', false],
	];

	test.concurrent.each(cases)('"%s" -> %s', (input, expected) => {
		expect(isSurrogatePair(input)).toBe(expected);
	});

	test.concurrent.each(cases)('start given', () => {
		expect(isSurrogatePair('_\uD842\uDFB7', 1)).toBe(true);
	});
});

describe('decodeUnicodeEscapeSequence', () => {
	test('plain', () => {
		expect(decodeUnicodeEscapeSequence('abc123')).toBe('abc123');
	});

	test('escape', () => {
		expect(decodeUnicodeEscapeSequence('\\u0041')).toBe('A');
	});

	test('escape lowercase', () => {
		expect(decodeUnicodeEscapeSequence('\\u85cd')).toBe('藍');
	});

	test('escape uppercase', () => {
		expect(decodeUnicodeEscapeSequence('\\u85CD')).toBe('藍');
	});

	test('expects "u", unexpected end', () => {
		expect(() => decodeUnicodeEscapeSequence('\\')).toThrow();
	});

	test('expects "u"', () => {
		expect(() => decodeUnicodeEscapeSequence('\\0')).toThrow();
	});

	test('expects digit, unexpected end', () => {
		expect(() => decodeUnicodeEscapeSequence('\\u00')).toThrow();
	});

	test('expects digit', () => {
		expect(() => decodeUnicodeEscapeSequence('\\ug')).toThrow();
	});
});
