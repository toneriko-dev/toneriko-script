export type GraphemeInfo = {
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
		for (let i = 0; i < this.recent.length; i++) {
			const entry = this.recent[i]!;
			if (entry.value.length !== value.length || entry.value !== value) continue;
			// 読み続ける長文は、短い連結結果が増えても保持する。
			if (i !== 0) { this.recent.splice(i, 1); this.recent.unshift(entry); }
			return entry.info;
		}
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
			for (let i = 0; i < value.length; i++) {
				this.onStep(); this.scanned++;
				if (value.charCodeAt(i) === 13 && value.charCodeAt(i + 1) === 10) {
					parts.push('\r\n'); i++;
				} else parts.push(value[i]!);
				if (parts.length % 64 === 0) yield;
			}
		} else {
			this.segmented++;
			for (const part of this.segmenter.segment(value)) {
				this.onStep(); parts.push(part.segment);
				if (parts.length % 64 === 0) yield;
			}
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
			// この場合と巨大な単一書記素は、次の読み取りで中断可能な全文分割を行う。
			const boundary = a.last + b.first;
			if (/\p{Regional_Indicator}/u.test(boundary)
				|| (b.length > 1 && /^[\p{Grapheme_Extend}\p{Spacing_Mark}\p{Emoji_Modifier}\u200d]/u.test(b.first))
				|| (/[\ud800-\udbff]$/.test(a.last) && /^[\udc00-\udfff]/.test(b.first))) return result;
			const parts: string[] = [];
			this.segmented++;
			for (const part of this.segmenter.segment(boundary)) {
				this.onStep(); parts.push(part.segment);
			}
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
