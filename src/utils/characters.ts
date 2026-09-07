const MIN_HIGH_SURROGATE = 0xd8_00;
const MAX_HIGH_SURROGATE = 0xdb_ff;
const MIN_LOW_SURROGATE = 0xdc_00;
const MAX_LOW_SURROGATE = 0xdf_ff;
const HEX_DIGIT = /^[0-9a-fA-F]$/;

export function isHighSurrogate(string: string, index = 0): boolean {
	if (index < 0 || index >= string.length) {
		return false;
	}
	const charCode = string.charCodeAt(index);
	return charCode >= MIN_HIGH_SURROGATE && charCode <= MAX_HIGH_SURROGATE;
}

export function isLowSurrogate(string: string, index = 0): boolean {
	if (index < 0 || index >= string.length) {
		return false;
	}
	const charCode = string.charCodeAt(index);
	return charCode >= MIN_LOW_SURROGATE && charCode <= MAX_LOW_SURROGATE;
}

export function isSurrogatePair(string: string, start = 0): boolean {
	return isHighSurrogate(string, start) && isLowSurrogate(string, start + 1);
}

export function decodeUnicodeEscapeSequence(string: string): string {
	let result = '';
	let state: 'string' | 'escape' | 'digit' = 'string';
	let digits = '';

	for (let i = 0; i < string.length; i++) {
		const char = string[i]!;

		switch (state) {
			case 'string': {
				if (char === '\\') {
					state = 'escape';
				} else {
					result += char;
				}
				break;
			}

			case 'escape': {
				if (char !== 'u') {
					throw new SyntaxError('invalid escape sequence');
				}
				state = 'digit';
				break;
			}

			case 'digit': {
				if (HEX_DIGIT.test(char)) {
					digits += char;
				} else {
					throw new SyntaxError('invalid escape sequence');
				}
				if (digits.length === 4) {
					result += String.fromCharCode(Number.parseInt(digits, 16));
					state = 'string';
					digits = '';
				}
				break;
			}
		}
	}

	if (state !== 'string') {
		throw new SyntaxError('invalid escape sequence');
	}

	return result;
}
