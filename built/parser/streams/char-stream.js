import { isSurrogatePair } from "../../utils/characters.js";

//#region src/parser/streams/char-stream.ts
var CharStream = class {
	pages;
	firstPageIndex;
	lastPageIndex;
	pageIndex;
	address;
	_char;
	line;
	column;
	constructor(source, opts) {
		this.pages = /* @__PURE__ */ new Map();
		this.pages.set(0, source);
		this.firstPageIndex = 0;
		this.lastPageIndex = 0;
		this.pageIndex = 0;
		this.address = 0;
		this.line = opts?.line ?? 0;
		this.column = opts?.column ?? 0;
		this.moveNext();
	}
	get eof() {
		return this.endOfPage && this.isLastPage;
	}
	get char() {
		if (this.eof) throw new Error("end of stream");
		return this._char;
	}
	getPos() {
		return {
			line: this.line + 1,
			column: this.column + 1
		};
	}
	next() {
		if (!this.eof && this._char === "\n") {
			this.line++;
			this.column = 0;
		} else this.column += this._char.length;
		this.incAddr();
		this.moveNext();
	}
	prev() {
		this.movePrev();
		this.decAddr();
		if (!this.startOfFile && this._char === "\n") {
			this.line--;
			const page = this.pages.get(this.pageIndex);
			const lastLineBreak = page.lastIndexOf("\n", this.address - 1);
			const lineStart = lastLineBreak >= 0 ? lastLineBreak + 1 : 0;
			const line = page.slice(lineStart, this.address);
			this.column = line.length;
		} else this.column -= this._char.length;
	}
	get isFirstPage() {
		return this.pageIndex <= this.firstPageIndex;
	}
	get isLastPage() {
		return this.pageIndex >= this.lastPageIndex;
	}
	get endOfPage() {
		const page = this.pages.get(this.pageIndex);
		return this.address >= page.length;
	}
	get startOfFile() {
		return this.isFirstPage && this.address === 0;
	}
	moveNext() {
		this.loadChar();
		while (true) {
			if (!this.eof && this._char === "\r") {
				this.incAddr();
				this.loadChar();
				continue;
			}
			break;
		}
	}
	incAddr() {
		if (!this.endOfPage) this.address += this._char.length;
		else if (!this.isLastPage) {
			this.pageIndex++;
			this.address = 0;
		}
	}
	movePrev() {
		this.loadPrevChar();
		while (!this.startOfFile && this._char === "\r") {
			this.decAddr();
			this.loadPrevChar();
		}
	}
	decAddr() {
		if (this.address > 0) this.address -= getLastUnicodeChar(this.pages.get(this.pageIndex), this.address).length;
		else if (!this.isFirstPage) {
			this.pageIndex--;
			const page = this.pages.get(this.pageIndex);
			this.address = page.length - getLastUnicodeChar(page).length;
		}
	}
	loadChar() {
		if (this.eof) this._char = void 0;
		else this._char = getUnicodeChar(this.pages.get(this.pageIndex), this.address);
	}
	loadPrevChar() {
		if (this.address > 0) this._char = getLastUnicodeChar(this.pages.get(this.pageIndex), this.address);
		else if (!this.isFirstPage) {
			const page = this.pages.get(this.pageIndex - 1);
			this._char = getLastUnicodeChar(page);
		}
	}
};
function getUnicodeChar(string, position = 0) {
	if (isSurrogatePair(string, position)) return string.slice(position, position + 2);
	return string[position];
}
function getLastUnicodeChar(string, position = string.length) {
	if (isSurrogatePair(string, position - 2)) return string.slice(position - 2, position);
	return string[position - 1];
}

//#endregion
export { CharStream };
//# sourceMappingURL=char-stream.js.map