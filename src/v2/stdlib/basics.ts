import type { StdDefinition } from './core.js';
import { requireNumber } from './core.js';
import { runtimeError } from '../runtime/errors.js';

export const basicDefinitions: StdDefinition[] = [
	{
		name: 'push', receiver: 'array', args: [{ name: 'items', type: 'any[]', rest: true }], returns: 'number',
		description: { ja: '末尾に値を追加し、配列の長さを返します。', en: 'Appends values and returns the array length.' },
		*implementation(ctx, receiver, args) {
			if (!Array.isArray(receiver)) throw runtimeError('INVALID_RECEIVER', ctx.pos, {}, 'TypeError');
			for (let i = 0; i < args.length; i++) {
				ctx.tick(); ctx.properties.set(receiver, receiver.length, args[i]!, ctx.pos);
				if (i % 64 === 63) yield ctx.checkpoint();
			}
			return receiver.length;
		},
	},
	{
		name: 'at', receiver: 'string', args: [{ name: 'index', type: 'number', optional: true }], returns: 'string | null',
		description: { ja: '指定した位置の書記素を返します。', en: 'Returns the grapheme at the specified index.' },
		*implementation(ctx, receiver, args) {
			if (typeof receiver !== 'string') throw runtimeError('INVALID_RECEIVER', ctx.pos, {}, 'TypeError');
			for (const _ of ctx.properties.prepare(receiver, ctx.pos)) yield ctx.checkpoint();
			const input = requireNumber(ctx, args[0] ?? 0);
			const length = ctx.properties.get(receiver, 'length', ctx.pos) as number;
			const integer = Number.isNaN(input) ? 0 : Math.trunc(input);
			const index = integer < 0 ? length + integer : integer;
			return index < 0 || index >= length ? null : ctx.properties.get(receiver, index, ctx.pos);
		},
	},
];
