import { requireString, requireNumber, type StdContext, type StdDefinition, type StdFrame } from './core.js';
import { runtimeError } from '../runtime/errors.js';
import { valueTypeof, scriptObject, type Value } from '../runtime/brands.js';

function* step(ctx: StdContext): StdFrame { ctx.tick(); return yield ctx.checkpoint(); }
type Units = string | readonly string[];
function invalid(ctx: StdContext): never { throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'string | function' }, 'TypeError'); }
function number(ctx: StdContext, value: Value | undefined, fallback = 0): number {
	if (value === undefined) return fallback;
	const numeric = requireNumber(ctx, value);
	return Number.isNaN(numeric) ? 0 : Math.trunc(numeric);
}
function string(ctx: StdContext, value: Value | undefined): string {
	return requireString(ctx, value);
}
function* units(ctx: StdContext, value: string): Generator<any, Units, any> {
	for (const _ of ctx.properties.prepare(value, ctx.pos, true)) yield ctx.checkpoint();
	// ASCII のキャッシュは添字アクセスを直接使い、文字ごとの配列を作らない。
	const length = ctx.properties.get(value, 'length', ctx.pos) as number;
	return length === value.length ? value : ctx.properties.graphemes(value);
}
function* portion(ctx: StdContext, value: Units, start: number, end: number): Generator<any, string, any> {
	const result: string[] = [];
	for (let i = start; i < end; i++) { result.push(value[i]!); yield* step(ctx); }
	return result.join('');
}
function bounded(index: number, length: number): number { return Math.min(length, Math.max(0, index)); }
function relative(index: number, length: number): number { return bounded(index < 0 ? length + index : index, length); }

/** UTF-16 の位置と書記素の位置を一度だけ対応付け、検索を線形に保つ。 */
function* boundaries(ctx: StdContext, input: Units): Generator<any, Map<number, number> | null, any> {
	if (typeof input === 'string') return null;
	const result = new Map<number, number>();
	let offset = 0;
	for (let i = 0; i < input.length; i++) { result.set(offset, i); offset += input[i]!.length; yield* step(ctx); }
	result.set(offset, input.length);
	return result;
}
function partialMatch(ctx: StdContext): never { throw runtimeError('STRING_GRAPHEME_MATCH', ctx.pos, {}, 'TypeError'); }
/** 接頭辞表は検索ごとに一度だけ作り、途中の一致も同じ走査で判定する。 */
function* matches(ctx: StdContext, input: Units, needle: Units, start = 0, limit = 1, includes = false): Generator<any, number[], any> {
	const found: number[] = [];
	if (needle.length === 0) {
		for (let i = start; i <= input.length && found.length < limit; i++) { found.push(i); yield* step(ctx); }
		return found;
	}
	const positions = yield* boundaries(ctx, input);
	const raw = typeof input === 'string' ? input : input.join('');
	const search = typeof needle === 'string' ? needle : needle.join('');
	let offset = start;
	if (positions) { offset = 0; for (let i = 0; i < start; i++) { offset += input[i]!.length; yield* step(ctx); } }
	const prefix: number[] = [0];
	for (let i = 1, j = 0; i < search.length; i++) {
		while (j > 0 && search[i] !== search[j]) { j = prefix[j - 1]!; yield* step(ctx); }
		if (search[i] === search[j]) j++;
		prefix[i] = j; yield* step(ctx);
	}
	let partial = false;
	for (let i = offset, j = 0; i < raw.length; i++) {
		while (j > 0 && raw[i] !== search[j]) { j = prefix[j - 1]!; yield* step(ctx); }
		if (raw[i] === search[j]) j++;
		yield* step(ctx);
		if (j === search.length) {
			const index = positions ? positions.get(i - j + 1) : i - j + 1;
			if (index === undefined || (positions && !positions.has(i + 1))) {
				if (!includes) return partialMatch(ctx);
				partial = true;
				j = prefix[j - 1]!;
				continue;
			}
			found.push(index);
			if (found.length === limit) return found;
			j = 0;
		}
	}
	if (includes && partial && !found.length) return partialMatch(ctx);
	return found;
}
const arg = (name: string, type = 'number', optional = false) => ({ name, type, optional });
function def(name: string, args: StdDefinition['args'], returns: string, ja: string, en: string, implementation: StdDefinition['implementation']): StdDefinition {
	return { name, receiver: 'string', args, returns, description: { ja, en }, implementation };
}
export const stringDefinitions: StdDefinition[] = [
	...['slice', 'substring'].map(name => def(name, [arg('start', 'number', true), arg('end', 'number', true)], 'string', '書記素の範囲を取り出す。', 'Extract a grapheme range.', function* (ctx, receiver, args) {
		const input = yield* units(ctx, string(ctx, receiver));
		const clamp = name === 'slice' ? relative : bounded;
		let start = clamp(number(ctx, args[0]), input.length);
		let end = clamp(number(ctx, args[1], input.length), input.length);
		if (name === 'substring' && start > end) [start, end] = [end, start];
		return yield* portion(ctx, input, start, end);
	})),
	def('at', [arg('index', 'number', true)], 'string | null', '指定した位置の書記素を返す。', 'Return the grapheme at an index.', function* (ctx, receiver, args) {
		const input = yield* units(ctx, string(ctx, receiver));
		const index = number(ctx, args[0]);
		return input[index < 0 ? input.length + index : index] ?? null;
	}),
	...['indexOf', 'includes', 'startsWith', 'endsWith'].map(name => def(name, [arg('search', 'string'), arg('position', 'number', true)], name === 'indexOf' ? 'number' : 'boolean', '書記素の境界で文字列を検索する。', 'Search at grapheme boundaries.', function* (ctx, receiver, args) {
		const input = yield* units(ctx, string(ctx, receiver));
		const needle = yield* units(ctx, string(ctx, args[0]));
		const position = bounded(number(ctx, args[1], name === 'endsWith' ? input.length : 0), input.length);
		if (name === 'startsWith' || name === 'endsWith') {
			if (!needle.length) return true;
			const positions = yield* boundaries(ctx, input);
			const raw = string(ctx, receiver), search = string(ctx, args[0]);
			let offset = position;
			if (positions) { offset = 0; for (let i = 0; i < position; i++) { offset += input[i]!.length; yield* step(ctx); } }
			const start = name === 'endsWith' ? offset - search.length : offset;
			if (start < 0 || start + search.length > raw.length) return false;
			for (let i = 0; i < search.length; i++) { yield* step(ctx); if (raw[start + i] !== search[i]) return false; }
			if (positions && (!positions.has(start) || !positions.has(start + search.length))) return partialMatch(ctx);
			return true;
		}
		const index = (yield* matches(ctx, input, needle, position, 1, name === 'includes'))[0] ?? -1;
		return name === 'indexOf' ? index : index !== -1;
	})),
	...['padStart', 'padEnd'].map(name => def(name, [arg('targetLength'), arg('fill', 'string', true)], 'string', '指定した書記素数まで埋める。', 'Pad to the requested grapheme length.', function* (ctx, receiver, args) {
		const original = string(ctx, receiver);
		const input = yield* units(ctx, original);
		const target = Math.max(0, number(ctx, args[0]));
		const fill = yield* units(ctx, args[1] === undefined ? ' ' : string(ctx, args[1]));
		if (target <= input.length || fill.length === 0) return original;
		if (!Number.isSafeInteger(target)) throw runtimeError('STDLIB_ARGUMENT_RANGE', ctx.pos, {}, 'RangeError');
		const result: string[] = [];
		for (let i = 0; i < target - input.length; i++) { result.push(fill[i % fill.length]!); yield* step(ctx); }
		const padding = result.join('');
		return name === 'padStart' ? ctx.properties.concat(padding, original) : ctx.properties.concat(original, padding);
	})),
	...['trim', 'toUpperCase', 'toLowerCase'].map(name => def(name, [], 'string', '文字列を変換する。', 'Transform the string.', function* (ctx, receiver) {
		const input = string(ctx, receiver);
		for (let i = 0; i < input.length; i++) yield* step(ctx);
		return name === 'trim' ? input.trim() : name === 'toUpperCase' ? input.toUpperCase() : input.toLowerCase();
	})),
	def('split', [arg('separator', 'string', true), arg('limit', 'number', true)], 'string[]', '書記素の境界で文字列を分割する。', 'Split the string at grapheme boundaries.', function* (ctx, receiver, args) {
		const original = string(ctx, receiver);
		const limit = args[1] === undefined ? 0xffffffff : number(ctx, args[1]) >>> 0;
		if (limit === 0) return scriptObject([]);
		if (args[0] === undefined) return scriptObject([original]);
		const input = yield* units(ctx, original);
		const separator = yield* units(ctx, string(ctx, args[0]));
		const result: string[] = [];
		if (!separator.length) {
			for (let i = 0; i < Math.min(limit, input.length); i++) { result.push(input[i]!); yield* step(ctx); }
			return scriptObject(result);
		}
		const positions = yield* matches(ctx, input, separator, 0, limit);
		let start = 0;
		for (const position of positions) {
			result.push(yield* portion(ctx, input, start, position)); start = position + separator.length;
			if (result.length === limit) return scriptObject(result);
		}
		result.push(yield* portion(ctx, input, start, input.length));
		return scriptObject(result);
	}),
	...['replace', 'replaceAll'].map(name => def(name, [arg('search', 'string'), arg('replacement', 'string | Function')], 'string', '一致した文字列を置き換える。', 'Replace matching strings.', function* (ctx, receiver, args) {
		const original = string(ctx, receiver);
		const search = string(ctx, args[0]);
		const replacement = args[1];
		const callable = replacement !== undefined && valueTypeof(replacement) === 'function';
		if (!callable && typeof replacement !== 'string') return invalid(ctx);
		const input = yield* units(ctx, original);
		const needle = yield* units(ctx, search);
		const positions = yield* matches(ctx, input, needle, 0, name === 'replaceAll' ? Infinity : 1);
		const result: string[] = [];
		let start = 0;
		for (const position of positions) {
			result.push(yield* portion(ctx, input, start, position));
			if (callable) result.push(string(ctx, yield ctx.call(replacement!, [search, position, original])));
			else {
				const template = replacement as string;
				for (let i = 0; i < template.length; i++) {
					yield* step(ctx);
					const next = template[i + 1];
					if (template[i] === '$' && (next === '$' || next === '&' || next === '`' || next === "'")) {
						result.push(next === '$' ? '$' : next === '&' ? search : next === '`' ? yield* portion(ctx, input, 0, position) : yield* portion(ctx, input, position + needle.length, input.length));
						i++;
					} else result.push(template[i]!);
				}
			}
			start = position + needle.length;
		}
		result.push(yield* portion(ctx, input, start, input.length));
		return result.join('');
	})),
	def('repeat', [arg('count', 'number', true)], 'string', '文字列を指定回数繰り返す。', 'Repeat the string a specified number of times.', function* (ctx, receiver, args) {
		const input = string(ctx, receiver);
		const count = number(ctx, args[0]);
		if (count < 0 || !Number.isFinite(count)) throw runtimeError('STDLIB_ARGUMENT_RANGE', ctx.pos, {}, 'RangeError');
		if (!input.length) return '';
		const result: string[] = [];
		for (let i = 0; i < count; i++) { result.push(input); yield* step(ctx); }
		return result.join('');
	}),
	def('dedent', [], 'string', '各行に共通する行頭の空白とタブを取り除く。', 'Remove common leading spaces and tabs from lines.', function* (ctx, receiver): StdFrame {
		const input = string(ctx, receiver);
		const lines = input.split('\n');
		let common: string | undefined;
		for (const line of lines) {
			let end = 0;
			while (end < line.length && (line[end] === ' ' || line[end] === '\t')) { end++; yield* step(ctx); }
			if (end === line.length || (end === line.length - 1 && line[end] === '\r')) continue;
			if (common === undefined) common = line.slice(0, end);
			else {
				let length = 0;
				while (length < Math.min(common.length, end) && common[length] === line[length]) { length++; yield* step(ctx); }
				common = common.slice(0, length);
			}
			yield* step(ctx);
		}
		const result: string[] = [];
		for (const line of lines) { result.push(/^[ \t]*\r?$/.test(line) ? line.endsWith('\r') ? '\r' : '' : line.slice(common?.length ?? 0)); yield* step(ctx); }
		return result.join('\n');
	}),
];
