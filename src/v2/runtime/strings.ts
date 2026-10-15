export type GraphemeSearchInfo = {
	length: number;
	offsets: readonly number[] | null;
	boundaries: ReadonlyMap<number, number> | null;
};
export type GraphemeInfo = {
	search?: GraphemeSearchInfo;
	length: number;
	parts: readonly string[] | null;
	ascii: boolean;
	startsLF: boolean;
	endsCR: boolean;
	first: string;
	last: string;
};
export type GraphemeCacheLimits = { maxEntries?: number; maxCharacters?: number };
type Cached = { value: string; info: GraphemeInfo };

/** 長さが増える連結結果をハッシュせず、保持する文字数と件数を制限する。 */
export class GraphemeCache {
	private readonly recent: Cached[] = [];
	private readonly lengths = new Map<number, Cached | Map<string, Cached>>();
	private stringComparisons = 0;
	private characters = 0;
	private scanned = 0;
	private segmented = 0;
	private readonly maxEntries: number;
	private readonly maxCharacters: number;
	private readonly segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

	constructor(private readonly onStep: () => void = () => {}, limits: GraphemeCacheLimits = {}) {
		this.maxEntries = limits.maxEntries ?? 64;
		this.maxCharacters = limits.maxCharacters ?? 1_048_576;
	}

	get stats(): { cacheEntries: number; cacheCharacters: number; scannedCharacters: number; segmentedStrings: number; stringComparisons: number } {
		return { cacheEntries: this.recent.length, cacheCharacters: this.characters, scannedCharacters: this.scanned, segmentedStrings: this.segmented, stringComparisons: this.stringComparisons };
	}

	clear(): void { this.recent.length = 0; this.lengths.clear(); this.characters = 0; }

	private find(value: string): GraphemeInfo | undefined {
		let bucket = this.lengths.get(value.length);
		if (!bucket) return undefined;
		let entry: Cached | undefined;
		if (bucket instanceof Map) entry = bucket.get(value);
		else {
			this.stringComparisons++;
			if (bucket.value === value) entry = bucket;
			else {
				// 同じ長さで内容が違う値だけをハッシュし、共通接頭辞の再比較を防ぐ。
				bucket = new Map([[bucket.value, bucket]]);
				this.lengths.set(value.length, bucket);
			}
		}
		if (!entry) return undefined;
		const index = this.recent.indexOf(entry);
		if (index !== 0) { this.recent.splice(index, 1); this.recent.unshift(entry); }
		return entry.info;
	}

	private removeOldest(): void {
		const entry = this.recent.pop()!;
		this.characters -= entry.value.length;
		const bucket = this.lengths.get(entry.value.length)!;
		if (bucket instanceof Map) {
			bucket.delete(entry.value);
			if (bucket.size === 0) this.lengths.delete(entry.value.length);
		} else this.lengths.delete(entry.value.length);
	}

	private remember(value: string, info: GraphemeInfo): GraphemeInfo {
		if (this.maxEntries === 0) return info;
		const existing = this.find(value);
		if (existing) return Object.assign(existing, info);
		// 上限を超える単体も直近の一件だけは保持し、length と添字で全文を再走査しない。
		if (value.length > this.maxCharacters) this.clear();
		else while (this.recent.length >= this.maxEntries || this.characters + value.length > this.maxCharacters) this.removeOldest();
		const entry = { value, info };
		const bucket = this.lengths.get(value.length);
		if (bucket instanceof Map) bucket.set(value, entry);
		else if (bucket) this.lengths.set(value.length, new Map([[bucket.value, bucket], [value, entry]]));
		else this.lengths.set(value.length, entry);
		this.recent.unshift(entry);
		this.characters += value.length;
		return info;
	}

	private *split(value: string, pending = 0): Generator<void, string[]> {
		const parts: string[] = [];
		this.segmented++;
		// Intl の反復は遅延するが、単一の書記素の内部では中断できない。
		// Bun 1.4.3 では a + 結合文字 2^25 個の初回分割に約 257 ms を要する。
		// 受け取った直後に全コード単位を計上し、ステップ・時間の上限を確認する。
		for (const part of this.segmenter.segment(value)) {
			parts.push(part.segment);
			for (let unit = 0; unit < part.segment.length; unit++) {
				this.onStep(); this.scanned++; pending++;
				if (pending === 64) { pending = 0; yield; }
			}
		}
		return parts;
	}

	*prepare(value: string): Generator<void, GraphemeInfo> {
		const cached = this.find(value);
		if (cached) return cached;
		let ascii = true;
		let pairs = 0;
		// 文字種判定と書記素分割で、中断までの残りステップを共有する。
		let pending = 0;
		for (let i = 0; i < value.length; i++) {
			this.onStep(); this.scanned++; pending++;
			const code = value.charCodeAt(i);
			if (code > 127) ascii = false;
			if (code === 10 && i > 0 && value.charCodeAt(i - 1) === 13) pairs++;
			if (pending === 64) { pending = 0; yield; }
			if (!ascii) break;
		}
		let parts: string[] | null = null;
		if (!ascii) {
			parts = yield* this.split(value, pending);
		}
		return this.remember(value, {
			length: parts ? parts.length : value.length - pairs, parts, ascii,
			startsLF: value.startsWith('\n'), endsCR: value.endsWith('\r'),
			first: parts ? parts[0] ?? '' : value.startsWith('\r\n') ? '\r\n' : value[0] ?? '',
			last: parts ? parts.at(-1) ?? '' : value.endsWith('\r\n') ? '\r\n' : value.at(-1) ?? '',
		});
	}

	info(value: string): GraphemeInfo {
		const preparation = this.prepare(value);
		let result = preparation.next();
		while (!result.done) result = preparation.next();
		return result.value;
	}

	/** 添字用の配列は必要なときだけ作り、length の取得では作らない。 */
	*prepareParts(value: string): Generator<void, GraphemeInfo> {
		const info = yield* this.prepare(value);
		if (info.parts || (info.ascii && info.length === value.length)) return info;
		// 初回の文字種判定と添字用配列の作成は、別の中断区間にする。
		yield;
		const parts: string[] = [];
		if (info.ascii) {
			let pending = 0;
			for (let i = 0; i < value.length;) {
				const size = value.charCodeAt(i) === 13 && value.charCodeAt(i + 1) === 10 ? 2 : 1;
				parts.push(value.slice(i, i + size)); i += size;
				for (let unit = 0; unit < size; unit++) {
					this.onStep(); this.scanned++; pending++;
					if (pending === 64) { pending = 0; yield; }
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
	*prepareSearch(value: string): Generator<void, GraphemeSearchInfo> {
		const info = yield* this.prepareParts(value);
		if (info.search) return info.search;
		if (!info.parts) return info.search = { length: info.length, offsets: null, boundaries: null };
		// 分割の残りと対応表の計上を別の中断区間にする。
		yield;
		const offsets: number[] = [0];
		const boundaries = new Map<number, number>([[0, 0]]);
		let offset = 0, pending = 0;
		for (let i = 0; i < info.parts.length; i++) {
			offset += info.parts[i]!.length;
			offsets.push(offset); boundaries.set(offset, i + 1);
			this.onStep(); pending++;
			if (pending === 64) { pending = 0; yield; }
		}
		return info.search = { length: info.length, offsets, boundaries };
	}

	at(value: string, index: number): string | undefined {
		const preparation = this.prepareParts(value);
		let result = preparation.next();
		while (!result.done) result = preparation.next();
		return result.value.parts ? result.value.parts[index] : value[index];
	}

	/** 反復中は分割結果を保持し、キャッシュから消えても分割し直しません。 */
	units(value: string): string | readonly string[] {
		const preparation = this.prepareParts(value);
		let result = preparation.next();
		while (!result.done) result = preparation.next();
		return result.value.parts ?? value;
	}

	graphemes(value: string): readonly string[] {
		const preparation = this.prepareParts(value);
		let result = preparation.next();
		while (!result.done) result = preparation.next();
		return result.value.parts ?? value.split('');
	}

	concat(left: string, right: string): string {
		const result = left + right;
		if (left.length === 0 || right.length === 0) return result;
		// 未知の短い両辺と境界を合わせても、同期区間の処理を 64 ステップ以内に収める。
		const metadata = (value: string): GraphemeInfo | undefined => this.find(value) ?? (value.length <= 8 ? this.info(value) : undefined);
		const a = metadata(left);
		const b = metadata(right);
		if (a?.ascii && b?.ascii) {
			this.onStep();
			this.remember(result, {
				length: a.length + b.length - Number(a.endsCR && b.startsLF),
				parts: null, ascii: true, startsLF: a.startsLF, endsCR: b.endsCR,
				first: a.length === 1 && a.endsCR && b.startsLF ? '\r\n' : a.first,
				last: b.length === 1 && a.endsCR && b.startsLF ? '\r\n' : b.last,
			});
		} else if (a && b && a.last.length + b.first.length <= 32) {
			// RI の偶奇、先頭の結合文字と ZWJ、サロゲート対は右の後続にも境界を動かす。
			// この場合と巨大な単一書記素は、次の読み取りで全文を分割し直す。
			const boundary = a.last + b.first;
			if (/\p{Regional_Indicator}/u.test(boundary)
				|| (b.length > 1 && /^[\p{Grapheme_Extend}\p{Spacing_Mark}\p{Emoji_Modifier}\u200d]/u.test(b.first))
				|| (/[\ud800-\udbff]$/.test(a.last) && /^[\udc00-\udfff]/.test(b.first))) return result;
			const parts: string[] = [];
			this.segmented++;
			for (let unit = 0; unit < boundary.length; unit++) this.onStep();
			for (const part of this.segmenter.segment(boundary)) parts.push(part.segment);
			this.remember(result, {
				length: a.length + b.length - 2 + parts.length,
				parts: null, ascii: false, startsLF: a.startsLF, endsCR: b.endsCR,
				first: a.length === 1 ? parts[0]! : a.first,
				last: b.length === 1 ? parts.at(-1)! : b.last,
			});
		}
		return result;
	}
}
