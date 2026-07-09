import { FN_NATIVE, NULL, NUM } from '../../interpreter/value.js';
import { textEncoder } from '../../const.js';
import { ChaCha20 } from './chacha20.js';
import type { VNativeFn, VNull, Value } from '../../interpreter/value.js';

export async function GenerateChaCha20Random(seed: Value | undefined) : Promise<VNativeFn | VNull> {
	if (!seed || seed.type !== 'num' && seed.type !== 'str' && seed.type !== 'null') return NULL;
	let actualSeed : Uint8Array | undefined = undefined;
	if (seed.type === 'num')
	{
		actualSeed = new Uint8Array(await crypto.subtle.digest('SHA-384', new Uint8Array(new Float64Array([seed.value]))));
	} else if (seed.type === 'str') {
		actualSeed = new Uint8Array(await crypto.subtle.digest('SHA-384', new Uint8Array(textEncoder.encode(seed.value))));
	}
	const rng = new ChaCha20(actualSeed);
	return FN_NATIVE(([min, max]) => {
		if (min && min.type === 'num' && max && max.type === 'num') {
			const result = rng.generateRandomIntegerInRange(min.value, max.value);
			return typeof result === 'number' ? NUM(result) : NULL;
		}
		return NUM(rng.generateNumber0To1());
	});
}
