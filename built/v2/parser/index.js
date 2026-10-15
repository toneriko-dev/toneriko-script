import { TonerikoScriptSyntaxError, syntaxError } from "../diagnostics.js";
import { recordTypeAnnotations } from "../type-metadata.js";
import { checkEarlyErrors } from "./early-errors.js";
import { Scanner } from "./scanner.js";

//#region src/v2/parser/index.ts
const MAX_SYNTAX_DEPTH = 256;
const MAX_PARSER_DEPTH = 4096;
const assignments = /* @__PURE__ */ new Set([
	"=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"**=",
	"??="
]);
const bitwise = /* @__PURE__ */ new Set([
	"&",
	"|",
	"^",
	"~",
	"<<",
	">>",
	">>>",
	"&=",
	"|=",
	"^=",
	"<<=",
	">>=",
	">>>="
]);
const precedence = {
	"??": 1,
	"||": 1,
	"&&": 2,
	"==": 3,
	"!=": 3,
	"===": 3,
	"!==": 3,
	"<": 4,
	"<=": 4,
	">": 4,
	">=": 4,
	in: 4,
	"+": 5,
	"-": 5,
	"*": 6,
	"/": 6,
	"%": 6,
	"**": 7
};
const reserved = /* @__PURE__ */ new Set([
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"import",
	"in",
	"instanceof",
	"let",
	"new",
	"null",
	"return",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"yield",
	"await",
	"implements",
	"interface",
	"package",
	"private",
	"protected",
	"public",
	"static"
]);
const forbidden = {
	class: "CLASS",
	this: "THIS",
	var: "VAR",
	eval: "EVAL",
	Function: "FUNCTION_CONSTRUCTOR",
	with: "WITH",
	Symbol: "SYMBOL",
	BigInt: "BIGINT",
	arguments: "ARGUMENTS",
	debugger: "DEBUGGER",
	import: "IMPORT",
	Promise: "PROMISE",
	undefined: "UNDEFINED",
	super: "SUPER",
	yield: "YIELD",
	interface: "TYPE_INTERFACE",
	enum: "TYPE_ENUM"
};
function parse(source) {
	const parser = new Parser(source);
	try {
		const program = parser.program();
		checkEarlyErrors(program);
		return {
			program,
			warnings: []
		};
	} catch (error) {
		if (isStackOverflow(error)) throw syntaxError("NESTING_TOO_DEEP", parser.position());
		throw error;
	}
}
function isStackOverflow(error) {
	if (!(error instanceof Error) || error.name !== "RangeError" && error.name !== "InternalError") return false;
	const message = error.message.toLowerCase();
	return message.includes("stack") || message.includes("recursion");
}
var Parser = class {
	scanner;
	tokens = [];
	index = 0;
	syntaxDepth = 0;
	parserDepth = 0;
	previous;
	lexicalError;
	typeAnnotationCount = 0;
	functionDepth = 0;
	loopDepth = 0;
	switchDepth = 0;
	labels = /* @__PURE__ */ new Map();
	parenthesized = /* @__PURE__ */ new WeakSet();
	checkedExpressions = /* @__PURE__ */ new Set();
	trailingComma = /* @__PURE__ */ new WeakSet();
	failedTypeArguments = /* @__PURE__ */ new Set();
	parenthesisEnds = /* @__PURE__ */ new Map();
	arrowLookaheads = /* @__PURE__ */ new Map();
	parameterLists = /* @__PURE__ */ new Map();
	arrows = /* @__PURE__ */ new Map();
	constructor(source) {
		this.scanner = new Scanner(source);
	}
	forbidden(name) {
		return Object.hasOwn(forbidden, name) ? forbidden[name] : void 0;
	}
	peek(offset = 0) {
		while (this.tokens.length <= this.index + offset) {
			if (this.lexicalError) throw this.lexicalError;
			try {
				this.tokens.push(this.scanner.next());
			} catch (error) {
				this.lexicalError = error;
				throw error;
			}
		}
		return this.tokens[this.index + offset];
	}
	at(value) {
		return this.peek().raw === value;
	}
	take() {
		const token = this.peek();
		this.index++;
		this.previous = token;
		return token;
	}
	eat(value) {
		if (!this.at(value)) return false;
		this.take();
		return true;
	}
	fail(code, token = this.peek(), params = {}) {
		throw syntaxError(code, token.loc.start, params);
	}
	expect(value) {
		if (!this.at(value) && this.at(":")) this.fail("AISCRIPT_NAMESPACE");
		if (!this.at(value)) this.fail("UNEXPECTED_TOKEN", this.peek(), {
			expected: value,
			actual: this.peek().raw
		});
		return this.take();
	}
	position() {
		return this.previous?.loc.end ?? {
			line: 1,
			column: 1
		};
	}
	enterParser() {
		if (this.parserDepth >= MAX_PARSER_DEPTH) this.fail("NESTING_TOO_DEEP");
		this.parserDepth++;
	}
	enterSyntax() {
		if (this.syntaxDepth >= MAX_SYNTAX_DEPTH) this.fail("NESTING_TOO_DEEP");
		this.syntaxDepth++;
	}
	nested(read) {
		this.enterParser();
		try {
			this.enterSyntax();
			try {
				return read();
			} finally {
				this.syntaxDepth--;
			}
		} finally {
			this.parserDepth--;
		}
	}
	node(start, fields) {
		return {
			...fields,
			loc: {
				start: start.loc.start,
				end: this.previous?.loc.end ?? start.loc.end
			}
		};
	}
	identifier(property = false) {
		const t = this.peek();
		if (t.kind !== "identifier" || !property && reserved.has(String(t.value))) this.fail("UNEXPECTED_TOKEN");
		this.take();
		return this.node(t, {
			type: "Identifier",
			name: String(t.value)
		});
	}
	endStatement() {
		if (this.eat(";") || this.at("}") || this.peek().kind === "eof" || this.peek().lineBreakBefore) return;
		if (this.at(",")) this.fail("COMMA_OPERATOR");
		if (this.at(":")) this.fail("AISCRIPT_NAMESPACE");
		this.fail("UNEXPECTED_TOKEN", this.peek(), {
			expected: ";",
			actual: this.peek().raw
		});
	}
	continuation(boundary) {
		if (boundary && this.peek().lineBreakBefore && [
			"(",
			"[",
			"`",
			"+",
			"-",
			"/"
		].some((x) => this.peek().raw.startsWith(x))) this.fail("NEWLINE_CONTINUATION");
	}
	program() {
		const body = [];
		while (this.peek().kind !== "eof") body.push(this.statement(true));
		const program = {
			type: "Program",
			sourceType: "module",
			body,
			loc: {
				start: {
					line: 1,
					column: 1
				},
				end: this.peek().loc.end
			}
		};
		recordTypeAnnotations(program, this.typeAnnotationCount > 0);
		return program;
	}
	statement(topLevel = false, single = false) {
		this.enterParser();
		try {
			const t = this.peek();
			const word = String(t.value);
			if (this.eat(";")) return this.node(t, { type: "EmptyStatement" });
			if (this.at("{")) return this.block();
			if (this.at("const") || this.at("let")) {
				if (single) this.fail("UNEXPECTED_TOKEN");
				const declaration = this.variables(false);
				this.endStatement();
				declaration.loc.end = this.previous.loc.end;
				return declaration;
			}
			if (this.at("function") || this.at("async") && this.peek(1).raw === "function" && !this.peek(1).lineBreakBefore) {
				if (single) this.fail("UNEXPECTED_TOKEN");
				return this.functionDeclaration();
			}
			switch (t.raw) {
				case "if": return this.ifStatement();
				case "for": return this.forStatement();
				case "while": {
					this.take();
					const test = this.condition();
					const body = this.loopBody();
					return this.node(t, {
						type: "WhileStatement",
						test,
						body
					});
				}
				case "do": {
					this.take();
					const body = this.loopBody();
					this.expect("while");
					const test = this.condition();
					this.eat(";");
					return this.node(t, {
						type: "DoWhileStatement",
						body,
						test
					});
				}
				case "return": {
					this.take();
					const newline = this.peek().lineBreakBefore;
					if (newline && this.expressionStart()) this.fail("NEWLINE_RETURN", t);
					if (!this.functionDepth) this.fail("INVALID_CONTROL_FLOW", t);
					const argument = newline || this.at(";") || this.at("}") || this.peek().kind === "eof" ? null : this.expression(0, false, true);
					this.endStatement();
					return this.node(t, {
						type: "ReturnStatement",
						argument
					});
				}
				case "break":
				case "continue": {
					this.take();
					const label = !this.peek().lineBreakBefore && this.peek().kind === "identifier" ? this.identifier() : null;
					if (label ? !this.labels.has(label.name) || t.raw === "continue" && !this.labels.get(label.name) : !(this.loopDepth || t.raw === "break" && this.switchDepth)) this.fail("INVALID_CONTROL_FLOW", t);
					this.endStatement();
					return this.node(t, {
						type: t.raw === "break" ? "BreakStatement" : "ContinueStatement",
						label
					});
				}
				case "switch": return this.switchStatement();
				case "try": return this.tryStatement();
				case "throw": {
					this.take();
					if (this.peek().lineBreakBefore) this.fail("NEWLINE_THROW", t);
					const argument = this.expression(0, false, true);
					this.endStatement();
					return this.node(t, {
						type: "ThrowStatement",
						argument
					});
				}
				case "export": {
					this.take();
					if (!topLevel || !this.at("const")) this.fail("INVALID_META", t);
					const declaration = this.variables(false);
					const d = declaration.declarations[0];
					if (declaration.declarations.length !== 1 || d?.id.type !== "Identifier" || d.id.name !== "meta" || d.id.typeAnnotation || d.init?.type !== "ObjectExpression" || !this.literalMeta(d.init)) this.fail("INVALID_META", t);
					this.endStatement();
					declaration.loc.end = this.previous.loc.end;
					return this.node(t, {
						type: "ExportMetaDeclaration",
						declaration
					});
				}
				case "each":
					if (this.peek(1).raw === "let" && !this.peek(1).lineBreakBefore) this.fail("AISCRIPT_EACH");
					break;
				case "match":
					if (this.matchAhead()) this.fail("AISCRIPT_MATCH");
					break;
				case "@": this.fail("AISCRIPT_FUNCTION");
				case "#": if (this.peek(1).raw === "#" && this.peek(2).raw === "#") this.fail("AISCRIPT_META");
			}
			if (this.at("<") && this.peek(1).raw === ":") this.fail("AISCRIPT_OUTPUT");
			if (this.at("eval") && this.peek(1).raw === "{") this.fail("AISCRIPT_EVAL");
			if (this.at("type") && this.peek(1).kind === "identifier" && !this.peek(1).lineBreakBefore && !reserved.has(String(this.peek(1).value))) this.fail("TYPE_ALIAS");
			if (t.kind === "identifier" && this.forbidden(word)) this.fail(this.forbidden(word), t);
			if (t.kind === "identifier" && this.peek(1).raw === ":") {
				const label = this.identifier();
				this.expect(":");
				let offset = 0;
				while (this.peek(offset).kind === "identifier" && this.peek(offset + 1).raw === ":") offset += 2;
				const target = this.peek(offset).raw;
				if (target === "function" || target === "async" && this.peek(offset + 1).raw === "function") this.fail("LABELED_FUNCTION", t);
				if (![
					"for",
					"while",
					"do",
					"{"
				].includes(target)) this.fail(this.peek(offset).kind === "identifier" && !reserved.has(String(this.peek(offset).value)) ? "AISCRIPT_NAMESPACE" : "INVALID_LABEL", t);
				if (this.labels.has(label.name)) this.fail("INVALID_LABEL", t);
				this.labels.set(label.name, target !== "{");
				const body = this.nested(() => this.statement());
				this.labels.delete(label.name);
				return this.node(t, {
					type: "LabeledStatement",
					label,
					body
				});
			}
			if (t.kind === "identifier" && this.forbidden(word)) this.fail(this.forbidden(word), t);
			const expression = this.expression(0, true, true);
			this.endStatement();
			return this.node(t, {
				type: "ExpressionStatement",
				expression
			});
		} finally {
			this.parserDepth--;
		}
	}
	ifStatement() {
		this.enterParser();
		try {
			const branches = [];
			let alternate = null;
			do {
				const start = this.expect("if");
				if (!this.at("(")) this.fail("AISCRIPT_IF", start);
				const test = this.condition();
				const consequent = this.nested(() => this.statement(false, true));
				branches.push({
					start,
					test,
					consequent
				});
				if (!this.eat("else")) break;
				if (!this.at("if")) {
					alternate = this.nested(() => this.statement(false, true));
					break;
				}
			} while (true);
			for (let i = branches.length - 1; i >= 0; i--) {
				const { start, test, consequent } = branches[i];
				alternate = this.node(start, {
					type: "IfStatement",
					test,
					consequent,
					alternate
				});
			}
			return alternate;
		} finally {
			this.parserDepth--;
		}
	}
	block(nested = true) {
		this.enterParser();
		try {
			if (nested) this.enterSyntax();
			try {
				const t = this.expect("{");
				const body = [];
				while (!this.at("}")) {
					if (this.peek().kind === "eof") this.fail("UNEXPECTED_TOKEN");
					body.push(this.statement());
				}
				this.take();
				return this.node(t, {
					type: "BlockStatement",
					body
				});
			} finally {
				if (nested) this.syntaxDepth--;
			}
		} finally {
			this.parserDepth--;
		}
	}
	condition() {
		this.enterParser();
		try {
			this.expect("(");
			const expression = this.expression();
			if (this.at(",")) this.fail("COMMA_OPERATOR");
			this.expect(")");
			return expression;
		} finally {
			this.parserDepth--;
		}
	}
	loopBody() {
		this.enterParser();
		try {
			this.loopDepth++;
			const body = this.nested(() => this.statement(false, true));
			this.loopDepth--;
			return body;
		} finally {
			this.parserDepth--;
		}
	}
	variables(inFor) {
		this.enterParser();
		try {
			const t = this.take();
			const kind = t.raw;
			const declarations = [];
			do {
				const start = this.peek();
				const id = this.binding(false);
				if (this.at("!") && !this.peek().lineBreakBefore) this.fail("TYPE_DEFINITE_ASSIGNMENT");
				const init = this.eat("=") ? this.expression(0, false, !inFor, !inFor) : null;
				if (!init && (!inFor || !this.at("of") && !this.at("in")) && (kind === "const" || id.type !== "Identifier")) this.fail("UNEXPECTED_TOKEN", start);
				declarations.push(this.node(start, {
					type: "VariableDeclarator",
					id,
					init
				}));
			} while (this.eat(","));
			return this.node(t, {
				type: "VariableDeclaration",
				kind,
				declarations
			});
		} finally {
			this.parserDepth--;
		}
	}
	forStatement() {
		this.enterParser();
		try {
			const t = this.take();
			if (!this.at("(")) this.fail("AISCRIPT_FOR", t);
			this.take();
			let init = null;
			if (!this.at(";")) init = this.at("const") || this.at("let") ? this.variables(true) : this.expression(0, true, false, false, true);
			if (this.at("in")) this.fail("FOR_IN");
			if (this.eat("of")) {
				if (!init) this.fail("INVALID_ASSIGNMENT_TARGET", t);
				let left;
				if (init.type === "VariableDeclaration") {
					if (init.declarations.length !== 1 || init.declarations[0].init) this.fail("INVALID_ASSIGNMENT_TARGET", init);
					left = init;
				} else {
					if (init.type === "Identifier" && init.name === "async" && !this.parenthesized.has(init)) this.fail("UNEXPECTED_TOKEN", init);
					left = this.assignmentTarget(init, true);
				}
				const right = this.expression();
				this.expect(")");
				const body = this.loopBody();
				return this.node(t, {
					type: "ForOfStatement",
					left,
					right,
					body,
					await: false
				});
			}
			if (init && init.type !== "VariableDeclaration") {
				if (init.type === "UpdateExpression") this.fail("UPDATE_IN_EXPRESSION", init);
				this.checkExpression(init, true);
			}
			if (init?.type === "VariableDeclaration" && init.declarations.some((d) => !d.init && (init.kind === "const" || d.id.type !== "Identifier"))) this.fail("UNEXPECTED_TOKEN", init);
			if (this.at(",")) this.fail("COMMA_OPERATOR");
			this.expect(";");
			const test = this.at(";") ? null : this.expression();
			this.expect(";");
			const update = this.at(")") ? null : this.expression(0, true);
			if (this.at(",")) this.fail("COMMA_OPERATOR");
			this.expect(")");
			const body = this.loopBody();
			return this.node(t, {
				type: "ForStatement",
				init,
				test,
				update,
				body
			});
		} finally {
			this.parserDepth--;
		}
	}
	switchStatement() {
		this.enterParser();
		try {
			this.enterSyntax();
			try {
				const t = this.take();
				const discriminant = this.condition();
				this.expect("{");
				const cases = [];
				let hasDefault = false;
				this.switchDepth++;
				while (!this.at("}")) {
					const start = this.peek();
					let test;
					if (this.eat("case")) test = this.expression(0, false, false, true, false, false);
					else {
						this.expect("default");
						if (hasDefault) this.fail("UNEXPECTED_TOKEN", start);
						hasDefault = true;
						test = null;
					}
					if (test && this.undefinedText(test)) this.fail("TYPEOF_UNDEFINED_COMPARISON", test);
					this.expect(":");
					const consequent = [];
					while (!this.at("case") && !this.at("default") && !this.at("}")) consequent.push(this.statement());
					cases.push(this.node(start, {
						type: "SwitchCase",
						test,
						consequent
					}));
				}
				this.take();
				this.switchDepth--;
				return this.node(t, {
					type: "SwitchStatement",
					discriminant,
					cases
				});
			} finally {
				this.syntaxDepth--;
			}
		} finally {
			this.parserDepth--;
		}
	}
	tryStatement() {
		this.enterParser();
		try {
			const t = this.take();
			const block = this.block();
			let handler = null;
			if (this.at("catch")) {
				const start = this.take();
				let param = null;
				if (this.eat("(")) {
					param = this.binding(false);
					this.expect(")");
				}
				const body = this.block();
				handler = this.node(start, {
					type: "CatchClause",
					param,
					body
				});
			}
			const finalizer = this.eat("finally") ? this.block() : null;
			if (!handler && !finalizer) this.fail("UNEXPECTED_TOKEN");
			return this.node(t, {
				type: "TryStatement",
				block,
				handler,
				finalizer
			});
		} finally {
			this.parserDepth--;
		}
	}
	literalMeta(expression) {
		this.enterParser();
		try {
			if (expression.type === "Literal") return true;
			if (expression.type === "UnaryExpression") return expression.operator === "-" && expression.argument.type === "Literal" && typeof expression.argument.value === "number";
			if (expression.type === "ArrayExpression") return expression.elements.every((e) => e !== null && e.type !== "SpreadElement" && this.literalMeta(e));
			if (expression.type === "ObjectExpression") return expression.properties.every((p) => p.type === "Property" && !p.computed && !p.shorthand && this.literalMeta(p.value));
			return false;
		} finally {
			this.parserDepth--;
		}
	}
	binding(defaultValue, parameter = false, allowRest = false, annotation = "allow") {
		this.enterParser();
		try {
			const nested = this.at("[") || this.at("{");
			if (nested) this.enterSyntax();
			try {
				const start = this.peek();
				let pattern;
				if (this.eat("...")) {
					if (!allowRest) this.fail("UNEXPECTED_TOKEN", start);
					const argument = this.binding(false, false, false, "rest");
					pattern = this.node(start, {
						type: "RestElement",
						argument
					});
				} else if (this.eat("[")) {
					const elements = [];
					while (!this.at("]")) {
						if (this.eat(",")) {
							elements.push(null);
							continue;
						}
						const item = this.binding(true, false, true, "forbid");
						elements.push(item);
						if (item.type === "RestElement") {
							if (this.at(",")) this.fail("UNEXPECTED_TOKEN");
							break;
						}
						if (!this.eat(",")) break;
					}
					this.expect("]");
					pattern = this.node(start, {
						type: "ArrayPattern",
						elements
					});
				} else if (this.eat("{")) {
					const properties = [];
					while (!this.at("}")) {
						if (this.at("...")) {
							const rest = this.binding(false, false, true, "forbid");
							if (rest.type !== "RestElement" || rest.argument.type !== "Identifier") this.fail("INVALID_ASSIGNMENT_TARGET", rest);
							properties.push(rest);
							if (this.at(",")) this.fail("UNEXPECTED_TOKEN");
							break;
						}
						const propertyStart = this.peek();
						const { key, computed } = this.propertyKey();
						const shorthand = !this.eat(":");
						let value;
						if (shorthand) {
							if (key.type !== "Identifier" || computed || reserved.has(key.name)) this.fail("UNEXPECTED_TOKEN", key);
							value = {
								...key,
								loc: { ...key.loc }
							};
							if (this.eat("=")) value = this.node(key, {
								type: "AssignmentPattern",
								left: value,
								right: this.expression()
							});
						} else value = this.binding(true, false, false, "forbid");
						properties.push(this.node(propertyStart, {
							type: "Property",
							key,
							value,
							kind: "init",
							method: false,
							shorthand,
							computed
						}));
						if (!this.eat(",")) break;
					}
					this.expect("}");
					pattern = this.node(start, {
						type: "ObjectPattern",
						properties
					});
				} else pattern = this.identifier();
				if (parameter && this.eat("?")) {
					if (pattern.type !== "Identifier") this.fail("UNEXPECTED_TOKEN", start);
					pattern.optional = true;
				}
				if (annotation === "forbid" && this.at(":")) this.fail("UNEXPECTED_TOKEN");
				if (annotation === "allow" && this.eat(":")) pattern.typeAnnotation = this.checkedTypeAnnotation();
				pattern.loc.end = this.previous.loc.end;
				if (defaultValue && this.eat("=")) {
					if (pattern.type === "RestElement" || "optional" in pattern && pattern.optional) this.fail("UNEXPECTED_TOKEN", start);
					pattern = this.node(start, {
						type: "AssignmentPattern",
						left: pattern,
						right: this.expression()
					});
				}
				return pattern;
			} finally {
				if (nested) this.syntaxDepth--;
			}
		} finally {
			this.parserDepth--;
		}
	}
	parameters() {
		this.enterParser();
		try {
			const start = this.index;
			const cached = this.parameterLists.get(start);
			if (cached) {
				if ("error" in cached) throw cached.error;
				this.index = cached.end;
				this.previous = this.tokens[this.index - 1];
				this.typeAnnotationCount += cached.annotations;
				return cached.params;
			}
			const annotations = this.typeAnnotationCount;
			try {
				this.expect("(");
				const params = [];
				while (!this.at(")")) {
					if (this.at("this")) this.fail("TYPE_THIS_PARAMETER");
					const param = this.binding(true, true, true);
					params.push(param);
					if (param.type === "RestElement") {
						if (this.at(",")) this.fail("UNEXPECTED_TOKEN");
						break;
					}
					if (!this.eat(",")) break;
				}
				this.expect(")");
				this.parameterLists.set(start, {
					params,
					end: this.index,
					annotations: this.typeAnnotationCount - annotations
				});
				return params;
			} catch (error) {
				this.parameterLists.set(start, { error });
				throw error;
			}
		} finally {
			this.parserDepth--;
		}
	}
	functionBody() {
		this.enterParser();
		try {
			const saved = {
				loop: this.loopDepth,
				switch: this.switchDepth,
				labels: this.labels
			};
			this.loopDepth = 0;
			this.switchDepth = 0;
			this.labels = /* @__PURE__ */ new Map();
			this.functionDepth++;
			const body = this.block(false);
			this.functionDepth--;
			this.loopDepth = saved.loop;
			this.switchDepth = saved.switch;
			this.labels = saved.labels;
			return body;
		} finally {
			this.parserDepth--;
		}
	}
	functionDeclaration() {
		this.enterParser();
		try {
			this.enterSyntax();
			try {
				const start = this.peek();
				const async = this.eat("async");
				this.expect("function");
				if (this.at("*")) this.fail("GENERATOR");
				const id = this.identifier();
				if (this.at("<")) this.fail("TYPE_ARGUMENTS");
				const params = this.parameters();
				const returnType = this.eat(":") ? this.checkedTypeAnnotation(true) : void 0;
				const body = this.functionBody();
				return this.node(start, {
					type: "FunctionDeclaration",
					id,
					params,
					body,
					async,
					generator: false,
					...returnType ? { returnType } : {}
				});
			} finally {
				this.syntaxDepth--;
			}
		} finally {
			this.parserDepth--;
		}
	}
	checkedTypeAnnotation(returnPosition = false) {
		this.typeAnnotationCount++;
		const annotation = this.typeAnnotation();
		const pending = [{
			node: annotation,
			returns: returnPosition
		}];
		while (pending.length) {
			const { node, returns } = pending.pop();
			switch (node.type) {
				case "KeywordTypeAnnotation":
					if (node.name === "void" && !returns) this.fail("VOID_TYPE_POSITION", node);
					break;
				case "ParenthesizedTypeAnnotation":
					pending.push({
						node: node.typeAnnotation,
						returns
					});
					break;
				case "UnionTypeAnnotation":
					for (const child of node.types) pending.push({
						node: child,
						returns
					});
					break;
				case "ArrayTypeAnnotation":
					pending.push({
						node: node.elementType,
						returns: false
					});
					break;
				case "ObjectTypeAnnotation": for (const property of node.properties) pending.push({
					node: property.typeAnnotation,
					returns: false
				});
			}
		}
		return annotation;
	}
	typeAnnotation() {
		this.enterParser();
		try {
			const start = this.peek();
			const leadingUnion = this.eat("|");
			const types = [this.typeAtom()];
			while (this.eat("|")) types.push(this.typeAtom());
			if (this.at("&")) this.fail("UNSUPPORTED_TYPE");
			return types.length === 1 && !leadingUnion ? types[0] : this.node(start, {
				type: "UnionTypeAnnotation",
				types
			});
		} finally {
			this.parserDepth--;
		}
	}
	typeAtom() {
		this.enterParser();
		try {
			const nested = this.at("{");
			if (nested) this.enterSyntax();
			try {
				const start = this.peek();
				let type;
				if (this.eat("(")) {
					const typeAnnotation = this.nested(() => this.typeAnnotation());
					this.expect(")");
					if (this.at("=>") && typeAnnotation.type === "ObjectTypeAnnotation") this.fail("PARENTHESIZED_ARROW_RETURN_TYPE", start);
					if (this.at("=>") && (typeAnnotation.type === "FunctionTypeAnnotation" || typeAnnotation.type === "KeywordTypeAnnotation" && !["null", "void"].includes(typeAnnotation.name))) this.fail("UNSUPPORTED_TYPE");
					type = this.node(start, {
						type: "ParenthesizedTypeAnnotation",
						typeAnnotation
					});
				} else if (this.eat("{")) {
					const properties = [];
					while (!this.at("}")) {
						const propertyStart = this.peek();
						if (this.at("[")) this.fail("UNSUPPORTED_TYPE");
						const key = this.peek().kind === "string" || this.peek().kind === "number" ? this.literal() : this.identifier(true);
						const optional = this.eat("?");
						this.expect(":");
						const typeAnnotation = this.typeAnnotation();
						properties.push(this.node(propertyStart, {
							type: "TypeProperty",
							key,
							optional,
							typeAnnotation
						}));
						if (!this.eat(";") && !this.eat(",") && !this.at("}") && !this.peek().lineBreakBefore) this.fail("UNEXPECTED_TOKEN");
					}
					this.expect("}");
					type = this.node(start, {
						type: "ObjectTypeAnnotation",
						properties
					});
				} else if ([
					"number",
					"string",
					"boolean",
					"null",
					"any",
					"void"
				].includes(start.raw)) {
					this.take();
					type = this.node(start, {
						type: "KeywordTypeAnnotation",
						name: start.raw
					});
				} else if (this.eat("Function")) type = this.node(start, { type: "FunctionTypeAnnotation" });
				else {
					if (this.at("undefined")) this.fail("UNDEFINED");
					if (this.at("Array")) this.fail("TYPE_ARRAY_GENERIC");
					if (this.at("Record")) this.fail("TYPE_RECORD");
					if (this.at("[")) this.fail("TYPE_TUPLE");
					if (start.kind === "string" || start.kind === "number" || [
						"true",
						"false",
						"-",
						"`"
					].includes(start.raw) || start.kind.startsWith("template")) this.fail("TYPE_LITERAL");
					if (this.at("<")) this.fail("TYPE_ARGUMENTS");
					this.fail("UNSUPPORTED_TYPE");
				}
				while (!this.peek().lineBreakBefore && this.eat("[")) {
					this.expect("]");
					type = this.node(start, {
						type: "ArrayTypeAnnotation",
						elementType: type
					});
				}
				if (this.at("<")) this.fail("TYPE_ARGUMENTS");
				return type;
			} finally {
				if (nested) this.syntaxDepth--;
			}
		} finally {
			this.parserDepth--;
		}
	}
	expression(min = 0, mutation = false, boundary = false, allowIn = true, cover = false, allowReturnType = true, conditional = true) {
		this.enterParser();
		try {
			const start = this.peek();
			let left = this.unary(mutation, boundary, min === 0, allowReturnType, allowIn);
			const operators = [];
			let operandStart = start;
			let powers = 0;
			const reduce = () => {
				const entry = operators.pop();
				const right = left;
				left = entry.left;
				const operator = entry.op.raw;
				if (operator === "**") powers--;
				if (operator === "===" || operator === "!==" || operator === "==" || operator === "!=") {
					if (this.undefinedText(left) || this.undefinedText(right)) this.fail("TYPEOF_UNDEFINED_COMPARISON", entry.op);
				}
				if (operator === "==" || operator === "!=") {
					if (!(left.type === "Literal" && left.value === null) && !(right.type === "Literal" && right.value === null)) this.fail("LOOSE_EQUALITY", entry.op);
				}
				if (operator === "&&" || operator === "||" || operator === "??") {
					for (const operand of [left, right]) if (operand.type === "LogicalExpression" && !this.parenthesized.has(operand) && operand.operator === "??" !== (operator === "??")) this.fail("NULLISH_MIX", entry.op);
					left = this.node(entry.start, {
						type: "LogicalExpression",
						operator,
						left,
						right
					});
				} else left = this.node(entry.start, {
					type: "BinaryExpression",
					operator,
					left,
					right
				});
				operandStart = entry.start;
			};
			while (true) {
				const operator = this.peek().raw;
				if (bitwise.has(operator)) this.fail(operator === "^" ? "AISCRIPT_POWER" : "BITWISE");
				if (operator === "instanceof") this.fail("INSTANCEOF");
				if ((operator === "as" || operator === "satisfies") && !this.peek().lineBreakBefore) this.fail("TYPE_ASSERTION");
				if (operator === "&&=" || operator === "||=") this.fail("LOGICAL_ASSIGNMENT", this.peek(), { operator: operator.slice(0, -1) });
				if (operator === "!" && !this.peek().lineBreakBefore) this.fail("NON_NULL_ASSERTION");
				const priority = Object.hasOwn(precedence, operator) ? precedence[operator] : void 0;
				if (priority === void 0 || priority < min || operator === "in" && !allowIn) break;
				if (left.type === "ArrowFunctionExpression" && !this.parenthesized.has(left)) break;
				while (operators.length && (precedence[operators.at(-1).op.raw] > priority || precedence[operators.at(-1).op.raw] === priority && operator !== "**")) reduce();
				this.continuation(boundary);
				const op = this.take();
				if (left.type === "UpdateExpression") this.fail("UPDATE_IN_EXPRESSION", left);
				if (operator === "**" && (left.type === "UnaryExpression" || left.type === "AwaitExpression") && !this.parenthesized.has(left)) this.fail("UNARY_POWER", op);
				if (operator === "**" && powers++ >= 1024) this.fail("NESTING_TOO_DEEP", op);
				operators.push({
					op,
					left,
					start: operandStart
				});
				operandStart = this.peek();
				left = this.unary(false, boundary, false, allowReturnType, allowIn);
			}
			while (operators.length) reduce();
			if (conditional && min === 0 && this.at("?")) {
				const branches = [];
				let branchStart = start;
				while (this.eat("?")) {
					if (left.type === "ArrowFunctionExpression" && !this.parenthesized.has(left)) this.fail("UNEXPECTED_TOKEN");
					if (left.type === "UpdateExpression") this.fail("UPDATE_IN_EXPRESSION", left);
					const consequent = this.nested(() => this.expression(0, false, false, true, false, false));
					this.expect(":");
					branches.push({
						start: branchStart,
						test: left,
						consequent
					});
					branchStart = this.peek();
					left = this.expression(0, false, boundary, allowIn, false, allowReturnType, false);
				}
				for (let i = branches.length - 1; i >= 0; i--) {
					const branch = branches[i];
					left = this.node(branch.start, {
						type: "ConditionalExpression",
						test: branch.test,
						consequent: branch.consequent,
						alternate: left
					});
				}
			}
			if (min === 0 && assignments.has(this.peek().raw)) {
				const op = this.peek();
				if (!mutation) this.fail("ASSIGNMENT_IN_EXPRESSION", op);
				this.take();
				const target = this.assignmentTarget(left, op.raw === "=");
				const right = this.expression(0, false, boundary, allowIn);
				left = this.node(start, {
					type: "AssignmentExpression",
					operator: op.raw,
					left: target,
					right
				});
			}
			if (!mutation && left.type === "UpdateExpression") this.fail("UPDATE_IN_EXPRESSION", left);
			if (!cover) this.checkExpression(left, true);
			return left;
		} finally {
			this.parserDepth--;
		}
	}
	undefinedText(node) {
		return node.type === "Literal" && node.value === "undefined" || node.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis[0]?.value.cooked === "undefined";
	}
	unary(mutation, boundary, allowArrow, allowReturnType = true, allowIn = true) {
		this.enterParser();
		try {
			const prefixes = [];
			while ([
				"!",
				"-",
				"+",
				"typeof",
				"delete",
				"await"
			].includes(this.peek().raw)) {
				if (prefixes.length >= 1024) this.fail("NESTING_TOO_DEEP");
				prefixes.push(this.take());
				mutation = false;
				allowArrow = false;
			}
			const t = this.peek();
			if (t.raw === "void") this.fail("VOID_OPERATOR");
			if (t.raw === "~") this.fail("BITWISE");
			if (this.at("++") || this.at("--")) {
				if (!mutation) this.fail("UPDATE_IN_EXPRESSION");
				this.take();
				const argument = this.assignmentTarget(this.unary(false, boundary, false, allowReturnType, allowIn), false);
				if (argument.type !== "Identifier" && argument.type !== "MemberExpression") this.fail("INVALID_ASSIGNMENT_TARGET", argument);
				return this.node(t, {
					type: "UpdateExpression",
					operator: t.raw,
					prefix: true,
					argument
				});
			}
			let expression = this.primary(mutation, boundary, allowArrow, allowReturnType, allowIn);
			expression = this.suffix(expression, boundary, t);
			if ((this.at("++") || this.at("--")) && !this.peek().lineBreakBefore) {
				if (!mutation) this.fail("UPDATE_IN_EXPRESSION");
				const op = this.take();
				const argument = this.assignmentTarget(expression, false);
				if (argument.type !== "Identifier" && argument.type !== "MemberExpression") this.fail("INVALID_ASSIGNMENT_TARGET", argument);
				expression = this.node(t, {
					type: "UpdateExpression",
					operator: op.raw,
					prefix: false,
					argument
				});
			}
			for (let i = prefixes.length - 1; i >= 0; i--) {
				const prefix = prefixes[i];
				if (prefix.raw === "delete" && expression.type === "Identifier") this.fail("STRICT_DELETE_IDENTIFIER", expression);
				if (expression.type === "UpdateExpression") this.fail("UPDATE_IN_EXPRESSION", expression);
				expression = prefix.raw === "await" ? this.node(prefix, {
					type: "AwaitExpression",
					argument: expression
				}) : this.node(prefix, {
					type: "UnaryExpression",
					operator: prefix.raw,
					prefix: true,
					argument: expression
				});
			}
			return expression;
		} finally {
			this.parserDepth--;
		}
	}
	lookahead(offset) {
		try {
			return this.peek(offset);
		} catch (error) {
			if (isStackOverflow(error)) throw error;
			return;
		}
	}
	expressionStart() {
		const token = this.peek();
		if (token.kind === "identifier" && this.peek(1).raw === ":") return false;
		if (token.raw === "function" || token.raw === "class" || token.raw === "async" && this.peek(1).raw === "function" && !this.peek(1).lineBreakBefore) return false;
		if ([
			"number",
			"string",
			"template",
			"templateHead"
		].includes(token.kind)) return true;
		if (token.kind === "identifier") return !reserved.has(String(token.value)) || [
			"true",
			"false",
			"null",
			"this",
			"super",
			"function",
			"class",
			"new",
			"typeof",
			"delete",
			"void",
			"await",
			"yield",
			"import"
		].includes(token.raw);
		return [
			"(",
			"[",
			"{",
			"!",
			"~",
			"+",
			"-",
			"++",
			"--",
			"/",
			"/="
		].includes(token.raw);
	}
	matchAhead() {
		const token = this.lookahead(1);
		return token !== void 0 && !token.lineBreakBefore && ([
			"number",
			"string",
			"template",
			"templateHead"
		].includes(token.kind) || token.kind === "identifier" && (!reserved.has(String(token.value)) || [
			"true",
			"false",
			"null"
		].includes(token.raw)));
	}
	arrowAhead(offset = 0, allowReturnType = true) {
		this.enterParser();
		try {
			const key = this.index * 4 + offset * 2 + Number(allowReturnType);
			const cached = this.arrowLookaheads.get(key);
			if (cached !== void 0) return cached;
			const result = this.detectArrow(offset, allowReturnType);
			this.arrowLookaheads.set(key, result);
			return result;
		} finally {
			this.parserDepth--;
		}
	}
	closingParenthesis(offset) {
		const start = this.index + offset;
		const cached = this.parenthesisEnds.get(start);
		if (cached !== void 0) return cached ?? void 0;
		const opening = [];
		for (let i = offset;; i++) {
			const token = this.lookahead(i);
			if (!token || token.kind === "eof") {
				for (const index of opening) this.parenthesisEnds.set(index, null);
				return;
			}
			if (token.raw === "(") opening.push(this.index + i);
			if (token.raw === ")") {
				this.parenthesisEnds.set(opening.pop(), this.index + i);
				if (!opening.length) return this.index + i;
			}
		}
	}
	detectArrow(offset, allowReturnType) {
		this.enterParser();
		try {
			if (this.peek(offset).raw !== "(") return this.peek(offset).kind === "identifier" && this.lookahead(offset + 1)?.raw === "=>";
			const end = this.closingParenthesis(offset);
			if (end === void 0) return false;
			const after = end - this.index + 1;
			if (this.lookahead(after)?.raw === "=>") return true;
			if (this.lookahead(after)?.raw !== ":" || !this.returnTypeAhead(after + 1)) return false;
			const saved = {
				index: this.index,
				previous: this.previous,
				functionDepth: this.functionDepth,
				loopDepth: this.loopDepth,
				switchDepth: this.switchDepth,
				labels: new Map(this.labels),
				annotations: this.typeAnnotationCount
			};
			try {
				if (allowReturnType) {
					this.index += offset;
					this.nested(() => this.parameters());
					return true;
				}
				this.arrow(offset !== 0, false, false);
				return this.at(":");
			} catch (error) {
				if (isStackOverflow(error)) throw error;
				return allowReturnType && error instanceof TonerikoScriptSyntaxError && error.code !== "UNEXPECTED_TOKEN";
			} finally {
				this.index = saved.index;
				this.previous = saved.previous;
				this.functionDepth = saved.functionDepth;
				this.loopDepth = saved.loopDepth;
				this.switchDepth = saved.switchDepth;
				this.labels = saved.labels;
				this.typeAnnotationCount = saved.annotations;
			}
		} finally {
			this.parserDepth--;
		}
	}
	returnTypeAhead(offset) {
		const closing = [];
		for (let i = offset;; i++) {
			const token = this.lookahead(i);
			if (!token || token.kind === "eof" || token.kind === "identifier" && reserved.has(String(token.value)) && ![
				"void",
				"null",
				"true",
				"false",
				"typeof",
				"this",
				"new"
			].includes(token.raw)) return false;
			if (!closing.length) {
				if (token.raw === "=>") return true;
				if ([
					";",
					",",
					"=",
					"?",
					":",
					")",
					"}",
					"]"
				].includes(token.raw)) return false;
			}
			if (token.raw === "(") closing.push(")");
			if (token.raw === "{") closing.push("}");
			if (token.raw === "[") closing.push("]");
			if (token.raw === closing.at(-1)) closing.pop();
		}
	}
	arrow(async, boundary, allowReturnType = true, allowIn = true) {
		this.enterParser();
		try {
			this.enterSyntax();
			try {
				const key = this.index * 8 + Number(boundary) * 4 + Number(allowReturnType) * 2 + Number(allowIn);
				const cached = this.arrows.get(key);
				if (cached) {
					this.index = cached.end;
					this.previous = this.tokens[this.index - 1];
					this.typeAnnotationCount += cached.annotations;
					return { ...cached.expression };
				}
				const start = this.peek();
				const annotations = this.typeAnnotationCount;
				if (async) this.take();
				const params = this.at("(") ? this.parameters() : [this.identifier()];
				const returnType = this.eat(":") ? this.checkedTypeAnnotation(true) : void 0;
				if (this.peek().lineBreakBefore) this.fail("NEWLINE_ARROW");
				this.expect("=>");
				if (this.at("{") && this.peek(1).kind === "identifier" && this.peek(2).raw === ":") {
					let offset = 3;
					while (this.peek(offset).kind === "identifier" && this.peek(offset + 1).raw === ":") offset += 2;
					if (![
						"for",
						"while",
						"do",
						"{",
						"function",
						"async"
					].includes(this.peek(offset).raw)) this.fail("ARROW_OBJECT_BODY", this.peek(1));
				}
				const body = this.at("{") ? this.functionBody() : this.expression(0, false, boundary, allowIn, false, allowReturnType);
				const expression = this.node(start, {
					type: "ArrowFunctionExpression",
					params,
					body,
					async,
					generator: false,
					expression: body.type !== "BlockStatement",
					...returnType ? { returnType } : {}
				});
				this.arrows.set(key, {
					expression,
					end: this.index,
					annotations: this.typeAnnotationCount - annotations
				});
				return { ...expression };
			} finally {
				this.syntaxDepth--;
			}
		} finally {
			this.parserDepth--;
		}
	}
	primary(mutation, boundary, allowArrow, allowReturnType, allowIn) {
		this.enterParser();
		try {
			const t = this.peek();
			if (this.at("async") && !this.peek(1).lineBreakBefore && this.arrowAhead(1, allowReturnType)) {
				if (!allowArrow) this.fail("UNEXPECTED_TOKEN");
				return this.arrow(true, boundary, allowReturnType, allowIn);
			}
			if ((this.at("(") || t.kind === "identifier") && this.arrowAhead(0, allowReturnType)) {
				if (!allowArrow) this.fail("UNEXPECTED_TOKEN");
				return this.arrow(false, boundary, allowReturnType, allowIn);
			}
			if (this.eat("(")) {
				const expression = this.nested(() => this.expression(0, mutation, false, true));
				if (this.at(",")) this.fail("COMMA_OPERATOR");
				this.expect(")");
				this.parenthesized.add(expression);
				return expression;
			}
			if (t.kind === "number" || t.kind === "string" || [
				"true",
				"false",
				"null"
			].includes(t.raw)) return this.literal();
			if (t.kind === "template" || t.kind === "templateHead") return this.template();
			if (this.at("[")) return this.array(mutation);
			if (this.at("{")) return this.object(mutation);
			if (this.eat("new")) {
				if (!this.at("Error")) {
					if ([
						"Map",
						"Set",
						"Date"
					].includes(this.peek().raw)) this.fail("COLLECTION");
					const code = this.forbidden(String(this.peek().value));
					this.fail(code ?? "NEW");
				}
				const callee = this.identifier();
				if (this.at("<")) this.fail("TYPE_ARGUMENTS");
				if (!this.at("(")) this.fail("NEW", t);
				this.continuation(boundary);
				const args = this.arguments();
				return this.node(t, {
					type: "NewExpression",
					callee,
					arguments: args
				});
			}
			if (this.at("function") || this.at("async") && this.peek(1).raw === "function" && !this.peek(1).lineBreakBefore) {
				if (this.at("function") && this.peek(1).raw === "*" || this.at("async") && this.peek(2).raw === "*") this.fail("GENERATOR");
				this.fail("FUNCTION_EXPRESSION");
			}
			if (this.at("/") || this.at("/=")) this.fail("REGEXP");
			if (this.at("if")) this.fail("AISCRIPT_IF");
			if (this.at("@")) this.fail("AISCRIPT_FUNCTION");
			if (this.at("match") && this.matchAhead()) this.fail("AISCRIPT_MATCH");
			if (this.at("each") && this.peek(1).raw === "let" && !this.peek(1).lineBreakBefore) this.fail("AISCRIPT_EACH");
			if (this.at("eval") && this.peek(1).raw === "{") this.fail("AISCRIPT_EVAL");
			if (this.at("<")) this.fail(this.peek(1).raw === ":" ? "AISCRIPT_OUTPUT" : "TYPE_ARGUMENTS");
			if (t.kind === "identifier") {
				const code = this.forbidden(String(t.value));
				if (code) this.fail(code);
				if (["Map", "Set"].includes(String(t.value))) this.fail("COLLECTION");
				const id = this.identifier();
				if (id.name === "Date" && this.at("(")) this.fail("COLLECTION", id);
				return id;
			}
			this.fail("UNEXPECTED_TOKEN");
		} finally {
			this.parserDepth--;
		}
	}
	suffix(initial, boundary, start) {
		this.enterParser();
		try {
			let expression = initial;
			let chain = false;
			if (initial.type === "ArrowFunctionExpression" && !this.parenthesized.has(initial)) return initial;
			while (true) {
				if (this.at("(") || this.at("[") || this.peek().kind === "template" || this.peek().kind === "templateHead") this.continuation(boundary);
				if (this.peek().kind === "template" || this.peek().kind === "templateHead") this.fail("TAGGED_TEMPLATE");
				if (this.at("<") && this.typeArgumentsAhead()) this.fail("TYPE_ARGUMENTS");
				let optional = false;
				if (this.eat("?.")) {
					optional = true;
					chain = true;
				}
				if (this.at("(")) {
					const callee = expression.type === "ChainExpression" ? expression.expression : expression;
					if (callee.type === "Identifier" && callee.name === "Date") this.fail("COLLECTION", callee);
					if (callee.type === "MemberExpression" && (callee.property.type === "Identifier" && !callee.computed && callee.property.name === "then" || callee.computed && callee.property.type === "Literal" && callee.property.value === "then")) this.fail("PROMISE", callee.property);
					const args = this.arguments();
					expression = this.node(start, {
						type: "CallExpression",
						callee: expression,
						arguments: args,
						optional
					});
				} else if (this.eat("[")) {
					const property = this.nested(() => this.expression());
					this.expect("]");
					expression = this.node(start, {
						type: "MemberExpression",
						object: expression,
						property,
						computed: true,
						optional
					});
				} else if (optional || this.eat(".")) {
					const property = this.identifier(true);
					expression = this.node(start, {
						type: "MemberExpression",
						object: expression,
						property,
						computed: false,
						optional
					});
				} else break;
			}
			if (chain) {
				if (expression.type !== "MemberExpression" && expression.type !== "CallExpression") this.fail("UNEXPECTED_TOKEN", expression);
				return this.node(start, {
					type: "ChainExpression",
					expression
				});
			}
			return expression;
		} finally {
			this.parserDepth--;
		}
	}
	typeArgumentsAhead() {
		if (this.failedTypeArguments.has(this.index)) return false;
		const closing = [{
			raw: ">",
			index: this.index
		}];
		const reject = () => {
			this.failedTypeArguments.add(this.index);
			for (const token of closing) if (token.raw === ">") this.failedTypeArguments.add(token.index);
			return false;
		};
		let atom = false;
		let conditional = 0;
		let conditionalColon = 0;
		for (let i = 1;; i++) {
			const token = this.lookahead(i);
			if (!token || token.kind === "eof" || token.kind.startsWith("template")) return reject();
			const raw = token.raw;
			if (raw === ">" || raw === ">>" || raw === ">>>") {
				if (!atom) return reject();
				for (let n = 0; n < raw.length; n++) {
					if (closing.at(-1)?.raw !== ">") return reject();
					closing.pop();
					if (!closing.length) return n === raw.length - 1 && this.lookahead(i + 1)?.raw === "(";
				}
				continue;
			}
			if (raw === "extends") {
				if (!atom) return reject();
				conditional++;
				atom = false;
				continue;
			}
			if (token.kind === "identifier" || token.kind === "number" || token.kind === "string") {
				if (atom || token.kind === "identifier" && reserved.has(String(token.value)) && ![
					"void",
					"null",
					"true",
					"false",
					"typeof",
					"this",
					"new"
				].includes(raw)) return reject();
				atom = ![
					"typeof",
					"keyof",
					"readonly",
					"new"
				].includes(raw);
				continue;
			}
			if (raw === "<") {
				if (!atom || this.failedTypeArguments.has(this.index + i)) return reject();
				closing.push({
					raw: ">",
					index: this.index + i
				});
				atom = false;
			} else if (raw === "(" || raw === "{" || raw === "[") {
				if (atom && raw !== "[") return reject();
				closing.push({
					raw: raw === "(" ? ")" : raw === "{" ? "}" : "]",
					index: this.index + i
				});
				atom = false;
			} else if (raw === ")" || raw === "}" || raw === "]") {
				if (closing.at(-1)?.raw !== raw) return reject();
				closing.pop();
				atom = true;
			} else if (raw === "?") {
				if (conditional) {
					conditional--;
					conditionalColon++;
				} else if (![
					"}",
					"]",
					")"
				].includes(closing.at(-1).raw)) return reject();
				atom = false;
			} else if (raw === "...") {
				if (atom || closing.at(-1)?.raw !== "]") return reject();
			} else if ([
				"|",
				"&",
				",",
				":",
				";",
				".",
				"=>"
			].includes(raw)) {
				if (raw === ":" && conditionalColon) conditionalColon--;
				else if ([":", ";"].includes(raw) && !closing.some((c) => c.raw === "}" || c.raw === ")")) return reject();
				atom = false;
			} else return reject();
		}
	}
	arguments() {
		this.enterParser();
		try {
			this.enterSyntax();
			try {
				this.expect("(");
				const args = [];
				while (!this.at(")")) {
					if (this.at("...")) {
						const start = this.take();
						args.push(this.node(start, {
							type: "SpreadElement",
							argument: this.expression()
						}));
					} else args.push(this.expression());
					if (!this.eat(",")) break;
				}
				this.expect(")");
				return args;
			} finally {
				this.syntaxDepth--;
			}
		} finally {
			this.parserDepth--;
		}
	}
	literal() {
		const t = this.take();
		const value = t.raw === "null" ? null : t.raw === "true" ? true : t.raw === "false" ? false : t.value;
		return this.node(t, {
			type: "Literal",
			value,
			raw: t.raw
		});
	}
	template() {
		this.enterParser();
		try {
			this.enterSyntax();
			try {
				const start = this.peek();
				const expressions = [];
				const quasis = [];
				while (true) {
					const token = this.take();
					const tail = token.kind === "template" || token.kind === "templateTail";
					const raw = token.raw.slice(1, tail ? -1 : -2).replace(/\r\n?/g, "\n");
					quasis.push(this.node(token, {
						type: "TemplateElement",
						value: {
							raw,
							cooked: String(token.value)
						},
						tail
					}));
					if (tail) break;
					expressions.push(this.expression());
					if (this.peek().kind !== "templateMiddle" && this.peek().kind !== "templateTail") this.fail("UNEXPECTED_TOKEN");
				}
				return this.node(start, {
					type: "TemplateLiteral",
					expressions,
					quasis
				});
			} finally {
				this.syntaxDepth--;
			}
		} finally {
			this.parserDepth--;
		}
	}
	array(mutation) {
		this.enterParser();
		try {
			this.enterSyntax();
			try {
				const start = this.expect("[");
				const elements = [];
				while (!this.at("]")) {
					if (this.eat(",")) {
						elements.push(null);
						continue;
					}
					if (this.at("...")) {
						const t = this.take();
						elements.push(this.node(t, {
							type: "SpreadElement",
							argument: this.expression(0, mutation, false, true, mutation)
						}));
					} else elements.push(this.expression(0, mutation, false, true, mutation));
					if (!this.eat(",")) break;
				}
				const comma = this.previous?.raw === ",";
				this.expect("]");
				const array = this.node(start, {
					type: "ArrayExpression",
					elements
				});
				if (comma) this.trailingComma.add(array);
				return array;
			} finally {
				this.syntaxDepth--;
			}
		} finally {
			this.parserDepth--;
		}
	}
	propertyKey() {
		this.enterParser();
		try {
			if (this.eat("[")) {
				const key = this.nested(() => this.expression());
				this.expect("]");
				return {
					key,
					computed: true
				};
			}
			return {
				key: this.peek().kind === "number" || this.peek().kind === "string" ? this.literal() : this.identifier(true),
				computed: false
			};
		} finally {
			this.parserDepth--;
		}
	}
	object(mutation) {
		this.enterParser();
		try {
			this.enterSyntax();
			try {
				const start = this.expect("{");
				const properties = [];
				while (!this.at("}")) {
					const t = this.peek();
					if (this.eat("...")) properties.push(this.node(t, {
						type: "SpreadElement",
						argument: this.expression()
					}));
					else {
						if (this.at("*") || this.at("async") && this.peek(1).raw === "*") this.fail("GENERATOR");
						const { key, computed } = this.propertyKey();
						if (key.type === "Identifier" && ["get", "set"].includes(key.name) && (this.peek().kind === "identifier" || this.peek().kind === "string" || this.peek().kind === "number" || this.at("["))) this.fail("ACCESSOR", t);
						if (this.at("(") || key.type === "Identifier" && key.name === "async" && (this.peek().kind === "identifier" || this.peek().kind === "string" || this.peek().kind === "number" || this.at("["))) this.fail("METHOD_SHORTHAND", t);
						if (this.at("<")) this.fail("TYPE_ARGUMENTS");
						const shorthand = !this.eat(":");
						let value;
						if (shorthand) {
							if (key.type !== "Identifier" || computed || reserved.has(key.name)) this.fail("UNEXPECTED_TOKEN", t);
							if (this.forbidden(key.name)) this.fail(this.forbidden(key.name), t);
							value = {
								...key,
								loc: { ...key.loc }
							};
							if (mutation && this.eat("=")) value = this.node(key, {
								type: "AssignmentPattern",
								left: value,
								right: this.expression()
							});
						} else value = this.expression(0, mutation, false, true, mutation);
						properties.push(this.node(t, {
							type: "Property",
							key,
							value,
							shorthand,
							computed,
							kind: "init",
							method: false
						}));
					}
					if (!this.eat(",")) break;
				}
				const comma = this.previous?.raw === ",";
				this.expect("}");
				const object = this.node(start, {
					type: "ObjectExpression",
					properties
				});
				if (comma) this.trailingComma.add(object);
				return object;
			} finally {
				this.syntaxDepth--;
			}
		} finally {
			this.parserDepth--;
		}
	}
	checkExpression(initial, root = false) {
		if (initial.type === "ArrowFunctionExpression" || initial.type === "Identifier" || initial.type === "Literal" || initial.type === "TemplateElement") return;
		const pending = [initial];
		while (pending.length) {
			const node = pending.pop();
			if (node.type === "ArrowFunctionExpression" || node.type === "Identifier" || node.type === "Literal" || node.type === "TemplateElement") continue;
			if (node.type === "AssignmentPattern") this.fail("ASSIGNMENT_IN_EXPRESSION", node);
			if (node.type === "AssignmentExpression") {
				if (node !== initial || !root) this.fail("ASSIGNMENT_IN_EXPRESSION", node);
				pending.push(node.right);
				continue;
			}
			if (node.type === "UpdateExpression") {
				if (node !== initial || !root) this.fail("UPDATE_IN_EXPRESSION", node);
				continue;
			}
			if (this.checkedExpressions.has(node)) continue;
			if (node.type === "ObjectExpression") {
				let proto = false;
				for (const property of node.properties) if (property.type === "Property" && !property.computed && !property.shorthand && (property.key.type === "Identifier" && property.key.name === "__proto__" || property.key.type === "Literal" && property.key.value === "__proto__")) {
					if (proto) this.fail("UNEXPECTED_TOKEN", property);
					proto = true;
				}
			}
			const begin = pending.length;
			for (const key in node) {
				if (key === "loc" || key === "typeAnnotation") continue;
				const value = node[key];
				if (Array.isArray(value)) {
					for (const child of value) if (child && typeof child === "object" && "type" in child) pending.push(child);
				} else if (value && typeof value === "object" && "type" in value) pending.push(value);
			}
			for (let left = begin, right = pending.length - 1; left < right; left++, right--) [pending[left], pending[right]] = [pending[right], pending[left]];
		}
		this.checkedExpressions.add(initial);
	}
	assignmentTarget(expression, destructure) {
		this.enterParser();
		try {
			if (expression.type === "Identifier") return expression;
			if (expression.type === "MemberExpression" && !expression.optional) return expression;
			if (destructure && !this.parenthesized.has(expression)) {
				if (expression.type === "ArrayExpression") return {
					type: "ArrayPattern",
					elements: expression.elements.map((item, i) => {
						if (!item) return null;
						if (item.type === "SpreadElement") {
							if (i !== expression.elements.length - 1 || this.trailingComma.has(expression) || item.argument.type === "AssignmentExpression") this.fail("INVALID_ASSIGNMENT_TARGET", item);
							return {
								type: "RestElement",
								argument: this.assignmentPattern(item.argument),
								loc: item.loc
							};
						}
						return this.assignmentPattern(item);
					}),
					loc: expression.loc
				};
				if (expression.type === "ObjectExpression") return {
					type: "ObjectPattern",
					properties: expression.properties.map((p, i) => {
						if (p.type === "SpreadElement") {
							if (i !== expression.properties.length - 1 || this.trailingComma.has(expression)) this.fail("INVALID_ASSIGNMENT_TARGET", p);
							return {
								type: "RestElement",
								argument: this.assignmentTarget(p.argument, false),
								loc: p.loc
							};
						}
						return {
							...p,
							value: p.value.type === "AssignmentPattern" ? p.value : this.assignmentPattern(p.value)
						};
					}),
					loc: expression.loc
				};
			}
			this.fail("INVALID_ASSIGNMENT_TARGET", expression);
		} finally {
			this.parserDepth--;
		}
	}
	assignmentPattern(expression) {
		this.enterParser();
		try {
			if (expression.type === "AssignmentExpression" && this.parenthesized.has(expression)) this.fail("INVALID_ASSIGNMENT_TARGET", expression);
			if (expression.type === "AssignmentExpression" && expression.operator === "=") return {
				type: "AssignmentPattern",
				left: expression.left,
				right: expression.right,
				loc: expression.loc
			};
			return this.assignmentTarget(expression, true);
		} finally {
			this.parserDepth--;
		}
	}
};

//#endregion
export { parse };
//# sourceMappingURL=index.js.map