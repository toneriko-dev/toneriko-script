//#region src/utils/characters.ts
const MIN_HIGH_SURROGATE = 55296;
const MAX_HIGH_SURROGATE = 56319;
const MIN_LOW_SURROGATE = 56320;
const MAX_LOW_SURROGATE = 57343;
const HEX_DIGIT = /^[0-9a-fA-F]$/;
function isHighSurrogate(string, index = 0) {
	if (index < 0 || index >= string.length) return false;
	const charCode = string.charCodeAt(index);
	return charCode >= MIN_HIGH_SURROGATE && charCode <= MAX_HIGH_SURROGATE;
}
function isLowSurrogate(string, index = 0) {
	if (index < 0 || index >= string.length) return false;
	const charCode = string.charCodeAt(index);
	return charCode >= MIN_LOW_SURROGATE && charCode <= MAX_LOW_SURROGATE;
}
function isSurrogatePair(string, start = 0) {
	return isHighSurrogate(string, start) && isLowSurrogate(string, start + 1);
}
function decodeUnicodeEscapeSequence(string) {
	let result = "";
	let state = "string";
	let digits = "";
	for (let i = 0; i < string.length; i++) {
		const char = string[i];
		switch (state) {
			case "string":
				if (char === "\\") state = "escape";
				else result += char;
				break;
			case "escape":
				if (char !== "u") throw new SyntaxError("invalid escape sequence");
				state = "digit";
				break;
			case "digit":
				if (HEX_DIGIT.test(char)) digits += char;
				else throw new SyntaxError("invalid escape sequence");
				if (digits.length === 4) {
					result += String.fromCharCode(Number.parseInt(digits, 16));
					state = "string";
					digits = "";
				}
		}
	}
	if (state !== "string") throw new SyntaxError("invalid escape sequence");
	return result;
}

//#endregion
export { decodeUnicodeEscapeSequence, isHighSurrogate, isLowSurrogate, isSurrogatePair };
//# sourceMappingURL=characters.js.map