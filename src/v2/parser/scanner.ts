import type { Loc, Pos } from '../../node.js';
import { syntaxError } from '../diagnostics.js';

export type Token = {
	kind: 'identifier' | 'number' | 'string' | 'punctuator' | 'templateHead' | 'templateMiddle' | 'templateTail' | 'template' | 'eof';
	value: string | number;
	raw: string;
	start: number;
	end: number;
	loc: Loc;
	lineBreakBefore: boolean;
};

const punctuators = [
	'>>>=', '===', '!==', '**=', '&&=', '||=', '??=', '>>>', '<<=', '>>=', '...',
	'=>', '==', '!=', '<=', '>=', '++', '--', '&&', '||', '??', '?.', '**', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>',
	'{', '}', '(', ')', '[', ']', '.', ';', ',', ':', '?', '~', '!', '+', '-', '*', '/', '%', '<', '>', '=', '&', '|', '^', '@', '#',
];
const identifierStart = /[$_\p{ID_Start}]/u;
const identifierPart = /[$\u200c\u200d\p{ID_Continue}]/u;
const lineTerminator = /[\n\r\u2028\u2029]/;

export class Scanner {
	private offset = 0;
	private line = 1;
	private column = 1;
	private readonly templates: { depth: number }[] = [];

	constructor(private readonly source: string) {}

	next(): Token {
		const before = this.line;
		this.skipTrivia();
		const start = this.offset;
		const pos = this.position();
		const newline = this.line !== before;
		const char = this.peek();
		if (!char) {
			if (this.templates.length) throw syntaxError('UNTERMINATED_TEMPLATE', pos);
			return this.token('eof', '', start, pos, newline);
		}
		const template = this.templates.at(-1);
		if (char === '}' && template?.depth === 0) return this.readTemplate(false, start, pos, newline);
		if (char === '`') return this.readTemplate(true, start, pos, newline);
		if (char === '"' || char === "'") return this.readString(start, pos, newline);
		if (/\d/.test(char) || (char === '.' && /\d/.test(this.peek(1)))) return this.readNumber(start, pos, newline);
		if (identifierStart.test(this.codePoint()) || char === '\\') return this.readIdentifier(start, pos, newline);
		for (const punctuator of punctuators) {
			if (!this.source.startsWith(punctuator, this.offset)) continue;
			// ?. の直後が数字なら、条件演算子と小数として読む規則に従います。
			if (punctuator === '?.' && /\d/.test(this.peek(2))) continue;
			for (let i = 0; i < punctuator.length; i++) this.advance();
			if (template && punctuator === '{') template.depth++;
			if (template && punctuator === '}') template.depth--;
			return this.token('punctuator', punctuator, start, pos, newline);
		}
		throw syntaxError('UNEXPECTED_TOKEN', pos, { token: char });
	}

	private position(): Pos {
		return { line: this.line, column: this.column };
	}

	private peek(ahead = 0): string {
		return this.source[this.offset + ahead] ?? '';
	}

	private codePoint(): string {
		const point = this.source.codePointAt(this.offset);
		return point === undefined ? '' : String.fromCodePoint(point);
	}

	private advance(): string {
		const char = this.peek();
		if (!char) return '';
		this.offset++;
		if (lineTerminator.test(char)) {
			if (char === '\r' && this.peek() === '\n') this.offset++;
			this.line++;
			this.column = 1;
		} else {
			this.column++;
		}
		return char;
	}

	private token(kind: Token['kind'], value: Token['value'], start: number, pos: Pos, newline: boolean): Token {
		return { kind, value, raw: this.source.slice(start, this.offset), start, end: this.offset, loc: { start: pos, end: this.position() }, lineBreakBefore: newline };
	}

	private skipTrivia(): void {
		while (this.offset < this.source.length) {
			if (/\s/u.test(this.peek())) {
				this.advance();
				continue;
			}
			if (this.source.startsWith('//', this.offset)) {
				if (this.line === 1 && /^\/\/\/\s*@\s*1\./.test(this.source.slice(this.offset))) {
					throw syntaxError('AISCRIPT_VERSION', this.position());
				}
				while (this.peek() && !lineTerminator.test(this.peek())) this.advance();
				continue;
			}
			if (this.source.startsWith('/*', this.offset)) {
				const pos = this.position();
				this.advance();
				this.advance();
				while (this.peek() && !this.source.startsWith('*/', this.offset)) this.advance();
				if (!this.peek()) throw syntaxError('UNTERMINATED_COMMENT', pos);
				this.advance();
				this.advance();
				continue;
			}
			break;
		}
	}

	private readIdentifier(start: number, pos: Pos, newline: boolean): Token {
		let value = '';
		let first = true;
		while (this.peek()) {
			let char = this.codePoint();
			const allowed = first ? identifierStart : identifierPart;
			if (this.peek() === '\\') {
				const escapePos = this.position();
				this.advance();
				if (this.advance() !== 'u') throw syntaxError('INVALID_ESCAPE', escapePos);
				char = this.readUnicode(escapePos);
				if (!allowed.test(char)) throw syntaxError('INVALID_ESCAPE', escapePos);
			} else {
				if (!allowed.test(char)) break;
				for (let i = 0; i < char.length; i++) this.advance();
			}
			value += char;
			first = false;
		}
		return this.token('identifier', value, start, pos, newline);
	}

	private readNumber(start: number, pos: Pos, newline: boolean): Token {
		const remaining = this.source.slice(this.offset);
		const base = /^0([xXbBoO])/.exec(remaining);
		if (base) {
			this.advance();
			this.advance();
			const radix = base[1]!.toLowerCase();
			this.digits(radix === 'x' ? /[0-9a-fA-F]/ : radix === 'b' ? /[01]/ : /[0-7]/, pos);
		} else {
			if (this.peek() === '0' && /[0-9]/.test(this.peek(1))) throw syntaxError('LEGACY_OCTAL', pos);
			if (this.peek() !== '.') this.digits(/[0-9]/, pos);
			if (this.peek() === '.') {
				this.advance();
				if (/[0-9_]/.test(this.peek())) this.digits(/[0-9]/, pos);
			}
			if (this.peek() === 'e' || this.peek() === 'E') {
				this.advance();
				if (this.peek() === '+' || this.peek() === '-') this.advance();
				this.digits(/[0-9]/, pos);
			}
		}
		if (this.peek() === 'n') throw syntaxError('BIGINT', pos);
		if (identifierPart.test(this.codePoint()) || this.peek() === '\\') throw syntaxError('INVALID_NUMBER', pos);
		const raw = this.source.slice(start, this.offset);
		if (/^0_/.test(raw)) throw syntaxError('INVALID_NUMBER', pos);
		return this.token('number', Number(raw.replaceAll('_', '')), start, pos, newline);
	}

	private digits(allowed: RegExp, pos: Pos): void {
		if (!this.peek() || !allowed.test(this.peek())) throw syntaxError('INVALID_NUMBER', pos);
		while (this.peek() && allowed.test(this.peek())) {
			this.advance();
			if (this.peek() === '_') {
				this.advance();
				if (!this.peek() || !allowed.test(this.peek())) throw syntaxError('INVALID_NUMBER', pos);
			}
		}
	}

	private readString(start: number, pos: Pos, newline: boolean): Token {
		const quote = this.advance();
		let value = '';
		while (this.peek() && this.peek() !== quote) {
			if (this.peek() === '\n' || this.peek() === '\r') throw syntaxError('UNTERMINATED_STRING', pos);
			value += this.peek() === '\\' ? this.readEscape() : this.advance();
		}
		if (!this.peek()) throw syntaxError('UNTERMINATED_STRING', pos);
		this.advance();
		return this.token('string', value, start, pos, newline);
	}

	private readTemplate(first: boolean, start: number, pos: Pos, newline: boolean): Token {
		this.advance();
		let value = '';
		while (this.peek()) {
			if (this.peek() === '`') {
				this.advance();
				if (!first) this.templates.pop();
				return this.token(first ? 'template' : 'templateTail', value, start, pos, newline);
			}
			if (this.peek() === '$' && this.peek(1) === '{') {
				this.advance();
				this.advance();
				if (first) this.templates.push({ depth: 0 });
				return this.token(first ? 'templateHead' : 'templateMiddle', value, start, pos, newline);
			}
			if (this.peek() === '\\') value += this.readEscape();
			else {
				const char = this.advance();
				value += char === '\r' ? '\n' : char;
			}
		}
		throw syntaxError('UNTERMINATED_TEMPLATE', pos);
	}

	private readEscape(): string {
		const pos = this.position();
		this.advance();
		const char = this.advance();
		if (!char) throw syntaxError('INVALID_ESCAPE', pos);
		if (lineTerminator.test(char)) return '';
		const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };
		if (char in simple) return simple[char]!;
		if (char === 'x') return String.fromCharCode(this.readHex(2, pos));
		if (char === 'u') return this.readUnicode(pos);
		if (char === '0' && !/[0-9]/.test(this.peek())) return '\0';
		if (/[0-9]/.test(char)) throw syntaxError('INVALID_ESCAPE', pos);
		return char;
	}

	private readUnicode(pos: Pos): string {
		if (this.peek() !== '{') return String.fromCharCode(this.readHex(4, pos));
		this.advance();
		let hex = '';
		while (/[0-9a-fA-F]/.test(this.peek()) && this.peek()) hex += this.advance();
		if (!hex || this.advance() !== '}' || Number.parseInt(hex, 16) > 0x10ffff) throw syntaxError('INVALID_ESCAPE', pos);
		return String.fromCodePoint(Number.parseInt(hex, 16));
	}

	private readHex(length: number, pos: Pos): number {
		let hex = '';
		for (let i = 0; i < length; i++) {
			if (!this.peek() || !/[0-9a-fA-F]/.test(this.peek())) throw syntaxError('INVALID_ESCAPE', pos);
			hex += this.advance();
		}
		return Number.parseInt(hex, 16);
	}
}

export function scan(source: string): Token[] {
	const scanner = new Scanner(source);
	const tokens: Token[] = [];
	do {
		tokens.push(scanner.next());
	} while (tokens.at(-1)!.kind !== 'eof');
	return tokens;
}
