export type GraphemeInfo = {
	length: number;
	parts: readonly string[] | null;
	ascii: boolean;
	startsLF: boolean;
	endsCR: boolean;
};
export type GraphemeCacheLimits = { maxEntries?: number; maxCharacters?: number };
type Cached = { value: string; info: GraphemeInfo };

/** 長い連結文字列をハッシュせず、保持する文字数と件数を制限する。 */
export class GraphemeCache {
	private readonly recent: Cached[] = [];
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

	get stats(): { cacheEntries: number; cacheCharacters: number; scannedCharacters: number; segmentedStrings: number } {
		return { cacheEntries: this.recent.length, cacheCharacters: this.characters, scannedCharacters: this.scanned, segmentedStrings: this.segmented };
	}

	clear(): void { this.recent.length = 0; this.characters = 0; }

	private find(value: string): GraphemeInfo | undefined {
		// 長さの違う rope 同士を内容比較しない。現在の値は最初の要素で見つかる。
		for (const entry of this.recent) if (entry.value.length === value.length && entry.value === value) return entry.info;
		return undefined;
	}

	private remember(value: string, info: GraphemeInfo): GraphemeInfo {
		if (this.maxEntries === 0) return info;
		// 上限を超える単体も直近の一件だけは保持し、length と添字で全文を再走査しない。
		if (value.length > this.maxCharacters) {
			this.recent.length = 0;
			this.characters = 0;
			this.recent.push({ value, info });
			this.characters = value.length;
			return info;
		}
		while (this.recent.length >= this.maxEntries || this.characters + value.length > this.maxCharacters) {
			this.characters -= this.recent.pop()!.value.length;
		}
		this.recent.unshift({ value, info });
		this.characters += value.length;
		return info;
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
			parts = [];
			this.segmented++;
			for (const part of this.segmenter.segment(value)) {
				this.onStep(); pending++; parts.push(part.segment);
				if (pending === 64) { pending = 0; yield; }
			}
		}
		return this.remember(value, {
			length: parts ? parts.length : value.length - pairs, parts, ascii,
			startsLF: value.startsWith('\n'), endsCR: value.endsWith('\r'),
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
		if (info.parts || info.length === value.length) return info;
		// 初回の文字種判定と添字用配列の作成は、別の中断区間にする。
		yield;
		const parts: string[] = [];
		for (let i = 0; i < value.length; i++) {
			this.onStep(); this.scanned++;
			if (value.charCodeAt(i) === 13 && value.charCodeAt(i + 1) === 10) {
				parts.push('\r\n'); i++;
			} else parts.push(value[i]!);
			if (parts.length % 64 === 0) yield;
		}
		info.parts = parts;
		return info;
	}

	at(value: string, index: number): string | undefined {
		const preparation = this.prepareParts(value);
		let result = preparation.next();
		while (!result.done) result = preparation.next();
		return result.value.parts ? result.value.parts[index] : value[index];
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
		const metadata = (value: string): GraphemeInfo | undefined => this.find(value) ?? (value.length <= 16 ? this.info(value) : undefined);
		const a = metadata(left);
		const b = metadata(right);
		if (a?.ascii && b?.ascii) {
			this.onStep();
			this.remember(result, {
				length: a.length + b.length - Number(a.endsCR && b.startsLF),
				parts: null, ascii: true, startsLF: a.startsLF, endsCR: b.endsCR,
			});
		}
		return result;
	}
}
