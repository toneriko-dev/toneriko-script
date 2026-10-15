import type { StdDefinition } from './core.js';
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
];
