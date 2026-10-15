import type * as A from '../ast.js';
import { syntaxError, TonerikoScriptSyntaxError, type Diagnostic, type DiagnosticCode } from '../diagnostics.js';
import { Scanner, type Token } from './scanner.js';
import { checkEarlyErrors } from './early-errors.js';

// 構文解析の再帰と、同期評価がたどる構文木の高さを同じ上限で制限します。
// 256 は Chromium 153・Firefox 155・WebKit 26.6 で、19 種の構文を受理上限まで
// 解析し、同期評価する式もスタックを溢れさせずに実行できる深さです。
// 再現手順は scripts/v2-browser-depth.mjs にあります。
const MAX_SYNTAX_DEPTH = 256;

const assignments = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '??=']);
const bitwise = new Set(['&', '|', '^', '~', '<<', '>>', '>>>', '&=', '|=', '^=', '<<=', '>>=', '>>>=']);
const precedence: Record<string, number> = {
	'??': 1, '||': 1, '&&': 2, '==': 3, '!=': 3, '===': 3, '!==': 3,
	'<': 4, '<=': 4, '>': 4, '>=': 4, in: 4,
	'+': 5, '-': 5, '*': 6, '/': 6, '%': 6, '**': 7,
};
const reserved = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'await', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'static']);
const forbidden: Record<string, DiagnosticCode> = {
	class: 'CLASS', this: 'THIS', var: 'VAR', eval: 'EVAL', Function: 'FUNCTION_CONSTRUCTOR',
	with: 'WITH', Symbol: 'SYMBOL', BigInt: 'BIGINT', arguments: 'ARGUMENTS', debugger: 'DEBUGGER',
	import: 'IMPORT', Promise: 'PROMISE', undefined: 'UNDEFINED', super: 'SUPER', yield: 'YIELD',
	interface: 'TYPE_INTERFACE', enum: 'TYPE_ENUM',
};

export function parse(source: string): { program: A.Program; warnings: Diagnostic[] } {
	const program = new Parser(source).program();
	checkEarlyErrors(program);
	return { program, warnings: [] };
}

class Parser {
	private readonly scanner: Scanner;
	private readonly tokens: Token[] = [];
	private index = 0;
	private syntaxDepth = 0;
	private readonly nodeDepths = new WeakMap<object, number>();
	private previous: Token | undefined;
	private lexicalError: unknown;
	private functionDepth = 0;
	private loopDepth = 0;
	private switchDepth = 0;
	private labels = new Map<string, boolean>();
	// 括弧は公開 AST から省き、演算子と代入先の構文制約にだけ使います。
	private readonly parenthesized = new WeakSet<A.Expression>();
	private readonly trailingComma = new WeakSet<A.Expression>();
	private readonly failedTypeArguments = new Set<number>();
	private readonly parenthesisEnds = new Map<number, number | null>();
	private readonly arrowLookaheads = new Map<number, boolean>();
	private readonly parameterLists = new Map<number, { params: A.Pattern[]; end: number } | { error: unknown }>();
	private readonly arrows = new Map<number, { expression: A.ArrowFunctionExpression; end: number }>();

	constructor(source: string) { this.scanner = new Scanner(source); }

	private forbidden(name: string): DiagnosticCode | undefined {
		return Object.hasOwn(forbidden, name) ? forbidden[name] : undefined;
	}

	private peek(offset = 0): Token {
		while (this.tokens.length <= this.index + offset) {
			if (this.lexicalError) throw this.lexicalError;
			try { this.tokens.push(this.scanner.next()); }
			catch (error) { this.lexicalError = error; throw error; }
		}
		return this.tokens[this.index + offset]!;
	}
	private at(value: string): boolean { return this.peek().raw === value; }
	private take(): Token { const token = this.peek(); this.index++; this.previous = token; return token; }
	private eat(value: string): boolean { if (!this.at(value)) return false; this.take(); return true; }
	private fail(code: DiagnosticCode, token: Token | A.NodeBase = this.peek(), params: Record<string, string | number> = {}): never {
		throw syntaxError(code, token.loc.start, params);
	}
	private expect(value: string): Token {
		if (!this.at(value) && this.at(':')) this.fail('AISCRIPT_NAMESPACE');
		if (!this.at(value)) this.fail('UNEXPECTED_TOKEN', this.peek(), { expected: value, actual: this.peek().raw });
		return this.take();
	}
	private nested<T>(read: () => T): T {
		if (this.syntaxDepth >= MAX_SYNTAX_DEPTH) this.fail('NESTING_TOO_DEEP');
		this.syntaxDepth++;
		try { return read(); }
		finally { this.syntaxDepth--; }
	}
	private nodeDepth(node: A.NodeBase & { type: string }): number {
		const cached = this.nodeDepths.get(node);
		if (cached !== undefined) return cached;
		let depth = 1;
		for (const value of Object.values(node)) {
			const children = Array.isArray(value) ? value : [value];
			for (const child of children) {
				if (child && typeof child === 'object' && 'type' in child && 'loc' in child) {
					depth = Math.max(depth, this.nodeDepth(child) + 1);
				}
			}
		}
		if (depth > MAX_SYNTAX_DEPTH) this.fail('NESTING_TOO_DEEP', node);
		this.nodeDepths.set(node, depth);
		return depth;
	}
	private node<const T extends { type: string }>(start: A.NodeBase, fields: T): T & A.NodeBase {
		const node = { ...fields, loc: { start: start.loc.start, end: this.previous?.loc.end ?? start.loc.end } };
		this.nodeDepth(node);
		return node;
	}
	private identifier(property = false): A.Identifier {
		const t = this.peek();
		if (t.kind !== 'identifier' || (!property && reserved.has(String(t.value)))) this.fail('UNEXPECTED_TOKEN');
		this.take();
		return this.node(t, { type: 'Identifier', name: String(t.value) });
	}
	private endStatement(): void {
		if (this.eat(';') || this.at('}') || this.peek().kind === 'eof' || this.peek().lineBreakBefore) return;
		if (this.at(',')) this.fail('COMMA_OPERATOR');
		if (this.at(':')) this.fail('AISCRIPT_NAMESPACE');
		this.fail('UNEXPECTED_TOKEN', this.peek(), { expected: ';', actual: this.peek().raw });
	}
	private continuation(boundary: boolean): void {
		if (boundary && this.peek().lineBreakBefore && ['(', '[', '`', '+', '-', '/'].some(x => this.peek().raw.startsWith(x))) {
			this.fail('NEWLINE_CONTINUATION');
		}
	}

	program(): A.Program {
		const body: A.Statement[] = [];
		while (this.peek().kind !== 'eof') body.push(this.statement(true));
		const program: A.Program = { type: 'Program', sourceType: 'module', body, loc: { start: { line: 1, column: 1 }, end: this.peek().loc.end } };
		this.nodeDepth(program);
		return program;
	}

	private statement(topLevel = false, single = false): A.Statement {
		return this.nested(() => this.statementBody(topLevel, single));
	}
	private statementBody(topLevel = false, single = false): A.Statement {
		const t = this.peek();
		const word = String(t.value);
		if (this.eat(';')) return this.node(t, { type: 'EmptyStatement' });
		if (this.at('{')) return this.block();
		if (this.at('const') || this.at('let')) {
			if (single) this.fail('UNEXPECTED_TOKEN');
			const declaration = this.variables(false);
			this.endStatement();
			declaration.loc.end = this.previous!.loc.end;
			return declaration;
		}
		if (this.at('function') || (this.at('async') && this.peek(1).raw === 'function' && !this.peek(1).lineBreakBefore)) {
			if (single) this.fail('UNEXPECTED_TOKEN');
			return this.functionDeclaration();
		}
		switch (t.raw) {
			case 'if': {
				this.take();
				if (!this.at('(')) this.fail('AISCRIPT_IF', t);
				const test = this.condition();
				const consequent = this.statement(false, true);
				const alternate = this.eat('else') ? this.statement(false, true) : null;
				return this.node(t, { type: 'IfStatement', test, consequent, alternate });
			}
			case 'for': return this.forStatement();
			case 'while': {
				this.take();
				const test = this.condition();
				const body = this.loopBody();
				return this.node(t, { type: 'WhileStatement', test, body });
			}
			case 'do': {
				this.take();
				const body = this.loopBody();
				this.expect('while');
				const test = this.condition();
				this.eat(';');
				return this.node(t, { type: 'DoWhileStatement', body, test });
			}
			case 'return': {
				this.take();
				const newline = this.peek().lineBreakBefore;
				if (newline && this.expressionStart()) this.fail('NEWLINE_RETURN', t);
				if (!this.functionDepth) this.fail('INVALID_CONTROL_FLOW', t);
				const argument = newline || this.at(';') || this.at('}') || this.peek().kind === 'eof' ? null : this.expression(0, false, true);
				this.endStatement();
				return this.node(t, { type: 'ReturnStatement', argument });
			}
			case 'break': case 'continue': {
				this.take();
				const label = !this.peek().lineBreakBefore && this.peek().kind === 'identifier' ? this.identifier() : null;
				if (label ? !this.labels.has(label.name) || (t.raw === 'continue' && !this.labels.get(label.name)) : !(this.loopDepth || (t.raw === 'break' && this.switchDepth))) this.fail('INVALID_CONTROL_FLOW', t);
				this.endStatement();
				return this.node(t, { type: t.raw === 'break' ? 'BreakStatement' : 'ContinueStatement', label });
			}
			case 'switch': return this.switchStatement();
			case 'try': return this.tryStatement();
			case 'throw': {
				this.take();
				if (this.peek().lineBreakBefore) this.fail('NEWLINE_THROW', t);
				const argument = this.expression(0, false, true);
				this.endStatement();
				return this.node(t, { type: 'ThrowStatement', argument });
			}
			case 'export': {
				this.take();
				if (!topLevel || !this.at('const')) this.fail('INVALID_META', t);
				const declaration = this.variables(false);
				const d = declaration.declarations[0];
				if (declaration.declarations.length !== 1 || d?.id.type !== 'Identifier' || d.id.name !== 'meta' || d.id.typeAnnotation || d.init?.type !== 'ObjectExpression' || !this.literalMeta(d.init)) this.fail('INVALID_META', t);
				this.endStatement();
				declaration.loc.end = this.previous!.loc.end;
				return this.node(t, { type: 'ExportMetaDeclaration', declaration });
			}
			case 'each': if (this.peek(1).raw === 'let' && !this.peek(1).lineBreakBefore) this.fail('AISCRIPT_EACH'); break;
			case 'match': if (this.matchAhead()) this.fail('AISCRIPT_MATCH'); break;
			case '@': this.fail('AISCRIPT_FUNCTION');
			case '#': if (this.peek(1).raw === '#' && this.peek(2).raw === '#') this.fail('AISCRIPT_META'); break;
		}
		if (this.at('<') && this.peek(1).raw === ':') this.fail('AISCRIPT_OUTPUT');
		if (this.at('eval') && this.peek(1).raw === '{') this.fail('AISCRIPT_EVAL');
		if (this.at('type') && this.peek(1).kind === 'identifier' && !this.peek(1).lineBreakBefore && !reserved.has(String(this.peek(1).value))) this.fail('TYPE_ALIAS');
		if (t.kind === 'identifier' && this.forbidden(word)) this.fail(this.forbidden(word)!, t);
		if (t.kind === 'identifier' && this.peek(1).raw === ':') {
			const label = this.identifier();
			this.expect(':');
			let offset = 0;
			while (this.peek(offset).kind === 'identifier' && this.peek(offset + 1).raw === ':') offset += 2;
			const target = this.peek(offset).raw;
			if (target === 'function' || (target === 'async' && this.peek(offset + 1).raw === 'function')) this.fail('LABELED_FUNCTION', t);
			if (!['for', 'while', 'do', '{'].includes(target)) this.fail(this.peek(offset).kind === 'identifier' && !reserved.has(String(this.peek(offset).value)) ? 'AISCRIPT_NAMESPACE' : 'INVALID_LABEL', t);
			if (this.labels.has(label.name)) this.fail('INVALID_LABEL', t);
			this.labels.set(label.name, target !== '{');
			const body = this.statement();
			this.labels.delete(label.name);
			return this.node(t, { type: 'LabeledStatement', label, body });
		}
		if (t.kind === 'identifier' && this.forbidden(word)) this.fail(this.forbidden(word)!, t);
		const expression = this.expression(0, true, true);
		this.endStatement();
		return this.node(t, { type: 'ExpressionStatement', expression });
	}

	private block(): A.BlockStatement {
		const t = this.expect('{');
		const body: A.Statement[] = [];
		while (!this.at('}')) {
			if (this.peek().kind === 'eof') this.fail('UNEXPECTED_TOKEN');
			body.push(this.statement());
		}
		this.take();
		return this.node(t, { type: 'BlockStatement', body });
	}
	private condition(): A.Expression {
		this.expect('(');
		const expression = this.expression();
		if (this.at(',')) this.fail('COMMA_OPERATOR');
		this.expect(')');
		return expression;
	}
	private loopBody(): A.Statement {
		this.loopDepth++;
		const body = this.statement(false, true);
		this.loopDepth--;
		return body;
	}
	private variables(inFor: boolean): A.VariableDeclaration {
		const t = this.take();
		const kind = t.raw as 'const' | 'let';
		const declarations: A.VariableDeclarator[] = [];
		do {
			const start = this.peek();
			const id = this.binding(false);
			if (this.at('!') && !this.peek().lineBreakBefore) this.fail('TYPE_DEFINITE_ASSIGNMENT');
			const init = this.eat('=') ? this.expression(0, false, !inFor, !inFor) : null;
			if (!init && (!inFor || (!this.at('of') && !this.at('in'))) && (kind === 'const' || id.type !== 'Identifier')) this.fail('UNEXPECTED_TOKEN', start);
			declarations.push(this.node(start, { type: 'VariableDeclarator', id, init }));
		} while (this.eat(','));
		return this.node(t, { type: 'VariableDeclaration', kind, declarations });
	}
	private forStatement(): A.ForStatement | A.ForOfStatement {
		const t = this.take();
		if (!this.at('(')) this.fail('AISCRIPT_FOR', t);
		this.take();
		let init: A.VariableDeclaration | A.Expression | null = null;
		if (!this.at(';')) init = this.at('const') || this.at('let') ? this.variables(true) : this.expression(0, true, false, false, true);
		if (this.at('in')) this.fail('FOR_IN');
		if (this.eat('of')) {
			if (!init) this.fail('INVALID_ASSIGNMENT_TARGET', t);
			let left: A.ForOfStatement['left'];
			if (init.type === 'VariableDeclaration') {
				if (init.declarations.length !== 1 || init.declarations[0]!.init) this.fail('INVALID_ASSIGNMENT_TARGET', init);
				left = init;
			} else {
				if (init.type === 'Identifier' && init.name === 'async' && !this.parenthesized.has(init)) this.fail('UNEXPECTED_TOKEN', init);
				left = this.assignmentTarget(init, true);
			}
			const right = this.expression();
			this.expect(')');
			const body = this.loopBody();
			return this.node(t, { type: 'ForOfStatement', left, right, body, await: false });
		}
		if (init && init.type !== 'VariableDeclaration') {
			if (init.type === 'UpdateExpression') this.fail('UPDATE_IN_EXPRESSION', init);
			this.checkExpression(init, true);
		}
		if (init?.type === 'VariableDeclaration' && init.declarations.some(d => !d.init && (init.kind === 'const' || d.id.type !== 'Identifier'))) this.fail('UNEXPECTED_TOKEN', init);
		if (this.at(',')) this.fail('COMMA_OPERATOR');
		this.expect(';');
		const test = this.at(';') ? null : this.expression();
		this.expect(';');
		const update = this.at(')') ? null : this.expression(0, true);
		if (this.at(',')) this.fail('COMMA_OPERATOR');
		this.expect(')');
		const body = this.loopBody();
		return this.node(t, { type: 'ForStatement', init, test, update, body });
	}
	private switchStatement(): A.SwitchStatement {
		const t = this.take();
		const discriminant = this.condition();
		this.expect('{');
		const cases: A.SwitchCase[] = [];
		let hasDefault = false;
		this.switchDepth++;
		while (!this.at('}')) {
			const start = this.peek();
			let test: A.Expression | null;
			if (this.eat('case')) test = this.expression(0, false, false, true, false, false);
			else {
				this.expect('default');
				if (hasDefault) this.fail('UNEXPECTED_TOKEN', start);
				hasDefault = true;
				test = null;
			}
			if (test && this.undefinedText(test)) this.fail('TYPEOF_UNDEFINED_COMPARISON', test);
			this.expect(':');
			const consequent: A.Statement[] = [];
			while (!this.at('case') && !this.at('default') && !this.at('}')) consequent.push(this.statement());
			cases.push(this.node(start, { type: 'SwitchCase', test, consequent }));
		}
		this.take();
		this.switchDepth--;
		return this.node(t, { type: 'SwitchStatement', discriminant, cases });
	}
	private tryStatement(): A.TryStatement {
		const t = this.take();
		const block = this.block();
		let handler: A.CatchClause | null = null;
		if (this.at('catch')) {
			const start = this.take();
			let param: A.Pattern | null = null;
			if (this.eat('(')) { param = this.binding(false); this.expect(')'); }
			const body = this.block();
			handler = this.node(start, { type: 'CatchClause', param, body });
		}
		const finalizer = this.eat('finally') ? this.block() : null;
		if (!handler && !finalizer) this.fail('UNEXPECTED_TOKEN');
		return this.node(t, { type: 'TryStatement', block, handler, finalizer });
	}
	private literalMeta(expression: A.Expression): boolean {
		if (expression.type === 'Literal') return true;
		if (expression.type === 'UnaryExpression') return expression.operator === '-' && expression.argument.type === 'Literal' && typeof expression.argument.value === 'number';
		if (expression.type === 'ArrayExpression') return expression.elements.every(e => e !== null && e.type !== 'SpreadElement' && this.literalMeta(e));
		if (expression.type === 'ObjectExpression') return expression.properties.every(p => p.type === 'Property' && !p.computed && !p.shorthand && this.literalMeta(p.value as A.Expression));
		return false;
	}

	private binding(defaultValue: boolean, parameter = false, allowRest = false, annotation: 'allow' | 'forbid' | 'rest' = 'allow'): A.Pattern {
		return this.nested(() => this.bindingBody(defaultValue, parameter, allowRest, annotation));
	}
	private bindingBody(defaultValue: boolean, parameter = false, allowRest = false, annotation: 'allow' | 'forbid' | 'rest' = 'allow'): A.Pattern {
		const start = this.peek();
		let pattern: A.Pattern;
		if (this.eat('...')) {
			if (!allowRest) this.fail('UNEXPECTED_TOKEN', start);
			const argument = this.binding(false, false, false, 'rest');
			pattern = this.node(start, { type: 'RestElement', argument });
		} else if (this.eat('[')) {
			const elements: (A.Pattern | null)[] = [];
			while (!this.at(']')) {
				if (this.eat(',')) { elements.push(null); continue; }
				const item = this.binding(true, false, true, 'forbid');
				elements.push(item);
				if (item.type === 'RestElement') { if (this.at(',')) this.fail('UNEXPECTED_TOKEN'); break; }
				if (!this.eat(',')) break;
			}
			this.expect(']');
			pattern = this.node(start, { type: 'ArrayPattern', elements });
		} else if (this.eat('{')) {
			const properties: (A.Property | A.RestElement)[] = [];
			while (!this.at('}')) {
				if (this.at('...')) {
					const rest = this.binding(false, false, true, 'forbid');
					if (rest.type !== 'RestElement' || rest.argument.type !== 'Identifier') this.fail('INVALID_ASSIGNMENT_TARGET', rest);
					properties.push(rest);
					if (this.at(',')) this.fail('UNEXPECTED_TOKEN');
					break;
				}
				const propertyStart = this.peek();
				const { key, computed } = this.propertyKey();
				const shorthand = !this.eat(':');
				let value: A.Pattern;
				if (shorthand) {
					if (key.type !== 'Identifier' || computed || reserved.has(key.name)) this.fail('UNEXPECTED_TOKEN', key);
					value = { ...key, loc: { ...key.loc } };
					if (this.eat('=')) value = this.node(key, { type: 'AssignmentPattern', left: value, right: this.expression() });
				} else value = this.binding(true, false, false, 'forbid');
				properties.push(this.node(propertyStart, { type: 'Property', key, value, kind: 'init', method: false, shorthand, computed }));
				if (!this.eat(',')) break;
			}
			this.expect('}');
			pattern = this.node(start, { type: 'ObjectPattern', properties });
		} else pattern = this.identifier();
		if (parameter && this.eat('?')) {
			if (pattern.type !== 'Identifier') this.fail('UNEXPECTED_TOKEN', start);
			pattern.optional = true;
		}
		if (annotation === 'forbid' && this.at(':')) this.fail('UNEXPECTED_TOKEN');
		if (annotation === 'allow' && this.eat(':')) {
			pattern.typeAnnotation = this.typeAnnotation();
			this.nodeDepths.delete(pattern);
			this.nodeDepth(pattern);
		}
		pattern.loc.end = this.previous!.loc.end;
		if (defaultValue && this.eat('=')) {
			if (pattern.type === 'RestElement' || ('optional' in pattern && pattern.optional)) this.fail('UNEXPECTED_TOKEN', start);
			pattern = this.node(start, { type: 'AssignmentPattern', left: pattern, right: this.expression() });
		}
		return pattern;
	}

	private parameters(): A.Pattern[] {
		const start = this.index;
		// 既定値にも試し読みを伴う関数が入るため、引数列の再解析も避けます。
		const cached = this.parameterLists.get(start);
		if (cached) {
			if ('error' in cached) throw cached.error;
			this.index = cached.end;
			this.previous = this.tokens[this.index - 1];
			return cached.params;
		}
		try {
			this.expect('(');
			const params: A.Pattern[] = [];
			while (!this.at(')')) {
				if (this.at('this')) this.fail('TYPE_THIS_PARAMETER');
				const param = this.binding(true, true, true);
				params.push(param);
				if (param.type === 'RestElement') {
					if (this.at(',')) this.fail('UNEXPECTED_TOKEN');
					break;
				}
				if (!this.eat(',')) break;
			}
			this.expect(')');
			this.parameterLists.set(start, { params, end: this.index });
			return params;
		} catch (error) {
			this.parameterLists.set(start, { error });
			throw error;
		}
	}
	private functionBody(): A.BlockStatement {
		const saved = { loop: this.loopDepth, switch: this.switchDepth, labels: this.labels };
		this.loopDepth = 0; this.switchDepth = 0; this.labels = new Map(); this.functionDepth++;
		const body = this.block();
		this.functionDepth--; this.loopDepth = saved.loop; this.switchDepth = saved.switch; this.labels = saved.labels;
		return body;
	}
	private functionDeclaration(): A.FunctionDeclaration {
		const start = this.peek();
		const async = this.eat('async');
		this.expect('function');
		if (this.at('*')) this.fail('GENERATOR');
		const id = this.identifier();
		if (this.at('<')) this.fail('TYPE_ARGUMENTS');
		const params = this.parameters();
		const returnType = this.eat(':') ? this.typeAnnotation() : undefined;
		const body = this.functionBody();
		return this.node(start, { type: 'FunctionDeclaration', id, params, body, async, generator: false, ...(returnType ? { returnType } : {}) });
	}
	private typeAnnotation(): A.TypeAnnotation {
		return this.nested(() => this.typeAnnotationBody());
	}
	private typeAnnotationBody(): A.TypeAnnotation {
		const start = this.peek();
		const leadingUnion = this.eat('|');
		const types = [this.typeAtom()];
		while (this.eat('|')) types.push(this.typeAtom());
		if (this.at('&')) this.fail('UNSUPPORTED_TYPE');
		return types.length === 1 && !leadingUnion ? types[0]! : this.node(start, { type: 'UnionTypeAnnotation', types });
	}
	private typeAtom(): A.TypeAnnotation {
		const start = this.peek();
		let type: A.TypeAnnotation;
		if (this.eat('(')) {
			const typeAnnotation = this.typeAnnotation();
			this.expect(')');
			type = this.node(start, { type: 'ParenthesizedTypeAnnotation', typeAnnotation });
		} else if (this.eat('{')) {
			const properties: A.TypeProperty[] = [];
			while (!this.at('}')) {
				const propertyStart = this.peek();
				if (this.at('[')) this.fail('UNSUPPORTED_TYPE');
				const key = this.peek().kind === 'string' || this.peek().kind === 'number' ? this.literal() : this.identifier(true);
				const optional = this.eat('?');
				this.expect(':');
				const typeAnnotation = this.typeAnnotation();
				properties.push(this.node(propertyStart, { type: 'TypeProperty', key, optional, typeAnnotation }));
				if (!this.eat(';') && !this.eat(',') && !this.at('}') && !this.peek().lineBreakBefore) this.fail('UNEXPECTED_TOKEN');
			}
			this.expect('}');
			type = this.node(start, { type: 'ObjectTypeAnnotation', properties });
		} else if (['number', 'string', 'boolean', 'null', 'any', 'void'].includes(start.raw)) {
			this.take();
			type = this.node(start, { type: 'KeywordTypeAnnotation', name: start.raw as A.KeywordTypeAnnotation['name'] });
		} else if (this.eat('Function')) type = this.node(start, { type: 'FunctionTypeAnnotation' });
		else {
			if (this.at('undefined')) this.fail('UNDEFINED');
			if (this.at('Array')) this.fail('TYPE_ARRAY_GENERIC');
			if (this.at('Record')) this.fail('TYPE_RECORD');
			if (this.at('[')) this.fail('TYPE_TUPLE');
			if (start.kind === 'string' || start.kind === 'number' || ['true', 'false', '-', '`'].includes(start.raw) || start.kind.startsWith('template')) this.fail('TYPE_LITERAL');
			if (this.at('<')) this.fail('TYPE_ARGUMENTS');
			this.fail('UNSUPPORTED_TYPE');
		}
		while (!this.peek().lineBreakBefore && this.eat('[')) {
			this.expect(']');
			type = this.node(start, { type: 'ArrayTypeAnnotation', elementType: type });
		}
		if (this.at('<')) this.fail('TYPE_ARGUMENTS');
		return type;
	}

	private expression(min = 0, mutation = false, boundary = false, allowIn = true, cover = false, allowReturnType = true): A.Expression {
		return this.nested(() => this.expressionBody(min, mutation, boundary, allowIn, cover, allowReturnType));
	}
	private expressionBody(min = 0, mutation = false, boundary = false, allowIn = true, cover = false, allowReturnType = true): A.Expression {
		const start = this.peek();
		let left = this.unary(mutation, boundary, min === 0, allowReturnType);
		while (true) {
			const operator = this.peek().raw;
			if (bitwise.has(operator)) this.fail(operator === '^' ? 'AISCRIPT_POWER' : 'BITWISE');
			if (operator === 'instanceof') this.fail('INSTANCEOF');
			if ((operator === 'as' || operator === 'satisfies') && !this.peek().lineBreakBefore) this.fail('TYPE_ASSERTION');
			if (operator === '&&=' || operator === '||=') this.fail('LOGICAL_ASSIGNMENT', this.peek(), { operator: operator.slice(0, -1) });
			if (operator === '!' && !this.peek().lineBreakBefore) this.fail('NON_NULL_ASSERTION');
			const priority = Object.hasOwn(precedence, operator) ? precedence[operator] : undefined;
			if (priority === undefined || priority < min || (operator === 'in' && !allowIn)) break;
			if (left.type === 'ArrowFunctionExpression' && !this.parenthesized.has(left)) break;
			this.continuation(boundary);
			const op = this.take();
			if (left.type === 'UpdateExpression') this.fail('UPDATE_IN_EXPRESSION', left);
			if (operator === '**' && (left.type === 'UnaryExpression' || left.type === 'AwaitExpression') && !this.parenthesized.has(left)) this.fail('UNARY_POWER', op);
			const right = this.expression(operator === '**' ? priority : priority + 1, false, boundary, allowIn, false, allowReturnType);
			if (operator === '===' || operator === '!==' || operator === '==' || operator === '!=') {
				if (this.undefinedText(left) || this.undefinedText(right)) this.fail('TYPEOF_UNDEFINED_COMPARISON', op);
			}
			if (operator === '==' || operator === '!=') {
				if (!(left.type === 'Literal' && left.value === null) && !(right.type === 'Literal' && right.value === null)) this.fail('LOOSE_EQUALITY', op);
			}
			if (operator === '&&' || operator === '||' || operator === '??') {
				for (const operand of [left, right]) {
					if (operand.type === 'LogicalExpression' && !this.parenthesized.has(operand) && ((operand.operator === '??') !== (operator === '??'))) this.fail('NULLISH_MIX', op);
				}
				left = this.node(start, { type: 'LogicalExpression', operator, left, right });
			} else left = this.node(start, { type: 'BinaryExpression', operator: operator as A.BinaryExpression['operator'], left, right });
		}
		if (min === 0 && this.eat('?')) {
			if (left.type === 'ArrowFunctionExpression' && !this.parenthesized.has(left)) this.fail('UNEXPECTED_TOKEN');
			if (left.type === 'UpdateExpression') this.fail('UPDATE_IN_EXPRESSION', left);
			const consequent = this.expression(0, false, false, true, false, false);
			this.expect(':');
			const alternate = this.expression(0, false, boundary, allowIn, false, allowReturnType);
			left = this.node(start, { type: 'ConditionalExpression', test: left, consequent, alternate });
		}
		if (min === 0 && assignments.has(this.peek().raw)) {
			const op = this.peek();
			if (!mutation) this.fail('ASSIGNMENT_IN_EXPRESSION', op);
			this.take();
			const target = this.assignmentTarget(left, op.raw === '=');
			const right = this.expression(0, false, boundary, allowIn);
			left = this.node(start, { type: 'AssignmentExpression', operator: op.raw as A.AssignmentExpression['operator'], left: target, right });
		}
		if (!mutation && left.type === 'UpdateExpression') this.fail('UPDATE_IN_EXPRESSION', left);
		if (!cover) this.checkExpression(left, true);
		return left;
	}
	private undefinedText(node: A.Expression): boolean {
		return (node.type === 'Literal' && node.value === 'undefined') || (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis[0]?.value.cooked === 'undefined');
	}

	private unary(mutation: boolean, boundary: boolean, allowArrow: boolean, allowReturnType = true): A.Expression {
		const t = this.peek();
		if (['!', '-', '+', 'typeof', 'delete', 'await'].includes(t.raw)) {
			this.take();
			const argument = this.nested(() => this.unary(false, boundary, false, allowReturnType));
			if (t.raw === 'delete' && argument.type === 'Identifier') this.fail('STRICT_DELETE_IDENTIFIER', argument);
			if (argument.type === 'UpdateExpression') this.fail('UPDATE_IN_EXPRESSION', argument);
			if (t.raw === 'await') return this.node(t, { type: 'AwaitExpression', argument });
			return this.node(t, { type: 'UnaryExpression', operator: t.raw as A.UnaryExpression['operator'], prefix: true, argument });
		}
		if (t.raw === 'void') this.fail('VOID_OPERATOR');
		if (t.raw === '~') this.fail('BITWISE');
		if (this.at('++') || this.at('--')) {
			if (!mutation) this.fail('UPDATE_IN_EXPRESSION');
			this.take();
			const argument = this.assignmentTarget(this.nested(() => this.unary(false, boundary, false, allowReturnType)), false);
			if (argument.type !== 'Identifier' && argument.type !== 'MemberExpression') this.fail('INVALID_ASSIGNMENT_TARGET', argument);
			return this.node(t, { type: 'UpdateExpression', operator: t.raw as '++' | '--', prefix: true, argument });
		}
		let expression = this.primary(mutation, boundary, allowArrow, allowReturnType);
		expression = this.suffix(expression, boundary, t);
		if ((this.at('++') || this.at('--')) && !this.peek().lineBreakBefore) {
			if (!mutation) this.fail('UPDATE_IN_EXPRESSION');
			const op = this.take();
			const argument = this.assignmentTarget(expression, false);
			if (argument.type !== 'Identifier' && argument.type !== 'MemberExpression') this.fail('INVALID_ASSIGNMENT_TARGET', argument);
			expression = this.node(t, { type: 'UpdateExpression', operator: op.raw as '++' | '--', prefix: false, argument });
		}
		return expression;
	}

	// 先読みで後方の字句エラーを発見しても、手前の構文エラーを先に報告します。
	private lookahead(offset: number): Token | undefined {
		try { return this.peek(offset); }
		catch { return undefined; }
	}
	private expressionStart(): boolean {
		const token = this.peek();
		if (token.kind === 'identifier' && this.peek(1).raw === ':') return false;
		if (token.raw === 'function' || token.raw === 'class' || (token.raw === 'async' && this.peek(1).raw === 'function' && !this.peek(1).lineBreakBefore)) return false;
		if (['number', 'string', 'template', 'templateHead'].includes(token.kind)) return true;
		if (token.kind === 'identifier') return !reserved.has(String(token.value)) || ['true', 'false', 'null', 'this', 'super', 'function', 'class', 'new', 'typeof', 'delete', 'void', 'await', 'yield', 'import'].includes(token.raw);
		return ['(', '[', '{', '!', '~', '+', '-', '++', '--', '/', '/='].includes(token.raw);
	}
	private matchAhead(): boolean {
		const token = this.lookahead(1);
		return token !== undefined && !token.lineBreakBefore && (['number', 'string', 'template', 'templateHead'].includes(token.kind) || (token.kind === 'identifier' && (!reserved.has(String(token.value)) || ['true', 'false', 'null'].includes(token.raw))));
	}

	private arrowAhead(offset = 0, allowReturnType = true): boolean {
		const key = this.index * 4 + offset * 2 + Number(allowReturnType);
		const cached = this.arrowLookaheads.get(key);
		if (cached !== undefined) return cached;
		const result = this.detectArrow(offset, allowReturnType);
		this.arrowLookaheads.set(key, result);
		return result;
	}
	private closingParenthesis(offset: number): number | undefined {
		const start = this.index + offset;
		const cached = this.parenthesisEnds.get(start);
		if (cached !== undefined) return cached ?? undefined;
		const opening: number[] = [];
		for (let i = offset; ; i++) {
			const token = this.lookahead(i);
			if (!token || token.kind === 'eof') {
				for (const index of opening) this.parenthesisEnds.set(index, null);
				return undefined;
			}
			if (token.raw === '(') opening.push(this.index + i);
			if (token.raw === ')') {
				// 外側を走査したときに内側の対応も残し、既定値の入れ子を再走査しません。
				this.parenthesisEnds.set(opening.pop()!, this.index + i);
				if (!opening.length) return this.index + i;
			}
		}
	}
	private detectArrow(offset: number, allowReturnType: boolean): boolean {
		if (this.peek(offset).raw !== '(') return this.peek(offset).kind === 'identifier' && this.lookahead(offset + 1)?.raw === '=>';
		const end = this.closingParenthesis(offset);
		if (end === undefined) return false;
		const after = end - this.index + 1;
		if (this.lookahead(after)?.raw === '=>') return true;
		if (this.lookahead(after)?.raw !== ':' || !this.returnTypeAhead(after + 1)) return false;
		const saved = { index: this.index, previous: this.previous, functionDepth: this.functionDepth, loopDepth: this.loopDepth, switchDepth: this.switchDepth, labels: new Map(this.labels) };
		try {
			if (allowReturnType) {
				this.index += offset;
				this.parameters();
				return true;
			}
			// 条件式の真側では、戻り値型を読んでも条件式の区切りが残る場合だけ採用します。
			this.arrow(offset !== 0, false, false);
			return this.at(':');
		} catch (error) {
			return allowReturnType && error instanceof TonerikoScriptSyntaxError && error.code !== 'UNEXPECTED_TOKEN';
		} finally {
			this.index = saved.index; this.previous = saved.previous;
			this.functionDepth = saved.functionDepth; this.loopDepth = saved.loopDepth; this.switchDepth = saved.switchDepth; this.labels = saved.labels;
		}
	}
	private returnTypeAhead(offset: number): boolean {
		const closing: string[] = [];
		for (let i = offset; ; i++) {
			const token = this.lookahead(i);
			if (!token || token.kind === 'eof' || (token.kind === 'identifier' && reserved.has(String(token.value)) && !['void', 'null', 'true', 'false', 'typeof', 'this', 'new'].includes(token.raw))) return false;
			if (!closing.length) {
				if (token.raw === '=>') return true;
				if ([';', ',', '=', '?', ':', ')', '}', ']'].includes(token.raw)) return false;
			}
			if (token.raw === '(') closing.push(')');
			if (token.raw === '{') closing.push('}');
			if (token.raw === '[') closing.push(']');
			if (token.raw === closing.at(-1)) closing.pop();
		}
	}
	private arrow(async: boolean, boundary: boolean, allowReturnType = true): A.ArrowFunctionExpression {
		// 改行と条件式の区切りの扱いが違う解析結果は共有しません。
		const key = this.index * 4 + Number(boundary) * 2 + Number(allowReturnType);
		const cached = this.arrows.get(key);
		if (cached) {
			this.index = cached.end;
			this.previous = this.tokens[this.index - 1];
			return { ...cached.expression };
		}
		const start = this.peek();
		if (async) this.take();
		const params = this.at('(') ? this.parameters() : [this.identifier()];
		const returnType = this.eat(':') ? this.typeAnnotation() : undefined;
		if (this.peek().lineBreakBefore) this.fail('NEWLINE_ARROW');
		this.expect('=>');
		if (this.at('{') && this.peek(1).kind === 'identifier' && this.peek(2).raw === ':') {
			let offset = 3;
			while (this.peek(offset).kind === 'identifier' && this.peek(offset + 1).raw === ':') offset += 2;
			if (!['for', 'while', 'do', '{', 'function', 'async'].includes(this.peek(offset).raw)) this.fail('ARROW_OBJECT_BODY', this.peek(1));
		}
		const body = this.at('{') ? this.functionBody() : this.expression(0, false, boundary, true, false, allowReturnType);
		const expression = this.node(start, { type: 'ArrowFunctionExpression', params, body, async, generator: false, expression: body.type !== 'BlockStatement', ...(returnType ? { returnType } : {}) });
		// 試し読みした本体は再解析せず、外側の括弧の印が漏れないよう根だけ複製します。
		this.arrows.set(key, { expression, end: this.index });
		return { ...expression };
	}
	private primary(mutation: boolean, boundary: boolean, allowArrow: boolean, allowReturnType: boolean): A.Expression {
		const t = this.peek();
		if (this.at('async') && !this.peek(1).lineBreakBefore && this.arrowAhead(1, allowReturnType)) {
			if (!allowArrow) this.fail('UNEXPECTED_TOKEN');
			return this.arrow(true, boundary, allowReturnType);
		}
		if ((this.at('(') || t.kind === 'identifier') && this.arrowAhead(0, allowReturnType)) {
			if (!allowArrow) this.fail('UNEXPECTED_TOKEN');
			return this.arrow(false, boundary, allowReturnType);
		}
		if (this.eat('(')) {
			const expression = this.expression(0, mutation, false, true);
			if (this.at(',')) this.fail('COMMA_OPERATOR');
			this.expect(')');
			this.parenthesized.add(expression);
			return expression;
		}
		if (t.kind === 'number' || t.kind === 'string' || ['true', 'false', 'null'].includes(t.raw)) return this.literal();
		if (t.kind === 'template' || t.kind === 'templateHead') return this.template();
		if (this.at('[')) return this.array(mutation);
		if (this.at('{')) return this.object(mutation);
		if (this.eat('new')) {
			if (!this.at('Error')) {
				if (['Map', 'Set', 'Date'].includes(this.peek().raw)) this.fail('COLLECTION');
				const code = this.forbidden(String(this.peek().value));
				this.fail(code ?? 'NEW');
			}
			const callee = this.identifier();
			if (this.at('<')) this.fail('TYPE_ARGUMENTS');
			if (!this.at('(')) this.fail('NEW', t);
			this.continuation(boundary);
			const args = this.arguments();
			return this.node(t, { type: 'NewExpression', callee, arguments: args });
		}
		if (this.at('function') || (this.at('async') && this.peek(1).raw === 'function' && !this.peek(1).lineBreakBefore)) {
			if ((this.at('function') && this.peek(1).raw === '*') || (this.at('async') && this.peek(2).raw === '*')) this.fail('GENERATOR');
			this.fail('FUNCTION_EXPRESSION');
		}
		if (this.at('/') || this.at('/=')) this.fail('REGEXP');
		if (this.at('if')) this.fail('AISCRIPT_IF');
		if (this.at('@')) this.fail('AISCRIPT_FUNCTION');
		if (this.at('match') && this.matchAhead()) this.fail('AISCRIPT_MATCH');
		if (this.at('each') && this.peek(1).raw === 'let' && !this.peek(1).lineBreakBefore) this.fail('AISCRIPT_EACH');
		if (this.at('eval') && this.peek(1).raw === '{') this.fail('AISCRIPT_EVAL');
		if (this.at('<')) this.fail(this.peek(1).raw === ':' ? 'AISCRIPT_OUTPUT' : 'TYPE_ARGUMENTS');
		if (t.kind === 'identifier') {
			const code = this.forbidden(String(t.value));
			if (code) this.fail(code);
			if (['Map', 'Set'].includes(String(t.value))) this.fail('COLLECTION');
			const id = this.identifier();
			if (id.name === 'Date' && this.at('(')) this.fail('COLLECTION', id);
			return id;
		}
		this.fail('UNEXPECTED_TOKEN');
	}
	private suffix(initial: A.Expression, boundary: boolean, start: Token): A.Expression {
		let expression = initial;
		let chain = false;
		if (initial.type === 'ArrowFunctionExpression' && !this.parenthesized.has(initial)) return initial;
		while (true) {
			if (this.at('(') || this.at('[') || this.peek().kind === 'template' || this.peek().kind === 'templateHead') this.continuation(boundary);
			if (this.peek().kind === 'template' || this.peek().kind === 'templateHead') this.fail('TAGGED_TEMPLATE');
			if (this.at('<') && this.typeArgumentsAhead()) this.fail('TYPE_ARGUMENTS');
			let optional = false;
			if (this.eat('?.')) { optional = true; chain = true; }
			if (this.at('(')) {
				const callee = expression.type === 'ChainExpression' ? expression.expression : expression;
				if (callee.type === 'Identifier' && callee.name === 'Date') this.fail('COLLECTION', callee);
				if (callee.type === 'MemberExpression' && ((callee.property.type === 'Identifier' && !callee.computed && callee.property.name === 'then') || (callee.computed && callee.property.type === 'Literal' && callee.property.value === 'then'))) this.fail('PROMISE', callee.property);
				const args = this.arguments();
				expression = this.node(start, { type: 'CallExpression', callee: expression, arguments: args, optional });
			} else if (this.eat('[')) {
				const property = this.expression();
				this.expect(']');
				expression = this.node(start, { type: 'MemberExpression', object: expression, property, computed: true, optional });
			} else if (optional || this.eat('.')) {
				const property = this.identifier(true);
				expression = this.node(start, { type: 'MemberExpression', object: expression, property, computed: false, optional });
			} else break;
		}
		if (chain) {
			if (expression.type !== 'MemberExpression' && expression.type !== 'CallExpression') this.fail('UNEXPECTED_TOKEN', expression);
			return this.node(start, { type: 'ChainExpression', expression });
		}
		return expression;
	}
	private typeArgumentsAhead(): boolean {
		if (this.failedTypeArguments.has(this.index)) return false;
		const closing = [{ raw: '>', index: this.index }];
		const reject = (): false => {
			// 未完の型引数列は、内側の < から再び末尾まで先読みしません。
			this.failedTypeArguments.add(this.index);
			for (const token of closing) if (token.raw === '>') this.failedTypeArguments.add(token.index);
			return false;
		};
		let atom = false;
		let conditional = 0;
		let conditionalColon = 0;
		for (let i = 1; ; i++) {
			const token = this.lookahead(i);
			if (!token || token.kind === 'eof' || token.kind.startsWith('template')) return reject();
			const raw = token.raw;
			if (raw === '>' || raw === '>>' || raw === '>>>') {
				if (!atom) return reject();
				for (let n = 0; n < raw.length; n++) {
					if (closing.at(-1)?.raw !== '>') return reject();
					closing.pop();
					if (!closing.length) return n === raw.length - 1 && this.lookahead(i + 1)?.raw === '(';
				}
				continue;
			}
			if (raw === 'extends') {
				if (!atom) return reject();
				conditional++; atom = false;
				continue;
			}
			if (token.kind === 'identifier' || token.kind === 'number' || token.kind === 'string') {
				if (atom || (token.kind === 'identifier' && reserved.has(String(token.value)) && !['void', 'null', 'true', 'false', 'typeof', 'this', 'new'].includes(raw))) return reject();
				atom = !['typeof', 'keyof', 'readonly', 'new'].includes(raw);
				continue;
			}
			if (raw === '<') {
				if (!atom || this.failedTypeArguments.has(this.index + i)) return reject();
				closing.push({ raw: '>', index: this.index + i }); atom = false;
			} else if (raw === '(' || raw === '{' || raw === '[') {
				if (atom && raw !== '[') return reject();
				closing.push({ raw: raw === '(' ? ')' : raw === '{' ? '}' : ']', index: this.index + i }); atom = false;
			} else if (raw === ')' || raw === '}' || raw === ']') {
				if (closing.at(-1)?.raw !== raw) return reject();
				closing.pop(); atom = true;
			} else if (raw === '?') {
				if (conditional) { conditional--; conditionalColon++; }
				else if (!['}', ']', ')'].includes(closing.at(-1)!.raw)) return reject();
				atom = false;
			} else if (raw === '...') {
				if (atom || closing.at(-1)?.raw !== ']') return reject();
			} else if (['|', '&', ',', ':', ';', '.', '=>'].includes(raw)) {
				if (raw === ':' && conditionalColon) conditionalColon--;
				else if ([':', ';'].includes(raw) && !closing.some(c => c.raw === '}' || c.raw === ')')) return reject();
				atom = false;
			} else return reject();
		}
	}

	private arguments(): (A.Expression | A.SpreadElement)[] {
		this.expect('(');
		const args: (A.Expression | A.SpreadElement)[] = [];
		while (!this.at(')')) {
			if (this.at('...')) {
				const start = this.take();
				args.push(this.node(start, { type: 'SpreadElement', argument: this.expression() }));
			} else args.push(this.expression());
			if (!this.eat(',')) break;
		}
		this.expect(')');
		return args;
	}
	private literal(): A.Literal {
		const t = this.take();
		const value = t.raw === 'null' ? null : t.raw === 'true' ? true : t.raw === 'false' ? false : t.value;
		return this.node(t, { type: 'Literal', value, raw: t.raw });
	}
	private template(): A.TemplateLiteral {
		const start = this.peek();
		const expressions: A.Expression[] = [];
		const quasis: A.TemplateElement[] = [];
		while (true) {
			const token = this.take();
			const tail = token.kind === 'template' || token.kind === 'templateTail';
			const raw = token.raw.slice(1, tail ? -1 : -2).replace(/\r\n?/g, '\n');
			quasis.push(this.node(token, { type: 'TemplateElement', value: { raw, cooked: String(token.value) }, tail }));
			if (tail) break;
			expressions.push(this.expression());
			if (this.peek().kind !== 'templateMiddle' && this.peek().kind !== 'templateTail') this.fail('UNEXPECTED_TOKEN');
		}
		return this.node(start, { type: 'TemplateLiteral', expressions, quasis });
	}
	private array(mutation: boolean): A.ArrayExpression {
		const start = this.expect('[');
		const elements: (A.Expression | A.SpreadElement | null)[] = [];
		while (!this.at(']')) {
			if (this.eat(',')) { elements.push(null); continue; }
			if (this.at('...')) {
				const t = this.take();
				elements.push(this.node(t, { type: 'SpreadElement', argument: this.expression(0, mutation, false, true, mutation) }));
			} else elements.push(this.expression(0, mutation, false, true, mutation));
			if (!this.eat(',')) break;
		}
		const comma = this.previous?.raw === ',';
		this.expect(']');
		const array = this.node(start, { type: 'ArrayExpression', elements });
		if (comma) this.trailingComma.add(array);
		return array;
	}
	private propertyKey(): { key: A.Expression; computed: boolean } {
		if (this.eat('[')) {
			const key = this.expression();
			this.expect(']');
			return { key, computed: true };
		}
		return { key: this.peek().kind === 'number' || this.peek().kind === 'string' ? this.literal() : this.identifier(true), computed: false };
	}
	private object(mutation: boolean): A.ObjectExpression {
		const start = this.expect('{');
		const properties: (A.Property | A.SpreadElement)[] = [];
		while (!this.at('}')) {
			const t = this.peek();
			if (this.eat('...')) properties.push(this.node(t, { type: 'SpreadElement', argument: this.expression() }));
			else {
				if (this.at('*') || (this.at('async') && this.peek(1).raw === '*')) this.fail('GENERATOR');
				const { key, computed } = this.propertyKey();
				if (key.type === 'Identifier' && ['get', 'set'].includes(key.name) && (this.peek().kind === 'identifier' || this.peek().kind === 'string' || this.peek().kind === 'number' || this.at('['))) this.fail('ACCESSOR', t);
				if (this.at('(') || (key.type === 'Identifier' && key.name === 'async' && (this.peek().kind === 'identifier' || this.peek().kind === 'string' || this.peek().kind === 'number' || this.at('[')))) this.fail('METHOD_SHORTHAND', t);
				if (this.at('<')) this.fail('TYPE_ARGUMENTS');
				const shorthand = !this.eat(':');
				let value: A.Expression | A.Pattern;
				if (shorthand) {
					if (key.type !== 'Identifier' || computed || reserved.has(key.name)) this.fail('UNEXPECTED_TOKEN', t);
					if (this.forbidden(key.name)) this.fail(this.forbidden(key.name)!, t);
					value = { ...key, loc: { ...key.loc } };
					if (mutation && this.eat('=')) value = this.node(key, { type: 'AssignmentPattern', left: value, right: this.expression() });
				} else value = this.expression(0, mutation, false, true, mutation);
				properties.push(this.node(t, { type: 'Property', key, value, shorthand, computed, kind: 'init', method: false }));
			}
			if (!this.eat(',')) break;
		}
		const comma = this.previous?.raw === ',';
		this.expect('}');
		const object = this.node(start, { type: 'ObjectExpression', properties });
		if (comma) this.trailingComma.add(object);
		return object;
	}
	// 分割代入の左辺が確定するまでは、既定値と式中の代入を区別できません。
	private checkExpression(node: A.Node, root = false): void {
		if (node.type === 'ArrowFunctionExpression') return;
		if (node.type === 'AssignmentPattern') this.fail('ASSIGNMENT_IN_EXPRESSION', node);
		if (node.type === 'AssignmentExpression') {
			if (!root) this.fail('ASSIGNMENT_IN_EXPRESSION', node);
			this.checkExpression(node.right);
			return;
		}
		if (node.type === 'UpdateExpression') {
			if (!root) this.fail('UPDATE_IN_EXPRESSION', node);
			return;
		}
		if (node.type === 'ObjectExpression') {
			let proto = false;
			for (const property of node.properties) {
				if (property.type === 'Property' && !property.computed && !property.shorthand && ((property.key.type === 'Identifier' && property.key.name === '__proto__') || (property.key.type === 'Literal' && property.key.value === '__proto__'))) {
					if (proto) this.fail('UNEXPECTED_TOKEN', property);
					proto = true;
				}
			}
		}
		for (const [key, value] of Object.entries(node)) {
			if (key === 'loc' || key === 'typeAnnotation') continue;
			if (Array.isArray(value)) {
				for (const child of value) if (child && typeof child === 'object' && 'type' in child) this.checkExpression(child as A.Node);
			} else if (value && typeof value === 'object' && 'type' in value) this.checkExpression(value as A.Node);
		}
	}

	private assignmentTarget(expression: A.Expression, destructure: boolean): A.Pattern | A.MemberExpression {
		if (expression.type === 'Identifier') return expression;
		if (expression.type === 'MemberExpression' && !expression.optional) return expression;
		if (destructure && !this.parenthesized.has(expression)) {
			if (expression.type === 'ArrayExpression') {
				const elements = expression.elements.map((item, i): A.Pattern | A.MemberExpression | null => {
					if (!item) return null;
					if (item.type === 'SpreadElement') {
						if (i !== expression.elements.length - 1 || this.trailingComma.has(expression) || item.argument.type === 'AssignmentExpression') this.fail('INVALID_ASSIGNMENT_TARGET', item);
						return { type: 'RestElement', argument: this.assignmentPattern(item.argument), loc: item.loc };
					}
					return this.assignmentPattern(item);
				});
				return { type: 'ArrayPattern', elements, loc: expression.loc };
			}
			if (expression.type === 'ObjectExpression') {
				const properties = expression.properties.map((p, i): A.Property | A.RestElement => {
					if (p.type === 'SpreadElement') {
						if (i !== expression.properties.length - 1 || this.trailingComma.has(expression)) this.fail('INVALID_ASSIGNMENT_TARGET', p);
						const argument = this.assignmentTarget(p.argument, false);
						return { type: 'RestElement', argument, loc: p.loc };
					}
					return { ...p, value: p.value.type === 'AssignmentPattern' ? p.value : this.assignmentPattern(p.value as A.Expression) };
				});
				return { type: 'ObjectPattern', properties, loc: expression.loc };
			}
		}
		this.fail('INVALID_ASSIGNMENT_TARGET', expression);
	}
	private assignmentPattern(expression: A.Expression): A.Pattern | A.MemberExpression {
		if (expression.type === 'AssignmentExpression' && this.parenthesized.has(expression)) this.fail('INVALID_ASSIGNMENT_TARGET', expression);
		if (expression.type === 'AssignmentExpression' && expression.operator === '=') return { type: 'AssignmentPattern', left: expression.left, right: expression.right, loc: expression.loc };
		const pattern = this.assignmentTarget(expression, true);
		return pattern;
	}
}
