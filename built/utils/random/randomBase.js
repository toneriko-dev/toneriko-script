//#region src/utils/random/randomBase.ts
const safeIntegerBits = Math.ceil(Math.log2(Number.MAX_SAFE_INTEGER));
var RandomBase = class {
	generateNumber0To1() {
		let res = this.generateBigUintByBits(safeIntegerBits);
		let exponent = 1022;
		let remainingFractionBits = safeIntegerBits - bitsToRepresent(res);
		while (remainingFractionBits > 0 && exponent >= safeIntegerBits) {
			exponent -= remainingFractionBits;
			res <<= BigInt(remainingFractionBits);
			res |= this.generateBigUintByBits(remainingFractionBits);
			remainingFractionBits = safeIntegerBits - bitsToRepresent(res);
		}
		if (remainingFractionBits > 0) {
			const shift = Math.min(exponent - 1, remainingFractionBits);
			res <<= BigInt(shift);
			res |= this.generateBigUintByBits(shift);
			exponent = Math.max(exponent - shift, 0);
		}
		return Number(res) * .5 ** safeIntegerBits * .5 ** (1022 - exponent);
	}
	generateUniform(maxInclusive) {
		if (maxInclusive < 1) return 0n;
		const log2 = maxInclusive.toString(2).length;
		const bytes = Math.ceil(log2 / 8);
		const wastedBits = BigInt(bytes * 8 - log2);
		let result;
		do
			result = this.generateBigUintByBytes(bytes) >> wastedBits;
		while (result > maxInclusive);
		return result;
	}
	generateRandomIntegerInRange(min, max) {
		const ceilMin = Math.ceil(min);
		const floorMax = Math.floor(max);
		const signedScale = floorMax - ceilMin;
		if (signedScale === 0) return ceilMin;
		const scale = Math.abs(signedScale);
		const scaleSign = Math.sign(signedScale);
		if (!Number.isSafeInteger(scale) || !Number.isSafeInteger(ceilMin) || !Number.isSafeInteger(floorMax)) return null;
		const bigScale = BigInt(scale);
		return Number(this.generateUniform(bigScale)) * scaleSign + ceilMin;
	}
};
function bitsToRepresent(num) {
	if (num === 0n) return 0;
	return num.toString(2).length;
}
function readSmallBigUintLittleEndian(buffer) {
	if (buffer.byteLength === 0) return null;
	if (buffer.byteLength < 8) {
		const array = /* @__PURE__ */ new Uint8Array(8);
		array.set(new Uint8Array(buffer));
		return new DataView(array.buffer).getBigUint64(0, true);
	}
	return new DataView(buffer).getBigUint64(0, true);
}
function readBigUintLittleEndian(buffer) {
	if (buffer.byteLength === 0) return null;
	if (buffer.byteLength <= 8) return readSmallBigUintLittleEndian(buffer);
	const dataView = new DataView(buffer);
	let pos = 0n;
	let res = 0n;
	let index = 0;
	for (; index < dataView.byteLength - 7; index += 8, pos += 64n) {
		const element = dataView.getBigUint64(index, true);
		res |= element << pos;
	}
	if (index < dataView.byteLength) {
		const array = /* @__PURE__ */ new Uint8Array(8);
		array.set(new Uint8Array(buffer, index));
		res |= new DataView(array.buffer).getBigUint64(0, true) << pos;
	}
	return res;
}

//#endregion
export { RandomBase, bitsToRepresent, readBigUintLittleEndian, safeIntegerBits };
//# sourceMappingURL=randomBase.js.map