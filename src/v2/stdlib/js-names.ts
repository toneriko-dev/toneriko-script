/**
 * ECMAScript 2025 と Console 標準で定義される名前です。まだ使えない名前の案内に使います。
 * 実行環境の組み込みから調べると、エンジンと版によって同じ名前が例外になったり null になったりするため、固定の一覧にします。
 */
const words = (text: string): ReadonlySet<string> => new Set(text.split(' '));

export const javascriptNamespaceMembers: Readonly<Record<string, ReadonlySet<string>>> = {
	Number: words('EPSILON MAX_SAFE_INTEGER MAX_VALUE MIN_SAFE_INTEGER MIN_VALUE NaN NEGATIVE_INFINITY POSITIVE_INFINITY isFinite isInteger isNaN isSafeInteger parseFloat parseInt'),
	String: words('fromCharCode fromCodePoint raw'),
	Math: words('E LN10 LN2 LOG10E LOG2E PI SQRT1_2 SQRT2 abs acos acosh asin asinh atan atan2 atanh cbrt ceil clz32 cos cosh exp expm1 f16round floor fround hypot imul log log10 log1p log2 max min pow random round sign sin sinh sqrt tan tanh trunc'),
	Array: words('from isArray of'),
	Object: words('assign create defineProperties defineProperty entries freeze fromEntries getOwnPropertyDescriptor getOwnPropertyDescriptors getOwnPropertyNames getOwnPropertySymbols getPrototypeOf groupBy hasOwn is isExtensible isFrozen isSealed keys preventExtensions seal setPrototypeOf values'),
	JSON: words('parse stringify'),
	Date: words('UTC now parse'),
	console: words('assert clear count countReset debug dir dirxml error group groupCollapsed groupEnd info log table time timeEnd timeLog trace warn'),
};

export const javascriptMethods: Readonly<Record<'array' | 'string' | 'number', ReadonlySet<string>>> = {
	array: words('at concat copyWithin entries every fill filter find findIndex findLast findLastIndex flat flatMap forEach includes indexOf join keys lastIndexOf map pop push reduce reduceRight reverse shift slice some sort splice toLocaleString toReversed toSorted toSpliced toString unshift values with'),
	string: words('anchor at big blink bold charAt charCodeAt codePointAt concat endsWith fixed fontcolor fontsize includes indexOf isWellFormed italics lastIndexOf link localeCompare match matchAll normalize padEnd padStart repeat replace replaceAll search slice small split startsWith strike sub substr substring sup toLocaleLowerCase toLocaleUpperCase toLowerCase toString toUpperCase toWellFormed trim trimEnd trimLeft trimRight trimStart valueOf'),
	number: words('toExponential toFixed toLocaleString toPrecision toString valueOf'),
};
