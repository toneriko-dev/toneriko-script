import { textEncoder } from "../../const.js";
import { FN_NATIVE, NULL, NUM } from "../../interpreter/value.js";
import { ChaCha20 } from "./chacha20.js";

//#region src/utils/random/genrng.ts
async function GenerateChaCha20Random(seed) {
	if (!seed || seed.type !== "num" && seed.type !== "str" && seed.type !== "null") return NULL;
	let actualSeed = void 0;
	if (seed.type === "num") actualSeed = new Uint8Array(await crypto.subtle.digest("SHA-384", new Uint8Array(new Float64Array([seed.value]))));
	else if (seed.type === "str") actualSeed = new Uint8Array(await crypto.subtle.digest("SHA-384", new Uint8Array(textEncoder.encode(seed.value))));
	const rng = new ChaCha20(actualSeed);
	return FN_NATIVE(([min, max]) => {
		if (min && min.type === "num" && max && max.type === "num") {
			const result = rng.generateRandomIntegerInRange(min.value, max.value);
			return typeof result === "number" ? NUM(result) : NULL;
		}
		return NUM(rng.generateNumber0To1());
	});
}

//#endregion
export { GenerateChaCha20Random };
//# sourceMappingURL=genrng.js.map