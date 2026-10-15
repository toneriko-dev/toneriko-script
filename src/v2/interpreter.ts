import { standardGlobals } from './stdlib/index.js';
import { isStdFunction, STANDARD_FUNCTION, validateArguments, type StdContext } from './stdlib/core.js';
import type * as A from './ast.js';
import { defaultYieldToHost, macrotaskTick } from '../interpreter/host-yield.js';
import { Environment, boundNames } from './runtime/environment.js';
import { ExecutionStopped, RuntimeError, runtimeError, scriptErrorDiagnostic, createScriptError } from './runtime/errors.js';
import { PropertyAccess, SCRIPT_FUNCTION, isScriptFunction, valueTypeof, errorValue, scriptObject } from './runtime/values.js';
import type { Value, ScriptFunction } from './runtime/values.js';
export { RuntimeError, ExecutionStopped } from './runtime/errors.js';
export type { Value } from './runtime/values.js';

const origin: A.Pos = { line: 1, column: 1 };
const shortCircuit = Symbol('optional chain');
const errorConstructor = () => { throw new Error('Use Interpreter.call'); };
const promiseThen = Promise.prototype.then;
class ScriptThrown {
	constructor(readonly value: Value, readonly pos: A.Pos, readonly diagnostic?: RuntimeError) {}
}
type Completion = { kind: 'return' | 'break' | 'continue'; value: Value; label: string | null };
type Reference = { kind: 'binding'; name: string; env: Environment } | { kind: 'property'; object: Value; key: Value };
type Ready = { ready: any };
type Frame = Generator<Frame | Waiting | Ready, any, any>;
type Synchronous = { cost: number; evaluate: (env: Environment, execution: Execution) => any };
type Waiting = { wait: PromiseLike<unknown>; pos: A.Pos };
type Execution = { callDepth: number; steps: number; clock: number; properties: PropertyAccess; pos: A.Pos };
export type HostContext = { call(fn: Value, args: Value[]): Promise<Value>; signal: AbortSignal };
const hostBodies = new WeakMap<Function, (args: Value[], context: HostContext) => unknown>();
export function hostFunction(body: (args: Value[], context: HostContext) => unknown): (...args: Value[]) => unknown {
	const fn = (..._args: Value[]): unknown => { throw new Error('Use Interpreter.call'); };
	hostBodies.set(fn, body);
	return fn;
}
export type InterpreterOptions = {
	maxSteps?: number;
	/** 同時に実行するスクリプト関数の数を制限します。 */
	maxCallDepth?: number;
	maxBusyTime?: number;
	yieldInterval?: number;
	yieldToHost?: () => Promise<void>;
	/** 時計を注入すると、上限の境界を実時間の揺れなしに検査できます。 */
	now?: () => number;
};

export class Interpreter {
	public stepCount = 0;
	public evaluationFrameCount = 0;
	private readonly synchronousNodes = new WeakMap<A.Statement | A.Expression, Synchronous | null>();
	private readonly maxCallDepth: number;
	private readonly global: Environment;
	private readonly controller = new AbortController();
	private stopped: ExecutionStopped | null = null;
	private readonly now: () => number;
	private readonly yieldInterval: number;
	private readonly maxBusyTime: number;
	private readonly yieldToHost: () => Promise<void>;
	private lastClock = 0;
	private lastYield = 0;
	private busy = 0;
	private yielding = 0;
	private idleTickPending = false;
	private idle = true;
	private active = 0;

	constructor(globals: Record<string, unknown> = {}, private readonly options: InterpreterOptions = {}) {
		this.now = options.now ?? (() => performance.now());
		this.yieldInterval = options.yieldInterval ?? 8;
		this.maxBusyTime = options.maxBusyTime ?? 5000;
		this.maxCallDepth = options.maxCallDepth ?? 10000;
		if (!Number.isSafeInteger(this.maxCallDepth) || this.maxCallDepth < 1) throw new RangeError('Invalid call depth limit');
		if (!(this.yieldInterval >= 0) || !(this.maxBusyTime > 0) || (options.maxSteps !== undefined && (!Number.isSafeInteger(options.maxSteps) || options.maxSteps < 0))) throw new RangeError('Invalid execution limit');
		this.yieldToHost = options.yieldToHost ?? defaultYieldToHost;
		const builtins = new Environment();
		builtins.declare('Error', false);
		builtins.write('Error', errorConstructor, origin, true);
		for (const [name, value] of Object.entries(standardGlobals())) {
			builtins.declare(name, false);
			builtins.write(name, value, origin, true);
		}
		const host = new Environment(builtins);
		const properties = new PropertyAccess();
		for (const [name, value] of Object.entries(globals)) {
			host.declare(name, false);
			host.write(name, properties.normalize(value, origin), origin, true);
		}
		this.global = new Environment(host);
	}

	async exec(program: A.Program): Promise<void> {
		const execution = this.execution();
		await this.run(this.sequence(program.body, this.global, execution, true), execution);
	}
	getGlobal(name: string): Value { return this.global.read(name, origin); }
	async call(fn: Value, args: Value[]): Promise<Value> {
		const execution = this.execution();
		return this.run(this.invoke(fn, args, null, execution, origin), execution);
	}
	abort(): void { this.stop('EXECUTION_ABORTED', origin); }

	private execution(): Execution {
		const execution: Execution = { callDepth: 0, steps: 0, clock: 0, properties: undefined!, pos: origin };
		execution.properties = new PropertyAccess(() => this.tick(execution, execution.pos));
		return execution;
	}
	private stop(code: 'EXECUTION_ABORTED' | 'STEP_LIMIT_EXCEEDED' | 'BUSY_TIME_EXCEEDED', pos: A.Pos): ExecutionStopped {
		if (!this.stopped) {
			this.stopped = new ExecutionStopped(code, pos);
			this.controller.abort(this.stopped);
		}
		return this.stopped;
	}
	private tick(execution: Execution, pos: A.Pos): void {
		execution.pos = pos;
		if (this.stopped) throw this.stopped;
		execution.steps++;
		this.stepCount++;
		if (this.options.maxSteps !== undefined && execution.steps > this.options.maxSteps) throw this.stop('STEP_LIMIT_EXCEEDED', pos);
		if (++execution.clock % 64 === 0) this.checkTime(pos);
	}
	private resume(): void {
		if (this.idle) {
			this.idle = false;
			this.lastClock = this.lastYield = this.now();
		}
		this.armIdle();
	}
	private armIdle(): void {
		if (this.idleTickPending) return;
		this.idleTickPending = true;
		void macrotaskTick().then(() => {
			this.idleTickPending = false;
			if (this.yielding === 0) { this.busy = 0; this.idle = true; }
		});
	}
	private checkTime(pos: A.Pos): void {
		const now = this.now();
		this.busy += now - this.lastClock;
		this.lastClock = now;
		this.armIdle();
		if (this.busy > this.maxBusyTime) throw this.stop('BUSY_TIME_EXCEEDED', pos);
	}
	private wait(promise: PromiseLike<unknown>): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const signal = this.controller.signal;
			const aborted = () => reject(this.stopped);
			// 中止済みでも元の処理の拒否を受け、処理されない reject を残さない。
			Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
			if (signal.aborted) { reject(this.stopped); return; }
			signal.addEventListener('abort', aborted, { once: true });
		});
	}

	// 子の評価はフレームを積むだけなので、再帰の深さは JavaScript のコールスタックを使いません。
	private async run(first: Frame, execution: Execution, internal = false): Promise<any> {
		const frames = [first];
		let value: any;
		let throwing = false;
		this.active++;
		this.resume();
		try {
			while (frames.length) {
				if (this.stopped) throw this.stopped;
				if (execution.clock >= 64) {
					execution.clock = 0;
					this.checkTime(execution.pos);
					if (this.yieldInterval !== 0 && this.now() - this.lastYield >= this.yieldInterval) {
						this.yielding++;
						try { await this.wait(this.yieldToHost()); }
						finally { this.yielding--; }
						this.lastClock = this.lastYield = this.now();
						this.armIdle();
					}
				}
				let result: IteratorResult<Frame | Waiting | Ready, any>;
				try { result = throwing ? frames.at(-1)!.throw(value) : frames.at(-1)!.next(value); }
				catch (error) {
					if (this.stopped) throw this.stopped;
					error = this.internalException(error, execution);
					frames.pop(); value = error; throwing = true; continue;
				}
				throwing = false;
				if (result.done) { frames.pop(); value = result.value; continue; }
				if ('ready' in result.value) { value = result.value.ready; }
				else if ('wait' in result.value) {
					this.checkTime(result.value.pos);
					try { value = await this.wait(result.value.wait); }
					catch (error) { value = error; throwing = true; }
					this.resume();
				} else { frames.push(result.value); value = undefined; }
			}
			if (throwing) {
				// ホストへのコールバックから出る診断も、スクリプト由来の値として識別する。
				if (internal && value instanceof RuntimeError) throw new ScriptThrown(createScriptError(value.name, value.message, value), value.pos, value);
				if (value instanceof ScriptThrown && !internal) {
					let name: unknown;
					let message: unknown;
					// 例外の付加情報を読めなくても、最初に投げられた値を失わない。
					try {
						if (errorValue(value.value, value.pos)) {
							name = execution.properties.get(value.value, 'name', value.pos);
							message = execution.properties.get(value.value, 'message', value.pos);
						}
					} catch { /* 付加情報の取得に失敗したときは既定の診断文を使う。 */ }
					const diagnostic = typeof name === 'string' && typeof message === 'string' ? value.diagnostic : undefined;
					const error = runtimeError(diagnostic?.code ?? 'UNCAUGHT_EXCEPTION', diagnostic?.pos ?? value.pos, diagnostic?.params ?? {}, typeof name === 'string' ? name : undefined);
					if (typeof message === 'string') error.message = message;
					Object.assign(error, { thrownValue: value.value, cause: value.value });
					throw error;
				}
				throw value;
			}
			this.checkTime(execution.pos);
			return value;
		} finally {
			this.active--;
			if (this.active === 0) execution.properties.clear?.();
		}
	}

	/** 付加情報の getter や Proxy が失敗しても、例外の伝播を中断しない。 */
	private internalException(error: unknown, execution: Execution): unknown {
		let defaultName = 'Error';
		let name = defaultName;
		let message = '';
		try {
			// ホスト由来の例外と診断は、呼び出し元で種類が確定している。
			if (error instanceof RuntimeError || error instanceof ScriptThrown) return error;
			if (!errorValue(error, execution.pos)) return error;
			for (const type of [EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError, AggregateError]) {
				if (error instanceof type) { defaultName = type.name; break; }
			}
			const candidateName = execution.properties.get(error, 'name', execution.pos);
			const candidateMessage = execution.properties.get(error, 'message', execution.pos);
			name = typeof candidateName === 'string' ? candidateName : defaultName;
			message = typeof candidateMessage === 'string' ? candidateMessage : '';
		} catch {
			name = defaultName;
			message = '';
		}
		return new ScriptThrown(createScriptError(name, message), execution.pos);
	}

	private prepare(body: A.Statement[], env: Environment, execution: Execution): void {
		for (const statement of body) {
			const node = statement.type === 'ExportMetaDeclaration' ? statement.declaration : statement;
			const names = node.type === 'VariableDeclaration' ? node.declarations.flatMap(declaration => boundNames(declaration.id)) : node.type === 'FunctionDeclaration' ? [node.id.name] : [];
			for (const name of names) if (env.bindings.has(name)) throw runtimeError('DUPLICATE_DECLARATION', node.loc.start, { name }, 'SyntaxError');
		}
		for (const statement of body) {
			const node = statement.type === 'ExportMetaDeclaration' ? statement.declaration : statement;
			if (node.type === 'VariableDeclaration') {
				for (const declaration of node.declarations) for (const name of boundNames(declaration.id)) {
					this.tick(execution, declaration.loc.start);
					env.declare(name, node.kind === 'let');
				}
			} else if (node.type === 'FunctionDeclaration') {
				this.tick(execution, node.loc.start);
				env.declare(node.id.name, true);
				env.write(node.id.name, this.functionValue(node, env), node.loc.start, true);
			}
		}
	}
	private functionValue(node: A.FunctionDeclaration | A.ArrowFunctionExpression, environment: Environment): ScriptFunction {
		return { [SCRIPT_FUNCTION]: true, params: node.params, body: node.body, environment, ...(node.type === 'FunctionDeclaration' ? { name: node.id.name } : {}) };
	}
	private *sequence(body: A.Statement[], env: Environment, execution: Execution, prepare = true): Frame {
		if (prepare) this.prepare(body, env, execution);
		for (const node of body) {
			const result = yield this.evaluate(node, env, execution);
			if (result) return result;
		}
		return null;
	}
	private *reference(node: A.Identifier | A.MemberExpression, env: Environment, execution: Execution): Frame {
		this.tick(execution, node.loc.start);
		if (node.type === 'Identifier') return { kind: 'binding', name: node.name, env } satisfies Reference;
		const object = yield this.evaluate(node.object, env, execution);
		if (object === shortCircuit || (node.optional && object === null)) return shortCircuit;
		const key = node.computed ? yield this.evaluate(node.property, env, execution) : (node.property as A.Identifier).name;
		execution.properties.key(key, node.loc.start);
		yield this.prepared(object, execution, node.loc.start, key !== 'length');
		return { kind: 'property', object, key } satisfies Reference;
	}
	private read(ref: Reference, execution: Execution, pos: A.Pos): Value {
		return ref.kind === 'binding' ? ref.env.read(ref.name, pos) : execution.properties.get(ref.object, ref.key, pos);
	}
	private write(ref: Reference, value: Value, execution: Execution, pos: A.Pos): void {
		if (ref.kind === 'binding') ref.env.write(ref.name, value, pos);
		else execution.properties.set(ref.object, ref.key, value, pos);
	}
	private *bindingReference(pattern: A.Pattern | A.MemberExpression, env: Environment, execution: Execution): Frame {
		const target = pattern.type === 'RestElement' ? pattern.argument : pattern.type === 'AssignmentPattern' ? pattern.left : pattern;
		return target.type === 'MemberExpression' ? yield this.reference(target, env, execution) : null;
	}
	private *bind(pattern: A.Pattern | A.MemberExpression, value: Value, env: Environment, execution: Execution, initialize: boolean, reference?: Reference | null): Frame {
		this.tick(execution, pattern.loc.start);
		const pos = pattern.loc.start;
		switch (pattern.type) {
			case 'Identifier': env.write(pattern.name, value, pos, initialize); return null;
			case 'MemberExpression': this.write(reference ?? (yield this.reference(pattern, env, execution)), value, execution, pos); return null;
			case 'AssignmentPattern': {
				// 代入先は既定値の副作用より先に確定します。
				reference = reference === undefined ? yield this.bindingReference(pattern, env, execution) : reference;
				const assigned = value === null ? yield this.evaluate(pattern.right, env, execution) : value;
				if (reference) this.write(reference, assigned, execution, pos);
				else yield this.bind(pattern.left, assigned, env, execution, initialize);
				return null;
			}
			case 'RestElement': yield this.bind(pattern.argument, value, env, execution, initialize, reference); return null;
			case 'ArrayPattern': {
				yield this.prepared(value, execution, pos);
				const items = Array.isArray(value) ? value : yield this.spread(value, execution, pos);
				let exhausted = false;
				for (let i = 0; i < pattern.elements.length; i++) {
					const part = pattern.elements[i];
					const target: Reference | null = part ? yield this.bindingReference(part, env, execution) : null;
					let item: Value = null;
					if (i >= items.length) exhausted = true;
					if (part?.type === 'RestElement') {
						const rest: Value[] = scriptObject([]);
						if (!exhausted) for (let index = i; index < items.length; index++) {
							this.tick(execution, pos); rest.push(execution.properties.get(items, index, pos));
							if (execution.clock >= 64) yield this.checkpoint();
						}
						item = rest;
					} else if (!exhausted) item = execution.properties.get(items, i, pos);
					if (part) yield this.bind(part, item, env, execution, initialize, target);
				}
				return null;
			}
			case 'ObjectPattern': {
				if (value === null) throw runtimeError('NULL_PROPERTY_ACCESS', pos, {}, 'TypeError');
				yield this.prepared(value, execution, pos);
				const excluded = new Set<string>();
				for (const property of pattern.properties) {
					if (property.type === 'RestElement') {
						const target: Reference | null = yield this.bindingReference(property, env, execution);
						const rest = scriptObject(Object.create(null));
						yield this.prepared(value, execution, pos);
						for (const [key, item] of execution.properties.entriesIterator(value, pos)) {
							if (!excluded.has(key)) rest[key] = item;
							if (execution.clock >= 64) yield this.checkpoint();
						}
						yield this.bind(property.argument, rest, env, execution, initialize, target);
					} else {
						const key = property.computed ? yield this.evaluate(property.key as A.Expression, env, execution) : property.key.type === 'Identifier' ? property.key.name : (property.key as A.Literal).value;
						const validatedKey = execution.properties.key(key, property.loc.start);
						excluded.add(validatedKey);
						const target: Reference | null = yield this.bindingReference(property.value as A.Pattern, env, execution);
						yield this.bind(property.value as A.Pattern, execution.properties.get(value, validatedKey, property.loc.start), env, execution, initialize, target);
					}
				}
				return null;
			}
		}
	}
	private text(value: Value, pos: A.Pos): string {
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
		throw runtimeError('INVALID_STRING_CONVERSION', pos, {}, 'TypeError');
	}
	private binary(operator: A.BinaryExpression['operator'], left: Value, right: Value, execution: Execution, pos: A.Pos): Value {
		if (operator === '===' || operator === '==') return left === right;
		if (operator === '!==' || operator === '!=') return left !== right;
		if (operator === 'in') return execution.properties.has(right, left, pos);
		if (operator === '+' && (typeof left === 'string' || typeof right === 'string')) return execution.properties.concat(this.text(left, pos), this.text(right, pos));
		if (['<', '<=', '>', '>='].includes(operator) && typeof left === 'string' && typeof right === 'string') {
			if (operator === '<') return left < right;
			if (operator === '<=') return left <= right;
			if (operator === '>') return left > right;
			return left >= right;
		}
		if (typeof left !== 'number' || typeof right !== 'number') throw runtimeError('IMPLICIT_COERCION', pos, {}, 'TypeError');
		switch (operator) {
			case '+': return left + right;
			case '-': return left - right;
			case '*': return left * right;
			case '/': return left / right;
			case '%': return left % right;
			case '**': return left ** right;
			case '<': return left < right;
			case '<=': return left <= right;
			case '>': return left > right;
			case '>=': return left >= right;
			default: throw new Error('Unknown binary operation');
		}
	}

	private *checkpoint(): Frame { return null; }
	private *prepared(value: unknown, execution: Execution, pos: A.Pos, parts = true): Frame {
		for (const _ of execution.properties.prepare(value, pos, parts)) yield this.checkpoint();
		return null;
	}
	private *spread(value: Value, execution: Execution, pos: A.Pos): Frame {
		yield this.prepared(value, execution, pos);
		const items: Value[] = [];
		for (const item of execution.properties.iterableIterator(value, pos)) {
			items.push(item);
			if (execution.clock >= 64) yield this.checkpoint();
		}
		return items;
	}
	private *arguments(nodes: (A.Expression | A.SpreadElement)[], env: Environment, execution: Execution): Frame {
		const args: Value[] = [];
		for (const arg of nodes) {
			if (arg.type === 'SpreadElement') {
				const items: Value[] = yield this.spread(yield this.evaluate(arg.argument, env, execution), execution, arg.loc.start);
				for (const item of items) { this.tick(execution, arg.loc.start); args.push(item); if (execution.clock >= 64) yield this.checkpoint(); }
			}
			else args.push(yield this.evaluate(arg, env, execution));
		}
		return args;
	}
	/** then プロパティは読まず、組み込みの then が持つ Promise の内部判定を使います。 */
	private promiseResult(value: unknown): Promise<{ value: unknown }> | null {
		if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return null;
		let resolve!: (result: { value: unknown }) => void;
		let reject!: (reason: unknown) => void;
		const result = new Promise<{ value: unknown }>((yes, no) => { resolve = yes; reject = no; });
		try { Reflect.apply(promiseThen, value, [(next: unknown) => resolve({ value: next }), reject]); }
		catch (error) {
			if (error instanceof TypeError) {
				// Promise の原型を持つ値では、constructor や species の例外を握りつぶさない。
				let prototype = Object.getPrototypeOf(value);
				while (prototype) {
					const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
					if (constructor && 'value' in constructor && typeof constructor.value === 'function' && /^function\s+Promise\s*\(\s*\)\s*\{\s*\[native code\]\s*\}$/.test(Function.prototype.toString.call(constructor.value))) throw error;
					prototype = Object.getPrototypeOf(prototype);
				}
				return null;
			}
			throw error;
		}
		return result;
	}

	private createError(args: Value[], execution: Execution, pos: A.Pos): Value {
		const error = createScriptError('Error', args.length ? this.text(args[0]!, pos) : undefined);
		const options = args[1];
		if (options !== null && (typeof options === 'object' || typeof options === 'function') && execution.properties.has(options, 'cause', pos)) {
			Object.defineProperty(error, 'cause', { value: execution.properties.get(options, 'cause', pos), configurable: true, writable: true });
		}
		return execution.properties.normalize(error, pos);
	}

	private *invoke(fn: Value, args: Value[], receiver: Value, execution: Execution, pos: A.Pos): Frame {
		this.tick(execution, pos);
		if (fn === errorConstructor) return this.createError(args, execution, pos);
		if (isStdFunction(fn)) {
			const context: StdContext = {
				pos, properties: execution.properties,
				tick: () => this.tick(execution, pos),
				checkpoint: () => this.checkpoint(),
				call: (callback, arguments_, target = null) => this.invoke(callback, arguments_, target, execution, pos),
			};
			validateArguments(context, fn[STANDARD_FUNCTION], args);
			const result = yield fn[STANDARD_FUNCTION].implementation(context, receiver, args);
			yield this.prepared(result, execution, pos);
			return execution.properties.normalize(result, pos);
		}
		if (isScriptFunction(fn)) {
			if (execution.callDepth >= this.maxCallDepth) throw runtimeError('CALL_DEPTH_EXCEEDED', pos, { limit: this.maxCallDepth }, 'RangeError');
			execution.callDepth++;
			try {
				const parameters = new Environment(fn.environment as Environment);
				for (const pattern of fn.params) for (const name of boundNames(pattern)) {
					this.tick(execution, pattern.loc.start); parameters.declare(name, true);
				}
				for (let i = 0; i < fn.params.length; i++) {
					const pattern = fn.params[i]!;
					yield this.bind(pattern, pattern.type === 'RestElement' ? scriptObject(args.slice(i)) : args[i] ?? null, parameters, execution, true);
				}
				if (fn.body.type !== 'BlockStatement') return yield this.evaluate(fn.body, parameters, execution);
				// 既定引数の閉包からは本体の宣言が見えません。
				const body = new Environment(parameters);
				const result: Completion | null = yield this.sequence(fn.body.body, body, execution);
				return result?.kind === 'return' ? result.value : null;
			} finally { execution.callDepth--; }
		}
		if (typeof fn !== 'function') throw runtimeError('NOT_CALLABLE', pos, {}, 'TypeError');
		this.checkTime(pos);
		const context: HostContext = {
			call: (callback, arguments_) => {
				this.resume();
				return this.run(this.invoke(callback, arguments_, null, execution, pos), execution, true);
			},
			signal: this.controller.signal,
		};
		const hostException = (error: unknown): never => {
			if (error instanceof ExecutionStopped || error instanceof ScriptThrown) throw error;
			throw new ScriptThrown(execution.properties.normalize(error, pos), pos, scriptErrorDiagnostic(error));
		};
		let result: unknown;
		try { result = hostBodies.has(fn) ? hostBodies.get(fn)!(args, context) : Reflect.apply(fn, receiver, args); }
		catch (error) { hostException(error); }
		this.checkTime(pos);
		let pending: Promise<{ value: unknown }> | null = null;
		try { pending = this.promiseResult(result); }
		catch (error) { hostException(error); }
		if (pending) {
			try { result = (yield { wait: pending, pos }).value; }
			catch (error) { hostException(error); }
		}
		yield this.prepared(result, execution, pos);
		return execution.properties.normalize(result, pos);
	}
	private evaluate(node: A.Statement | A.Expression, env: Environment, execution: Execution, labels: string[] = []): Frame | Ready {
		const synchronous = this.synchronous(node);
		if (synchronous) return { ready: synchronous.evaluate(env, execution) };
		this.evaluationFrameCount++;
		return this.evaluateSuspending(node, env, execution, labels);
	}

	/** 同期区間の構文は最大32ステップとし、深い構文や中断を伴う操作はスケジューラへ返します。 */
	private synchronous(node: A.Statement | A.Expression, depth = 0): Synchronous | null {
		if (depth >= 32) return null;
		if (this.synchronousNodes.has(node)) return this.synchronousNodes.get(node)!;
		const pos = node.loc.start;
		let cost = 1;
		let valid = true;
		const child = (part: A.Statement | A.Expression): Synchronous['evaluate'] => {
			const result = this.synchronous(part, depth + 1);
			if (!result) { valid = false; return () => null; }
			cost += result.cost;
			return result.evaluate;
		};
		let body: Synchronous['evaluate'] | null = null;
		switch (node.type) {
			case 'Literal': body = () => node.value; break;
			case 'Identifier': body = env => env.read(node.name, pos); break;
			case 'EmptyStatement': case 'FunctionDeclaration': body = () => null; break;
			case 'ExpressionStatement': {
				const expression = child(node.expression);
				body = (env, execution) => { expression(env, execution); return null; };
				break;
			}
			case 'BlockStatement': {
				const statements = node.body.map(child);
				for (const statement of node.body) {
					if (statement.type === 'VariableDeclaration') cost += statement.declarations.length;
					if (statement.type === 'FunctionDeclaration') cost++;
				}
				body = (env, execution) => {
					const scope = new Environment(env);
					this.prepare(node.body, scope, execution);
					for (const statement of statements) {
						const result = statement(scope, execution);
						if (result) return result;
					}
					return null;
				};
				break;
			}
			case 'VariableDeclaration': {
				if (node.declarations.some(declaration => declaration.id.type !== 'Identifier')) break;
				const declarations = node.declarations.map(declaration => ({
					id: declaration.id as A.Identifier,
					value: declaration.init ? child(declaration.init) : () => null,
				}));
				cost += declarations.length;
				body = (env, execution) => {
					for (const declaration of declarations) {
						const value = declaration.value(env, execution);
						this.tick(execution, declaration.id.loc.start);
						env.write(declaration.id.name, value, declaration.id.loc.start, true);
					}
					return null;
				};
				break;
			}
			case 'ReturnStatement': {
				const argument = node.argument ? child(node.argument) : () => null;
				body = (env, execution) => ({ kind: 'return', value: argument(env, execution), label: null } satisfies Completion);
				break;
			}
			case 'BreakStatement': case 'ContinueStatement':
				body = () => ({ kind: node.type === 'BreakStatement' ? 'break' : 'continue', value: null, label: node.label?.name ?? null } satisfies Completion);
				break;
			case 'IfStatement': {
				const test = child(node.test), consequent = child(node.consequent), alternate = node.alternate ? child(node.alternate) : () => null;
				body = (env, execution) => test(env, execution) ? consequent(env, execution) : alternate(env, execution);
				break;
			}
			case 'BinaryExpression': {
				const left = child(node.left), right = child(node.right);
				// in は配列の検証を伴うため、同期区間には含めません。
				if (node.operator === 'in') break;
				body = (env, execution) => this.binary(node.operator, left(env, execution), right(env, execution), execution, pos);
				break;
			}
			case 'LogicalExpression': {
				const left = child(node.left), right = child(node.right);
				body = (env, execution) => {
					const value = left(env, execution);
					return (node.operator === '&&' ? !value : node.operator === '||' ? !!value : value !== null) ? value : right(env, execution);
				};
				break;
			}
			case 'ConditionalExpression': {
				const test = child(node.test), consequent = child(node.consequent), alternate = child(node.alternate);
				body = (env, execution) => test(env, execution) ? consequent(env, execution) : alternate(env, execution);
				break;
			}
			case 'UnaryExpression': {
				if (node.operator === 'delete') break;
				const argument = child(node.argument);
				body = (env, execution) => {
					if (node.operator === 'typeof' && node.argument.type === 'Identifier' && !env.resolve(node.argument.name)) return 'undefined';
					const value = argument(env, execution);
					if (node.operator === '!') return !value;
					if (node.operator === 'typeof') return valueTypeof(value);
					if (typeof value !== 'number') throw runtimeError('IMPLICIT_COERCION', pos, {}, 'TypeError');
					return node.operator === '-' ? -value : +value;
				};
				break;
			}
			case 'AssignmentExpression': {
				if (node.left.type !== 'Identifier') break;
				const target = node.left;
				const right = child(node.right);
				cost++;
				body = (env, execution) => {
					this.tick(execution, target.loc.start);
					const previous = node.operator === '=' ? null : env.read(target.name, pos);
					if (node.operator === '??=' && previous !== null) return previous;
					const value = right(env, execution);
					const assigned = node.operator === '=' || node.operator === '??=' ? value : this.binary(node.operator.slice(0, -1) as A.BinaryExpression['operator'], previous, value, execution, pos);
					env.write(target.name, assigned, pos);
					return assigned;
				};
				break;
			}
			case 'UpdateExpression': {
				if (node.argument.type !== 'Identifier') break;
				const target = node.argument;
				cost++;
				body = (env, execution) => {
					this.tick(execution, target.loc.start);
					const value = env.read(target.name, pos);
					if (typeof value !== 'number') throw runtimeError('IMPLICIT_COERCION', pos, {}, 'TypeError');
					const next = value + (node.operator === '++' ? 1 : -1);
					env.write(target.name, next, pos);
					return node.prefix ? next : value;
				};
				break;
			}
		}
		const result: Synchronous | null = valid && body && cost <= 32 ? {
			cost,
			evaluate: (env, execution) => { this.tick(execution, pos); return body!(env, execution); },
		} : null;
		this.synchronousNodes.set(node, result);
		return result;
	}

	private *evaluateSuspending(node: A.Statement | A.Expression, env: Environment, execution: Execution, labels: string[] = []): Frame {
		const pos = node.loc.start;
		const properties = execution.properties;
		this.tick(execution, pos);
		switch (node.type) {
			case 'Literal': return node.value;
			case 'Identifier': return env.read(node.name, pos);
			case 'EmptyStatement': case 'FunctionDeclaration': return null;
			case 'ExpressionStatement': yield this.evaluate(node.expression, env, execution); return null;
			case 'ExportMetaDeclaration': return yield this.evaluate(node.declaration, env, execution);
			case 'BlockStatement': return yield this.sequence(node.body, new Environment(env), execution);
			case 'VariableDeclaration':
				for (const declaration of node.declarations) yield this.bind(declaration.id, declaration.init ? yield this.evaluate(declaration.init, env, execution) : null, env, execution, true);
				return null;
			case 'ArrowFunctionExpression': return this.functionValue(node, env);
			case 'ReturnStatement': return { kind: 'return', value: node.argument ? yield this.evaluate(node.argument, env, execution) : null, label: null } satisfies Completion;
			case 'BreakStatement': case 'ContinueStatement': return { kind: node.type === 'BreakStatement' ? 'break' : 'continue', value: null, label: node.label?.name ?? null } satisfies Completion;
			case 'IfStatement':
				if (yield this.evaluate(node.test, env, execution)) return yield this.evaluate(node.consequent, env, execution);
				return node.alternate ? yield this.evaluate(node.alternate, env, execution) : null;
			case 'LabeledStatement': {
				const result: Completion | null = yield this.evaluate(node.body, env, execution, [...labels, node.label.name]);
				return result?.kind === 'break' && result.label === node.label.name ? null : result;
			}
			case 'WhileStatement': case 'DoWhileStatement': {
				const test = this.synchronous(node.test);
				const body = this.synchronous(node.body);
				let first = true;
				while ((first && node.type === 'DoWhileStatement') || (test ? test.evaluate(env, execution) : yield this.evaluate(node.test, env, execution))) {
					first = false;
					const result: Completion | null = body ? body.evaluate(env, execution) : yield this.evaluate(node.body, env, execution);
					if (result) {
						if (result.kind === 'break' && (result.label === null || labels.includes(result.label))) break;
						if (result.kind !== 'continue' || (result.label !== null && !labels.includes(result.label))) return result;
					}
					if (execution.clock >= 64) yield this.checkpoint();
				}
				return null;
			}
			case 'ForStatement': {
				const test = node.test ? this.synchronous(node.test) : null;
				const body = this.synchronous(node.body);
				const update = node.update ? this.synchronous(node.update) : null;
				let loop = new Environment(env);
				if (node.init?.type === 'VariableDeclaration') this.prepare([node.init], loop, execution);
				if (node.init) yield this.evaluate(node.init, loop, execution);
				const perIteration = node.init?.type === 'VariableDeclaration' && node.init.kind === 'let';
				if (perIteration) loop = loop.iteration();
				while (!node.test || (test ? test.evaluate(loop, execution) : yield this.evaluate(node.test, loop, execution))) {
					const result: Completion | null = body ? body.evaluate(loop, execution) : yield this.evaluate(node.body, loop, execution);
					if (result) {
						if (result.kind === 'break' && (result.label === null || labels.includes(result.label))) break;
						if (result.kind !== 'continue' || (result.label !== null && !labels.includes(result.label))) return result;
					}
					if (perIteration) loop = loop.iteration();
					if (node.update) {
						if (update) update.evaluate(loop, execution);
						else yield this.evaluate(node.update, loop, execution);
					}
					if (execution.clock >= 64) yield this.checkpoint();
				}
				return null;
			}
			case 'ForOfStatement': {
				const declaration = node.left.type === 'VariableDeclaration' ? node.left : null;
				const rightScope = new Environment(env);
				if (declaration) this.prepare([declaration], rightScope, execution);
				const source: Value = yield this.evaluate(node.right, rightScope, execution);
				yield this.prepared(source, execution, pos);
				const items = Array.isArray(source) ? source : yield this.spread(source, execution, pos);
				for (let i = 0; i < items.length; i++) {
					this.tick(execution, pos);
					const scope = declaration ? new Environment(env) : env;
					if (declaration) this.prepare([declaration], scope, execution);
					yield this.bind(declaration ? declaration.declarations[0]!.id : node.left as A.Pattern | A.MemberExpression, properties.get(items, i, pos), scope, execution, !!declaration);
					const result: Completion | null = yield this.evaluate(node.body, scope, execution);
					if (result) {
						if (result.kind === 'break' && (result.label === null || labels.includes(result.label))) break;
						if (result.kind !== 'continue' || (result.label !== null && !labels.includes(result.label))) return result;
					}
				}
				return null;
			}
			case 'SwitchStatement': {
				const discriminant = yield this.evaluate(node.discriminant, env, execution);
				const scope = new Environment(env);
				this.prepare(node.cases.flatMap(c => c.consequent), scope, execution);
				let matched = -1;
				let defaultIndex = -1;
				for (let i = 0; i < node.cases.length; i++) {
					const test = node.cases[i]!.test;
					if (!test) defaultIndex = i;
					else if ((yield this.evaluate(test, scope, execution)) === discriminant) { matched = i; break; }
				}
				if (matched < 0) matched = defaultIndex;
				if (matched >= 0) for (let i = matched; i < node.cases.length; i++) {
					const result: Completion | null = yield this.sequence(node.cases[i]!.consequent, scope, execution, false);
					if (result?.kind === 'break' && result.label === null) return null;
					if (result) return result;
				}
				return null;
			}
			case 'ThrowStatement': {
				const value = yield this.evaluate(node.argument, env, execution);
				throw new ScriptThrown(value, pos, scriptErrorDiagnostic(value));
			}
			case 'TryStatement': {
				let result: Completion | null = null;
				let thrown = false;
				let error: unknown;
				try { result = yield this.evaluate(node.block, env, execution); }
				catch (caught) {
					if (caught instanceof ExecutionStopped) throw caught;
					if (node.handler) {
						try {
							const scope = new Environment(env);
							if (node.handler.param) {
								for (const name of boundNames(node.handler.param)) scope.declare(name, true);
								yield this.bind(node.handler.param, properties.normalize(caught instanceof ScriptThrown ? caught.value : caught instanceof RuntimeError ? createScriptError(caught.name, caught.message, caught) : caught, pos), scope, execution, true);
							}
							result = yield this.evaluate(node.handler.body, scope, execution);
						} catch (caughtAgain) { thrown = true; error = caughtAgain; }
					} else { thrown = true; error = caught; }
				}
				if (node.finalizer) {
					const final: Completion | null = yield this.evaluate(node.finalizer, env, execution);
					if (final) return final;
				}
				if (thrown) throw error;
				return result;
			}
			case 'ArrayExpression': {
				const result: Value[] = scriptObject([]);
				for (const element of node.elements) {
					if (!element) throw runtimeError('SPARSE_ARRAY', pos);
					if (element.type === 'SpreadElement') {
						const items: Value[] = yield this.spread(yield this.evaluate(element.argument, env, execution), execution, element.loc.start);
						for (const item of items) { this.tick(execution, element.loc.start); result.push(item); if (execution.clock >= 64) yield this.checkpoint(); }
					}
					else result.push(yield this.evaluate(element, env, execution));
				}
				return result;
			}
			case 'ObjectExpression': {
				const result = scriptObject(Object.create(null));
				for (const property of node.properties) {
					if (property.type === 'SpreadElement') {
						const source = yield this.evaluate(property.argument, env, execution);
						yield this.prepared(source, execution, property.loc.start);
						for (const [key, value] of properties.entriesIterator(source, property.loc.start)) {
							properties.set(result, key, value, property.loc.start);
							if (execution.clock >= 64) yield this.checkpoint();
						}
					} else {
						const key = property.computed ? yield this.evaluate(property.key as A.Expression, env, execution) : property.key.type === 'Identifier' ? property.key.name : (property.key as A.Literal).value;
						const validatedKey = properties.key(key, property.loc.start);
						properties.set(result, validatedKey, yield this.evaluate(property.value as A.Expression, env, execution), property.loc.start);
					}
				}
				return result;
			}
			case 'TemplateLiteral': {
				let result = node.quasis[0]!.value.cooked;
				for (let i = 0; i < node.expressions.length; i++) result = properties.concat(properties.concat(result, this.text(yield this.evaluate(node.expressions[i]!, env, execution), pos)), node.quasis[i + 1]!.value.cooked);
				return result;
			}
			case 'BinaryExpression': return this.binary(node.operator, yield this.evaluate(node.left, env, execution), yield this.evaluate(node.right, env, execution), execution, pos);
			case 'LogicalExpression': {
				const left = yield this.evaluate(node.left, env, execution);
				if (node.operator === '&&' ? !left : node.operator === '||' ? !!left : left !== null) return left;
				return yield this.evaluate(node.right, env, execution);
			}
			case 'ConditionalExpression': return yield this.evaluate((yield this.evaluate(node.test, env, execution)) ? node.consequent : node.alternate, env, execution);
			case 'AwaitExpression': return yield this.evaluate(node.argument, env, execution);
			case 'ChainExpression': {
				const result = yield this.evaluate(node.expression, env, execution);
				return result === shortCircuit ? null : result;
			}
			case 'MemberExpression': {
				const ref = yield this.reference(node, env, execution);
				return ref === shortCircuit ? shortCircuit : this.read(ref, execution, pos);
			}
			case 'CallExpression': {
				let ref: Reference | null = null;
				let fn: Value | typeof shortCircuit;
				const member = node.callee.type === 'MemberExpression' ? node.callee : node.callee.type === 'ChainExpression' && node.callee.expression.type === 'MemberExpression' ? node.callee.expression : null;
				if (member) {
					const target = yield this.reference(member, env, execution);
					if (target === shortCircuit) {
						if (node.callee.type === 'MemberExpression') return shortCircuit;
						fn = null;
					} else {
						ref = target;
						fn = this.read(target, execution, node.callee.loc.start);
					}
				} else fn = yield this.evaluate(node.callee, env, execution);
				if (fn === shortCircuit || (node.optional && fn === null)) return shortCircuit;
				const args = yield this.arguments(node.arguments, env, execution);
				if (fn === null && ref?.kind === 'property' && ['hasOwnProperty', 'propertyIsEnumerable', 'isPrototypeOf', 'toString', 'toLocaleString', 'valueOf', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'].includes(String(ref.key))) throw runtimeError('PROTOTYPE_METHOD_CALL', pos, {}, 'TypeError');
				return yield this.invoke(fn, args, ref?.kind === 'property' ? ref.object : null, execution, pos);
			}
			case 'NewExpression': {
				const constructor = env.read(node.callee.name, pos);
				const args: Value[] = yield this.arguments(node.arguments, env, execution);
				if (constructor !== errorConstructor) throw runtimeError('NOT_CALLABLE', pos, {}, 'TypeError');
				return this.createError(args, execution, pos);
			}
			case 'UnaryExpression': {
				if (node.operator === 'typeof' && node.argument.type === 'Identifier' && !env.resolve(node.argument.name)) return 'undefined';
				if (node.operator === 'delete') {
					const argument = node.argument.type === 'ChainExpression' ? node.argument.expression : node.argument;
					if (argument.type !== 'MemberExpression') { yield this.evaluate(node.argument, env, execution); return true; }
					const ref = yield this.reference(argument, env, execution);
					return ref === shortCircuit ? true : properties.delete(ref.object, ref.key, pos);
				}
				const value: Value = yield this.evaluate(node.argument, env, execution);
				if (node.operator === '!') return !value;
				if (node.operator === 'typeof') return valueTypeof(value);
				if (typeof value !== 'number') throw runtimeError('IMPLICIT_COERCION', pos, {}, 'TypeError');
				return node.operator === '-' ? -value : +value;
			}
			case 'AssignmentExpression': {
				if (node.left.type !== 'Identifier' && node.left.type !== 'MemberExpression') {
					const value = yield this.evaluate(node.right, env, execution);
					yield this.bind(node.left, value, env, execution, false);
					return value;
				}
				const ref: Reference = yield this.reference(node.left, env, execution);
				const previous = node.operator === '=' ? null : this.read(ref, execution, pos);
				if (node.operator === '??=' && previous !== null) return previous;
				const right = yield this.evaluate(node.right, env, execution);
				const value = node.operator === '=' || node.operator === '??=' ? right : this.binary(node.operator.slice(0, -1) as A.BinaryExpression['operator'], previous, right, execution, pos);
				this.write(ref, value, execution, pos);
				return value;
			}
			case 'UpdateExpression': {
				const ref: Reference = yield this.reference(node.argument, env, execution);
				const value = this.read(ref, execution, pos);
				if (typeof value !== 'number') throw runtimeError('IMPLICIT_COERCION', pos, {}, 'TypeError');
				const next = value + (node.operator === '++' ? 1 : -1);
				this.write(ref, next, execution, pos);
				return node.prefix ? next : value;
			}
		}
	}
}
