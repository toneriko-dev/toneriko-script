//#region src/v2/runtime/strings.ts
/** 長さが増える連結結果をハッシュせず、保持する文字数と件数を制限する。 */
var GraphemeCache = class {
	onStep;
	recent = [];
	lengths = /* @__PURE__ */ new Map();
	stringComparisons = 0;
	characters = 0;
	scanned = 0;
	segmented = 0;
	maxEntries;
	maxCharacters;
	segmenter = new Intl.Segmenter(void 0, { granularity: "grapheme" });
	constructor(onStep = () => {}, limits = {}) {
		this.onStep = onStep;
		this.maxEntries = limits.maxEntries ?? 64;
		this.maxCharacters = limits.maxCharacters ?? 1048576;
	}
	get stats() {
		return {
			cacheEntries: this.recent.length,
			cacheCharacters: this.characters,
			scannedCharacters: this.scanned,
			segmentedStrings: this.segmented,
			stringComparisons: this.stringComparisons
		};
	}
	clear() {
		this.recent.length = 0;
		this.lengths.clear();
		this.characters = 0;
	}
	find(value) {
		let bucket = this.lengths.get(value.length);
		if (!bucket) return void 0;
		let entry;
		if (bucket instanceof Map) entry = bucket.get(value);
		else {
			this.stringComparisons++;
			if (bucket.value === value) entry = bucket;
			else {
				bucket = /* @__PURE__ */ new Map([[bucket.value, bucket]]);
				this.lengths.set(value.length, bucket);
			}
		}
		if (!entry) return void 0;
		const index = this.recent.indexOf(entry);
		if (index !== 0) {
			this.recent.splice(index, 1);
			this.recent.unshift(entry);
		}
		return entry.info;
	}
	removeOldest() {
		const entry = this.recent.pop();
		this.characters -= entry.value.length;
		const bucket = this.lengths.get(entry.value.length);
		if (bucket instanceof Map) {
			bucket.delete(entry.value);
			if (bucket.size === 0) this.lengths.delete(entry.value.length);
		} else this.lengths.delete(entry.value.length);
	}
	remember(value, info) {
		if (this.maxEntries === 0) return info;
		const existing = this.find(value);
		if (existing) return Object.assign(existing, info);
		if (value.length > this.maxCharacters) this.clear();
		else while (this.recent.length >= this.maxEntries || this.characters + value.length > this.maxCharacters) this.removeOldest();
		const entry = {
			value,
			info
		};
		const bucket = this.lengths.get(value.length);
		if (bucket instanceof Map) bucket.set(value, entry);
		else if (bucket) this.lengths.set(value.length, /* @__PURE__ */ new Map([[bucket.value, bucket], [value, entry]]));
		else this.lengths.set(value.length, entry);
		this.recent.unshift(entry);
		this.characters += value.length;
		return info;
	}
	*split(value, pending = 0) {
		const parts = [];
		this.segmented++;
		for (const part of this.segmenter.segment(value)) {
			parts.push(part.segment);
			for (let unit = 0; unit < part.segment.length; unit++) {
				this.onStep();
				this.scanned++;
				pending++;
				if (pending === 64) {
					pending = 0;
					yield;
				}
			}
		}
		return parts;
	}
	*prepare(value) {
		const cached = this.find(value);
		if (cached) return cached;
		let ascii = true;
		let pairs = 0;
		let pending = 0;
		for (let i = 0; i < value.length; i++) {
			this.onStep();
			this.scanned++;
			pending++;
			const code = value.charCodeAt(i);
			if (code > 127) ascii = false;
			if (code === 10 && i > 0 && value.charCodeAt(i - 1) === 13) pairs++;
			if (pending === 64) {
				pending = 0;
				yield;
			}
			if (!ascii) break;
		}
		let parts = null;
		if (!ascii) parts = yield* this.split(value, pending);
		return this.remember(value, {
			length: parts ? parts.length : value.length - pairs,
			parts,
			ascii,
			startsLF: value.startsWith("\n"),
			endsCR: value.endsWith("\r"),
			first: parts ? parts[0] ?? "" : value.startsWith("\r\n") ? "\r\n" : value[0] ?? "",
			last: parts ? parts.at(-1) ?? "" : value.endsWith("\r\n") ? "\r\n" : value.at(-1) ?? ""
		});
	}
	info(value) {
		const preparation = this.prepare(value);
		let result = preparation.next();
		while (!result.done) result = preparation.next();
		return result.value;
	}
	/** 添字用の配列は必要なときだけ作り、length の取得では作らない。 */
	*prepareParts(value) {
		const info = yield* this.prepare(value);
		if (info.parts || info.ascii && info.length === value.length) return info;
		yield;
		const parts = [];
		if (info.ascii) {
			let pending = 0;
			for (let i = 0; i < value.length;) {
				const size = value.charCodeAt(i) === 13 && value.charCodeAt(i + 1) === 10 ? 2 : 1;
				parts.push(value.slice(i, i + size));
				i += size;
				for (let unit = 0; unit < size; unit++) {
					this.onStep();
					this.scanned++;
					pending++;
					if (pending === 64) {
						pending = 0;
						yield;
					}
				}
			}
		} else {
			info.parts = yield* this.split(value);
			return info;
		}
		info.parts = parts;
		return info;
	}
	/** 検索の位置変換は分割結果と一緒に保持し、同じ文字列の反復検索で作り直さない。 */
	*prepareSearch(value) {
		const info = yield* this.prepareParts(value);
		if (info.search) return info.search;
		if (!info.parts) return info.search = {
			length: info.length,
			offsets: null,
			boundaries: null
		};
		yield;
		const offsets = [0];
		const boundaries = /* @__PURE__ */ new Map([[0, 0]]);
		let offset = 0, pending = 0;
		for (let i = 0; i < info.parts.length; i++) {
			offset += info.parts[i].length;
			offsets.push(offset);
			boundaries.set(offset, i + 1);
			this.onStep();
			pending++;
			if (pending === 64) {
				pending = 0;
				yield;
			}
		}
		return info.search = {
			length: info.length,
			offsets,
			boundaries
		};
	}
	at(value, index) {
		const preparation = this.prepareParts(value);
		let result = preparation.next();
		while (!result.done) result = preparation.next();
		return result.value.parts ? result.value.parts[index] : value[index];
	}
	/** 反復中は分割結果を保持し、キャッシュから消えても分割し直しません。 */
	units(value) {
		const preparation = this.prepareParts(value);
		let result = preparation.next();
		while (!result.done) result = preparation.next();
		return result.value.parts ?? value;
	}
	graphemes(value) {
		const preparation = this.prepareParts(value);
		let result = preparation.next();
		while (!result.done) result = preparation.next();
		return result.value.parts ?? value.split("");
	}
	concat(left, right) {
		const result = left + right;
		if (left.length === 0 || right.length === 0) return result;
		const metadata = (value) => this.find(value) ?? (value.length <= 8 ? this.info(value) : void 0);
		const a = metadata(left);
		const b = metadata(right);
		if (a?.ascii && b?.ascii) {
			this.onStep();
			this.remember(result, {
				length: a.length + b.length - Number(a.endsCR && b.startsLF),
				parts: null,
				ascii: true,
				startsLF: a.startsLF,
				endsCR: b.endsCR,
				first: a.length === 1 && a.endsCR && b.startsLF ? "\r\n" : a.first,
				last: b.length === 1 && a.endsCR && b.startsLF ? "\r\n" : b.last
			});
		} else if (a && b && a.last.length + b.first.length <= 32) {
			const boundary = a.last + b.first;
			if (/\p{Regional_Indicator}/u.test(boundary) || b.length > 1 && /^[\p{Grapheme_Extend}\p{Spacing_Mark}\p{Emoji_Modifier}\u200d]/u.test(b.first) || /[\ud800-\udbff]$/.test(a.last) && /^[\udc00-\udfff]/.test(b.first)) return result;
			const parts = [];
			this.segmented++;
			for (let unit = 0; unit < boundary.length; unit++) this.onStep();
			for (const part of this.segmenter.segment(boundary)) parts.push(part.segment);
			this.remember(result, {
				length: a.length + b.length - 2 + parts.length,
				parts: null,
				ascii: false,
				startsLF: a.startsLF,
				endsCR: b.endsCR,
				first: a.length === 1 ? parts[0] : a.first,
				last: b.length === 1 ? parts.at(-1) : b.last
			});
		}
		return result;
	}
};

//#endregion
export { GraphemeCache };
//# sourceMappingURL=strings.js.map