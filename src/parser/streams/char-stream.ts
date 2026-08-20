import { isSurrogatePair } from '../../utils/characters.js';

export class CharStream {
	private pages: Map<number, string>;
	private firstPageIndex: number;
	private lastPageIndex: number;
	private pageIndex: number;
	// address は UTF-16 コードユニット単位、line と column はゼロ始まりで管理し、column も UTF-16 コードユニット単位とする。
	private address: number;
	private _char?: string;
	private line: number;
	private column: number;

	constructor(source: string, opts?: { line?: number, column?: number }) {
		this.pages = new Map();
		this.pages.set(0, source);
		this.firstPageIndex = 0;
		this.lastPageIndex = 0;
		this.pageIndex = 0;
		this.address = 0;
		this.line = opts?.line ?? 0;
		this.column = opts?.column ?? 0;
		this.moveNext();
	}

	public get eof(): boolean {
		return this.endOfPage && this.isLastPage;
	}

	public get char(): string {
		if (this.eof) {
			throw new Error('end of stream');
		}
		return this._char!;
	}

	public getPos(): { line: number, column: number } {
		return {
			line: (this.line + 1),
			column: (this.column + 1),
		};
	}

	public next(): void {
		if (!this.eof && this._char === '\n') {
			this.line++;
			this.column = 0;
		} else {
			this.column += this._char!.length;
		}
		this.incAddr();
		this.moveNext();
	}

	public prev(): void {
		this.movePrev();
		this.decAddr();
		if (!this.startOfFile && this._char === '\n') {
			this.line--;
			const page = this.pages.get(this.pageIndex)!;
			const lastLineBreak = page.lastIndexOf('\n', this.address - 1);
			const lineStart = lastLineBreak >= 0 ? lastLineBreak + 1 : 0;
			const line = page.slice(lineStart, this.address);
			this.column = line.length;
		} else {
			this.column -= this._char!.length;
		}
	}

	private get isFirstPage(): boolean {
		return (this.pageIndex <= this.firstPageIndex);
	}

	private get isLastPage(): boolean {
		return (this.pageIndex >= this.lastPageIndex);
	}

	private get endOfPage(): boolean {
		const page = this.pages.get(this.pageIndex)!;
		return (this.address >= page.length);
	}

	private get startOfFile(): boolean {
		return this.isFirstPage && this.address === 0;
	}

	private moveNext(): void {
		this.loadChar();
		while (true) {
			if (!this.eof && this._char === '\r') {
				this.incAddr();
				this.loadChar();
				continue;
			}
			break;
		}
	}

	private incAddr(): void {
		if (!this.endOfPage) {
			this.address += this._char!.length;
		} else if (!this.isLastPage) {
			this.pageIndex++;
			this.address = 0;
		}
	}

	private movePrev(): void {
		this.loadPrevChar();
		while (!this.startOfFile && this._char === '\r') {
			this.decAddr();
			this.loadPrevChar();
		}
	}

	private decAddr(): void {
		if (this.address > 0) {
			this.address -= getLastUnicodeChar(this.pages.get(this.pageIndex)!, this.address)!.length;
		} else if (!this.isFirstPage) {
			this.pageIndex--;
			const page = this.pages.get(this.pageIndex)!;
			this.address = page.length - getLastUnicodeChar(page)!.length;
		}
	}

	private loadChar(): void {
		if (this.eof) {
			this._char = undefined;
		} else {
			this._char = getUnicodeChar(this.pages.get(this.pageIndex)!, this.address);
		}
	}

	private loadPrevChar(): void {
		if (this.address > 0) {
			this._char = getLastUnicodeChar(this.pages.get(this.pageIndex)!, this.address)!;
		} else if (!this.isFirstPage) {
			const page = this.pages.get(this.pageIndex - 1)!;
			this._char = getLastUnicodeChar(page)!;
		}
	}
}

function getUnicodeChar(string: string, position = 0): string | undefined {
	if (isSurrogatePair(string, position)) {
		return string.slice(position, position + 2);
	}
	return string[position];
}

function getLastUnicodeChar(string: string, position = string.length): string | undefined {
	if (isSurrogatePair(string, position - 2)) {
		return string.slice(position - 2, position);
	}
	return string[position - 1];
}
