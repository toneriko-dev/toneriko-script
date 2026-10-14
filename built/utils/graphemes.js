//#region src/utils/graphemes.ts
const segmenter = new Intl.Segmenter(void 0, { granularity: "grapheme" });
function toArray(str) {
	return Array.from(segmenter.segment(str), (s) => s.segment);
}
function length(str) {
	let count = 0;
	for (const _ of segmenter.segment(str)) count++;
	return count;
}
function substring(str, begin, end) {
	if (typeof begin !== "number" || begin < 0) begin = 0;
	if (typeof end === "number" && end < 0) end = 0;
	return toArray(str).slice(begin, end).join("");
}
function indexOf(str, searchStr, pos = 0) {
	if (str === "") return searchStr === "" ? 0 : -1;
	pos = Number(pos);
	pos = isNaN(pos) ? 0 : pos;
	const strArr = toArray(str);
	if (pos >= strArr.length) return searchStr === "" ? strArr.length : -1;
	if (searchStr === "") return pos;
	const searchArr = toArray(searchStr);
	for (let index = pos; index < strArr.length; index++) {
		let searchIndex = 0;
		while (searchIndex < searchArr.length && searchArr[searchIndex] === strArr[index + searchIndex]) searchIndex++;
		if (searchIndex === searchArr.length) return index;
	}
	return -1;
}

//#endregion
export { indexOf, length, substring, toArray };
//# sourceMappingURL=graphemes.js.map