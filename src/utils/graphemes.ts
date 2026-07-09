// JavaScriptのstring.lengthや添字アクセスはUTF-16コードユニット単位であり、
// 肌色修飾子付き絵文字やZWJ結合絵文字(家族の絵文字など)を複数文字として誤って扱ってしまう。
// AiScriptの文字列操作(str.len/slice/index_of/to_arr/split/pick)はユーザーが視覚的に
// 認識する「1文字」(Unicode拡張書記素クラスタ)単位で動作させたいため、
// ICU実装に基づくIntl.Segmenterで分割する。
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function toArray(str: string): string[] {
	return Array.from(segmenter.segment(str), s => s.segment);
}

export function length(str: string): number {
	let count = 0;
	for (const _ of segmenter.segment(str)) count++;
	return count;
}

export function substring(str: string, begin: number, end: number): string {
	if (typeof begin !== 'number' || begin < 0) begin = 0;
	if (typeof end === 'number' && end < 0) end = 0;
	return toArray(str).slice(begin, end).join('');
}

export function indexOf(str: string, searchStr: string, pos = 0): number {
	if (str === '') {
		return searchStr === '' ? 0 : -1;
	}

	pos = Number(pos);
	pos = isNaN(pos) ? 0 : pos;

	const strArr = toArray(str);
	if (pos >= strArr.length) {
		return searchStr === '' ? strArr.length : -1;
	}
	if (searchStr === '') {
		return pos;
	}

	const searchArr = toArray(searchStr);
	for (let index = pos; index < strArr.length; index++) {
		let searchIndex = 0;
		while (
			searchIndex < searchArr.length &&
			searchArr[searchIndex] === strArr[index + searchIndex]
		) {
			searchIndex++;
		}
		if (searchIndex === searchArr.length) {
			return index;
		}
	}

	return -1;
}
