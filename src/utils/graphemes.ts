// UTF-16 コードユニットではなく拡張書記素クラスタを単位にする文字列操作で共有する。
// str.split は区切り文字を省略した場合だけこの分割を使う。
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function toArray(str: string): string[] {
	return Array.from(segmenter.segment(str), (s) => s.segment);
}

export function length(str: string): number {
	let count = 0;
	for (const _ of segmenter.segment(str)) {
		count++;
	}
	return count;
}

export function substring(str: string, begin: number, end: number): string {
	if (typeof begin !== 'number' || begin < 0) {
		begin = 0;
	}
	if (typeof end === 'number' && end < 0) {
		end = 0;
	}
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
		while (searchIndex < searchArr.length && searchArr[searchIndex] === strArr[index + searchIndex]) {
			searchIndex++;
		}
		if (searchIndex === searchArr.length) {
			return index;
		}
	}

	return -1;
}
