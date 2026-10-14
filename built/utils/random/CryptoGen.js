import { RandomBase, readBigUintLittleEndian } from "./randomBase.js";

//#region src/utils/random/CryptoGen.ts
var CryptoGen = class CryptoGen extends RandomBase {
	static _instance = new CryptoGen();
	static get instance() {
		return CryptoGen._instance;
	}
	constructor() {
		super();
	}
	generateBigUintByBytes(bytes) {
		let u8a = new Uint8Array(Math.ceil(bytes / 8) * 8);
		if (u8a.length < 1 || !Number.isSafeInteger(bytes)) return 0n;
		u8a = this.generateBytes(u8a.subarray(0, bytes));
		return readBigUintLittleEndian(u8a.buffer) ?? 0n;
	}
	generateBigUintByBits(bits) {
		if (bits < 1 || !Number.isSafeInteger(bits)) return 0n;
		const bytes = Math.ceil(bits / 8);
		const wastedBits = BigInt(bytes * 8 - bits);
		return this.generateBigUintByBytes(bytes) >> wastedBits;
	}
	generateBytes(array) {
		return crypto.getRandomValues(array);
	}
};

//#endregion
export { CryptoGen };
//# sourceMappingURL=CryptoGen.js.map