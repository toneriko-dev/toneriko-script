import { NonTonerikoScriptError, TonerikoScriptError, TonerikoScriptHostsideError, TonerikoScriptNamespaceError, TonerikoScriptRuntimeError } from "../error.js";
import { autobind } from "../utils/mini-autobind.js";
import { isStatement } from "../node.js";
import { getTypeBySource } from "../type.js";
import { nodeToJs } from "../utils/node-to-js.js";
import { Scope } from "./scope.js";
import { defaultYieldToHost, macrotaskTick } from "./host-yield.js";
import { ARR, BOOL, ERROR, FN, FN_NATIVE, NULL, NUM, OBJ, STR } from "./value.js";
import { assertArray, assertBoolean, assertFunction, assertNumber, assertObject, assertString, eq, expectAny, isArray, isFunction, isObject, reprValue } from "./util.js";
import { std } from "./lib/std.js";
import { BREAK, CONTINUE, RETURN, assertValue, isControl, unWrapLabeledBreak, unWrapRet } from "./control.js";
import { getPrimProp } from "./primitive-props.js";
import { Variable } from "./variable.js";
import { Reference, assertArrayIndex } from "./reference.js";
import __decorate from "../_virtual/_@oxc-project_runtime@0.152.0/helpers/esm/decorate.js";

//#region src/interpreter/index.ts
function createCallStack(info, parent) {
	return {
		info,
		parent,
		execution: parent?.execution ?? { stepCount: 0 }
	};
}
/**
* 時刻を見る間隔 (ノードの評価とネイティブ関数の呼び出しの回数)。1 回は数百 ns なので、64 回でも数十 µs ごとに見ることになる。
* 1 回の呼び出しの中で長くかかるネイティブ関数 (コールバックを使わない巨大な配列の処理など) は、その間は見られない。
*/
const CLOCK_CHECK_STEPS = 64;
function callStackToArray(callStack) {
	const arr = [];
	for (let node = callStack; node != null; node = node.parent) if (node.parent != null || node.info.pos != null) arr.push(node.info);
	arr.reverse();
	return arr;
}
var Interpreter = class {
	opts;
	stepCount = 0;
	stop = false;
	pausing = null;
	scope;
	abortHandlers = [];
	pauseHandlers = [];
	unpauseHandlers = [];
	vars = {};
	yieldInterval;
	yieldToHost;
	maxBusyTime;
	lastYield = performance.now();
	clockSteps = 0;
	/**
	* busy は、インタプリタが最後にホストを待って何もしていなかった時から動き続けた時間 (ms)。並行する実行や
	* map の関数の時間も合わせて数える。lastClock は前回時刻を確かめた時刻で、確かめるたびにその間の時間を busy に足す。
	* 自分が譲った後と一時停止の後は lastClock を進めて、その間を数えない。
	*
	* 何もしていなかったかは、イベントループの 1 周の境目 (マクロタスク) で見る。境目では動いている処理も積まれた
	* マイクロタスクも無いので、譲っている途中の実行 (yielding) が無ければ、どの実行もホストの何かを待っている。
	* 時刻を確かめるとき・譲った後・ホストの待ちから戻ったときに境目の確認を 1 つ予約し (idleTickPending)、
	* そこで何もしていなければ busy を 0 にして、何もしていなかったと記録する (resumedFromIdle)。
	* 何もしていない状態から戻るのは、ネイティブ関数が返した Promise の待ちが明けたとき、ネイティブ関数が渡された関数を
	* 呼び返したとき、実行が始まったとき、一時停止が解けたときなので、そこで lastClock を合わせ、何もしていなかった間を
	* 足さない (resumeFromHost)。
	* 何もしていない間は予約しないので、待つ間に CPU を使わない。作った直後は何もしていない状態から始める。
	* 譲っている途中に別の実行がホストを待ち明けた場合は数え直さない。
	*/
	busy = 0;
	lastClock = performance.now();
	yielding = 0;
	idleTickPending = false;
	resumedFromIdle = true;
	/** 名前空間の初期化式を評価する実行。exec / execSync の始めに作り直す。根なので、エラーの位置の表示はトップレベルと同じになる。 */
	nsCallStack = createCallStack({
		name: "<root>",
		pos: void 0
	}, null);
	constructor(consts, opts = {}) {
		this.opts = opts;
		const io = {
			print: FN_NATIVE(([v]) => {
				expectAny(v);
				if (this.opts.out) this.opts.out(v);
			}),
			readline: FN_NATIVE(async (args) => {
				const q = args[0];
				assertString(q);
				if (this.opts.in == null) return NULL;
				const a = await this.opts.in(q.value);
				return STR(a);
			})
		};
		this.vars = Object.fromEntries(Object.entries({
			...consts,
			...std,
			...io
		}).map(([k, v]) => [k, Variable.const(v)]));
		this.scope = new Scope(new Map(Object.entries(this.vars)));
		this.scope.opts.log = (type, params) => {
			switch (type) {
				case "add":
					this.log("var:add", params);
					break;
				case "read":
					this.log("var:read", params);
					break;
				case "write": this.log("var:write", params);
			}
		};
		this.yieldInterval = this.opts.yieldInterval ?? 8;
		if (!(this.yieldInterval >= 0)) throw new TonerikoScriptHostsideError(`Invalid yieldInterval (${this.opts.yieldInterval}): must be non-negative number`);
		this.maxBusyTime = this.opts.maxBusyTime ?? 5e3;
		if (!(this.maxBusyTime > 0)) throw new TonerikoScriptHostsideError(`Invalid maxBusyTime (${this.opts.maxBusyTime}): must be positive number`);
		this.yieldToHost = this.opts.yieldToHost ?? defaultYieldToHost;
	}
	async exec(script) {
		if (script == null || script.length === 0) return;
		try {
			this.nsCallStack = this.startExecution();
			await this.collectNs(script);
			const result = await this._run(script, this.scope, this.startExecution());
			assertValue(result);
			this.log("end", { val: result });
		} catch (e) {
			this.handleError(e);
		}
	}
	execSync(script) {
		if (script == null || script.length === 0) return;
		this.nsCallStack = this.startExecution();
		this.collectNsSync(script);
		const result = this._runSync(script, this.scope, this.startExecution());
		assertValue(result);
		return result;
	}
	/**
	* Toneriko Script の関数を実行する。err が設定されていれば abortOnError に応じて abort を実行し、
	* err を呼び出して `error<func_failed>` を返す。未設定なら例外を送出する。
	*/
	async execFn(fn, args) {
		return await this._fn(fn, args, this.startExecution()).catch((e) => {
			this.handleError(e);
			return ERROR("func_failed");
		});
	}
	execFnSync(fn, args) {
		return this._fnSync(fn, args, this.startExecution());
	}
	/** Toneriko Script の関数を実行し、エラー時に err や abort を呼ばず例外をそのまま送出する。 */
	execFnSimple(fn, args) {
		return this._fn(fn, args, this.startExecution());
	}
	static collectMetadata(script) {
		if (script == null || script.length === 0) return;
		const meta = /* @__PURE__ */ new Map();
		for (const node of script) switch (node.type) {
			case "meta": meta.set(node.name, nodeToJs(node.value));
		}
		return meta;
	}
	handleError(e) {
		if (!this.opts.err) throw e;
		if (this.opts.abortOnError) {
			if (this.stop) return;
			this.abort();
		}
		if (e instanceof TonerikoScriptError) this.opts.err(e);
		else this.opts.err(new NonTonerikoScriptError(e));
	}
	log(type, params) {
		if (this.opts.log) this.opts.log(type, params);
	}
	async collectNs(script, scope = this.scope) {
		for (const node of script) switch (node.type) {
			case "ns": await this.collectNsMember(node, scope);
		}
	}
	collectNsSync(script, scope = this.scope) {
		for (const node of script) switch (node.type) {
			case "ns": this.collectNsMemberSync(node, scope);
		}
	}
	async collectNsMember(ns, scope = this.scope) {
		const nsScope = scope.createChildNamespaceScope(ns.name);
		await this.collectNs(ns.members, nsScope);
		for (const node of ns.members) switch (node.type) {
			case "def": {
				if (node.dest.type !== "identifier") throw new TonerikoScriptNamespaceError("Destructuring assignment is invalid in namespace declarations.", node.loc.start);
				if (node.mut) throw new TonerikoScriptNamespaceError("No \"var\" in namespace declaration: " + node.dest.name, node.loc.start);
				let value = await this._eval(node.expr, nsScope, this.nsCallStack);
				assertValue(value);
				value = await this.evalAndSetAttr(node.attr, value, scope, this.nsCallStack);
				if (node.expr.type === "fn" && isFunction(value) && !value.native) value.name = nsScope.getNsPrefix() + node.dest.name;
				this.define(nsScope, node.dest, value, node.mut);
				break;
			}
			case "ns": break;
			default: {
				const nd = node;
				throw new TonerikoScriptNamespaceError("invalid ns member type: " + nd.type, nd.loc.start);
			}
		}
	}
	collectNsMemberSync(ns, scope = this.scope) {
		const nsScope = scope.createChildNamespaceScope(ns.name);
		this.collectNsSync(ns.members, nsScope);
		for (const node of ns.members) switch (node.type) {
			case "def": {
				if (node.dest.type !== "identifier") throw new TonerikoScriptNamespaceError("Destructuring assignment is invalid in namespace declarations.", node.loc.start);
				if (node.mut) throw new TonerikoScriptNamespaceError("No \"var\" in namespace declaration: " + node.dest.name, node.loc.start);
				let value = this._evalSync(node.expr, nsScope, this.nsCallStack);
				assertValue(value);
				value = this.evalAndSetAttrSync(node.attr, value, scope, this.nsCallStack);
				if (node.expr.type === "fn" && isFunction(value) && !value.native) value.name = nsScope.getNsPrefix() + node.dest.name;
				this.define(nsScope, node.dest, value, node.mut);
				break;
			}
			case "ns": break;
			default: {
				const nd = node;
				throw new TonerikoScriptNamespaceError("invalid ns member type: " + nd.type, nd.loc.start);
			}
		}
	}
	async _fn(fn, args, callStack, pos) {
		if (fn.native) {
			if (this.clockDue()) await this.onClock();
			const info = {
				name: "<native>",
				pos
			};
			const result = fn.native(args, {
				call: (fn, args) => {
					this.resumeFromHost();
					return this._fn(fn, args, createCallStack(info, callStack));
				},
				topCall: this.execFn,
				registerAbortHandler: this.registerAbortHandler,
				registerPauseHandler: this.registerPauseHandler,
				registerUnpauseHandler: this.registerUnpauseHandler,
				unregisterAbortHandler: this.unregisterAbortHandler,
				unregisterPauseHandler: this.unregisterPauseHandler,
				unregisterUnpauseHandler: this.unregisterUnpauseHandler
			});
			if (result != null && typeof result.then === "function") {
				const value = await result;
				this.resumeFromHost();
				return value ?? NULL;
			}
			return result ?? NULL;
		}
		const fnScope = fn.scope.createChildScope(/* @__PURE__ */ new Map(), void 0, fn.typeParams);
		for (const [i, param] of fn.params.entries()) {
			const arg = args[i];
			if (!param.default) expectAny(arg);
			this.define(fnScope, param.dest, arg ?? param.default, true);
		}
		const info = {
			name: fn.name ?? "<anonymous>",
			pos
		};
		return unWrapRet(await this._run(fn.statements, fnScope, createCallStack(info, callStack)));
	}
	_fnSync(fn, args, callStack, pos) {
		if (fn.native) {
			if (this.clockDue()) this.checkBusyTime(performance.now());
			const info = {
				name: "<native>",
				pos
			};
			const result = fn.nativeSync ? fn.nativeSync(args, {
				call: (fn, args) => this._fnSync(fn, args, createCallStack(info, callStack)),
				topCall: this.execFnSync,
				registerAbortHandler: this.registerAbortHandler,
				registerPauseHandler: this.registerPauseHandler,
				registerUnpauseHandler: this.registerUnpauseHandler,
				unregisterAbortHandler: this.unregisterAbortHandler,
				unregisterPauseHandler: this.unregisterPauseHandler,
				unregisterUnpauseHandler: this.unregisterUnpauseHandler
			}) : fn.native(args, {
				call: (fn, args) => this._fn(fn, args, createCallStack(info, callStack)),
				topCall: this.execFn,
				registerAbortHandler: this.registerAbortHandler,
				registerPauseHandler: this.registerPauseHandler,
				registerUnpauseHandler: this.registerUnpauseHandler,
				unregisterAbortHandler: this.unregisterAbortHandler,
				unregisterPauseHandler: this.unregisterPauseHandler,
				unregisterUnpauseHandler: this.unregisterUnpauseHandler
			});
			if (result instanceof Promise) throw new TonerikoScriptHostsideError("Native function must not return a Promise in sync mode.");
			return result ?? NULL;
		}
		const fnScope = fn.scope.createChildScope(/* @__PURE__ */ new Map(), void 0, fn.typeParams);
		for (const [i, param] of fn.params.entries()) {
			const arg = args[i];
			if (!param.default) expectAny(arg);
			this.define(fnScope, param.dest, arg ?? param.default, true);
		}
		const info = {
			name: fn.name ?? "<anonymous>",
			pos
		};
		return unWrapRet(this._runSync(fn.statements, fnScope, createCallStack(info, callStack)));
	}
	_evalClause(node, scope, callStack) {
		return this._eval(node, isStatement(node) ? scope.createChildScope() : scope, callStack);
	}
	_evalClauseSync(node, scope, callStack) {
		return this._evalSync(node, isStatement(node) ? scope.createChildScope() : scope, callStack);
	}
	async _evalBinaryOperation(op, leftExpr, rightExpr, scope, callStack) {
		const callee = scope.get(op);
		assertFunction(callee);
		const left = await this._eval(leftExpr, scope, callStack);
		if (isControl(left)) return left;
		const right = await this._eval(rightExpr, scope, callStack);
		if (isControl(right)) return right;
		return this._fn(callee, [left, right], callStack);
	}
	_evalBinaryOperationSync(op, leftExpr, rightExpr, scope, callStack) {
		const callee = scope.get(op);
		assertFunction(callee);
		const left = this._evalSync(leftExpr, scope, callStack);
		if (isControl(left)) return left;
		const right = this._evalSync(rightExpr, scope, callStack);
		if (isControl(right)) return right;
		return this._fnSync(callee, [left, right], callStack);
	}
	_eval(node, scope, callStack) {
		return this.__eval(node, scope, callStack).catch((e) => {
			if (e.pos) throw e;
			else {
				const e2 = e instanceof TonerikoScriptError ? e : new NonTonerikoScriptError(e);
				e2.pos = node.loc.start;
				const callStackArray = callStackToArray(callStack);
				e2.message = [e2.message, ...[...callStackArray, { pos: e2.pos }].map(({ pos }, i) => {
					const name = callStackArray[i - 1]?.name ?? "<root>";
					return pos ? `  at ${name} (Line ${pos.line}, Column ${pos.column})` : `  at ${name}`;
				}).reverse()].join("\n");
				throw e2;
			}
		});
	}
	/** CLOCK_CHECK_STEPS 回に 1 回 true を返す。 */
	clockDue() {
		if (++this.clockSteps < CLOCK_CHECK_STEPS) return false;
		this.clockSteps = 0;
		return true;
	}
	/** 動いた時間を確かめ、yieldInterval を過ぎていればホストに譲る。 */
	async onClock() {
		const now = performance.now();
		this.checkBusyTime(now);
		if (this.yieldInterval !== 0 && now - this.lastYield >= this.yieldInterval) {
			this.yielding++;
			try {
				await this.yieldToHost();
			} finally {
				this.yielding--;
			}
			this.lastYield = performance.now();
			this.lastClock = this.lastYield;
			this.armIdleTick();
		}
	}
	startExecution() {
		this.resumeFromHost();
		return createCallStack({
			name: "<root>",
			pos: void 0
		}, null);
	}
	/** 一時停止していた時間は、何もしていなかったと確かめられなくても動いた時間に数えない。 */
	resumeFromPause() {
		this.resumeFromHost();
		this.lastClock = performance.now();
	}
	/**
	* ホストを待った後や実行の始めに呼ぶ。何もしていなかった状態から戻ったなら、ここから数え、譲るまでの時間も数え直す。
	* 別の実行が譲っている間に始まった実行 (Async:interval の関数など) は、譲っていた間のホストの時間 (描画など) も
	* 数える。その間かどうかを、マイクロタスクで並行して進む処理 (sort の比較など) と確実には見分けられないため。
	* このとき止まるのは、描画の時間を含めて maxBusyTime を超えて動き続けた場合だけで、暴走を見逃す方向には働かない。
	*/
	resumeFromHost() {
		if (this.resumedFromIdle) {
			this.resumedFromIdle = false;
			this.lastClock = performance.now();
			this.lastYield = this.lastClock;
		}
		this.armIdleTick();
	}
	/** 前回の確認からの時間を busy に足し、ホストを待たずに maxBusyTime を超えて動いたら止める。 */
	checkBusyTime(now) {
		if (this.resumedFromIdle) this.resumedFromIdle = false;
		else this.busy += now - this.lastClock;
		this.lastClock = now;
		this.armIdleTick();
		if (this.busy > this.maxBusyTime) throw new TonerikoScriptRuntimeError(`busy time exceeded: ran for more than ${this.maxBusyTime} ms without waiting`);
	}
	/** 次のマクロタスクの境目で、インタプリタが何もせずホストを待っているかを確かめる。 */
	armIdleTick() {
		if (this.idleTickPending) return;
		this.idleTickPending = true;
		macrotaskTick().then(() => {
			this.idleTickPending = false;
			if (this.yielding === 0) {
				this.busy = 0;
				this.resumedFromIdle = true;
			}
		});
	}
	_evalSync(node, scope, callStack) {
		return this.__evalSync(node, scope, callStack);
	}
	async __eval(node, scope, callStack) {
		if (this.stop) return NULL;
		if (this.pausing) {
			await this.pausing.promise;
			this.resumeFromPause();
		}
		if (this.clockDue()) await this.onClock();
		this.stepCount++;
		if (callStack != null) callStack.execution.stepCount++;
		if (this.opts.maxStep && (callStack?.execution.stepCount ?? this.stepCount) > this.opts.maxStep) throw new TonerikoScriptRuntimeError("max step exceeded");
		switch (node.type) {
			case "call": {
				const callee = await this._eval(node.target, scope, callStack);
				if (isControl(callee)) return callee;
				assertFunction(callee);
				const args = [];
				for (const expr of node.args) {
					const arg = await this._eval(expr, scope, callStack);
					if (isControl(arg)) return arg;
					args.push(arg);
				}
				return this._fn(callee, args, callStack, node.loc.start);
			}
			case "if": {
				const cond = await this._eval(node.cond, scope, callStack);
				if (isControl(cond)) return cond;
				assertBoolean(cond);
				if (cond.value) return unWrapLabeledBreak(await this._evalClause(node.then, scope, callStack), node.label);
				for (const elseif of node.elseif) {
					const cond = await this._eval(elseif.cond, scope, callStack);
					if (isControl(cond)) return cond;
					assertBoolean(cond);
					if (cond.value) return unWrapLabeledBreak(await this._evalClause(elseif.then, scope, callStack), node.label);
				}
				if (node.else) return unWrapLabeledBreak(await this._evalClause(node.else, scope, callStack), node.label);
				return NULL;
			}
			case "match": {
				const about = await this._eval(node.about, scope, callStack);
				if (isControl(about)) return about;
				for (const qa of node.qs) {
					const q = await this._eval(qa.q, scope, callStack);
					if (isControl(q)) return q;
					if (eq(about, q)) {
						if (qa.guard) {
							const guard = await this._eval(qa.guard, scope, callStack);
							if (isControl(guard)) return guard;
							assertBoolean(guard);
							if (!guard.value) continue;
						}
						return unWrapLabeledBreak(await this._evalClause(qa.a, scope, callStack), node.label);
					}
				}
				if (node.default) return unWrapLabeledBreak(await this._evalClause(node.default, scope, callStack), node.label);
				return NULL;
			}
			case "loop":
				while (true) {
					if (this.stop) return NULL;
					if (this.pausing) {
						await this.pausing.promise;
						this.resumeFromPause();
					}
					if (this.clockDue()) await this.onClock();
					const v = await this._run(node.statements, scope.createChildScope(), callStack);
					if (v.type === "break") {
						if (v.label != null && v.label !== node.label) return v;
						break;
					} else if (v.type === "continue") {
						if (v.label != null && v.label !== node.label) return v;
					} else if (v.type === "return") return v;
				}
				return NULL;
			case "for":
				if (node.times) {
					const times = await this._eval(node.times, scope, callStack);
					if (isControl(times)) return times;
					assertNumber(times);
					for (let i = 0; i < times.value; i++) {
						const v = await this._evalClause(node.for, scope, callStack);
						if (v.type === "break") {
							if (v.label != null && v.label !== node.label) return v;
							break;
						} else if (v.type === "continue") {
							if (v.label != null && v.label !== node.label) return v;
						} else if (v.type === "return") return v;
					}
				} else {
					const from = await this._eval(node.from, scope, callStack);
					if (isControl(from)) return from;
					const to = await this._eval(node.to, scope, callStack);
					if (isControl(to)) return to;
					assertNumber(from);
					assertNumber(to);
					let step = NUM(1);
					if (node.step) {
						const stepValue = await this._eval(node.step, scope, callStack);
						if (isControl(stepValue)) return stepValue;
						assertNumber(stepValue);
						step = stepValue;
					}
					let i = from.value;
					for (let n = 0; n < to.value; n++, i += step.value) {
						const v = await this._eval(node.for, scope.createChildScope(/* @__PURE__ */ new Map([[node.var, {
							isMutable: false,
							value: NUM(i)
						}]])), callStack);
						if (v.type === "break") {
							if (v.label != null && v.label !== node.label) return v;
							break;
						} else if (v.type === "continue") {
							if (v.label != null && v.label !== node.label) return v;
						} else if (v.type === "return") return v;
					}
				}
				return NULL;
			case "each": {
				const items = await this._eval(node.items, scope, callStack);
				if (isControl(items)) return items;
				assertArray(items);
				for (const item of items.value) {
					let eachScope;
					if (node.var.type === "identifier") eachScope = scope.createChildScope(/* @__PURE__ */ new Map([[node.var.name, {
						isMutable: false,
						value: item
					}]]));
					else {
						eachScope = scope.createChildScope();
						this.define(eachScope, node.var, item, false);
					}
					const v = await this._eval(node.for, eachScope, callStack);
					if (v.type === "break") {
						if (v.label != null && v.label !== node.label) return v;
						break;
					} else if (v.type === "continue") {
						if (v.label != null && v.label !== node.label) return v;
					} else if (v.type === "return") return v;
				}
				return NULL;
			}
			case "def": {
				let value = await this._eval(node.expr, scope, callStack);
				if (isControl(value)) return value;
				value = await this.evalAndSetAttr(node.attr, value, scope, callStack);
				if (node.expr.type === "fn" && node.dest.type === "identifier" && isFunction(value) && !value.native) value.name = node.dest.name;
				this.define(scope, node.dest, value, node.mut);
				return NULL;
			}
			case "identifier": return scope.get(node.name);
			case "assign": {
				const target = await this.getReference(node.dest, scope, callStack);
				if (isControl(target)) return target;
				const v = await this._eval(node.expr, scope, callStack);
				if (isControl(v)) return v;
				target.set(v);
				return NULL;
			}
			case "addAssign": {
				if (node.dest.type === "identifier") {
					const v = await this._eval(node.expr, scope, callStack);
					if (isControl(v)) return v;
					assertNumber(v);
					scope.update(node.dest.name, (current) => {
						assertNumber(current);
						return NUM(current.value + v.value);
					});
					return NULL;
				}
				const target = await this.getReference(node.dest, scope, callStack);
				if (isControl(target)) return target;
				const v = await this._eval(node.expr, scope, callStack);
				if (isControl(v)) return v;
				assertNumber(v);
				const targetValue = target.get();
				assertNumber(targetValue);
				target.set(NUM(targetValue.value + v.value));
				return NULL;
			}
			case "subAssign": {
				if (node.dest.type === "identifier") {
					const v = await this._eval(node.expr, scope, callStack);
					if (isControl(v)) return v;
					assertNumber(v);
					scope.update(node.dest.name, (current) => {
						assertNumber(current);
						return NUM(current.value - v.value);
					});
					return NULL;
				}
				const target = await this.getReference(node.dest, scope, callStack);
				if (isControl(target)) return target;
				const v = await this._eval(node.expr, scope, callStack);
				if (isControl(v)) return v;
				assertNumber(v);
				const targetValue = target.get();
				assertNumber(targetValue);
				target.set(NUM(targetValue.value - v.value));
				return NULL;
			}
			case "null": return NULL;
			case "bool": return BOOL(node.value);
			case "num": return NUM(node.value);
			case "str": return STR(node.value);
			case "arr": {
				const value = [];
				for (const item of node.value) {
					const valueItem = await this._eval(item, scope, callStack);
					if (isControl(valueItem)) return valueItem;
					value.push(valueItem);
				}
				return ARR(value);
			}
			case "obj": {
				const obj = /* @__PURE__ */ new Map();
				for (const [key, valueExpr] of node.value) {
					const value = await this._eval(valueExpr, scope, callStack);
					if (isControl(value)) return value;
					obj.set(key, value);
				}
				return OBJ(obj);
			}
			case "prop": {
				const target = await this._eval(node.target, scope, callStack);
				if (isControl(target)) return target;
				if (isObject(target)) {
					if (target.value.has(node.name)) return target.value.get(node.name);
					return NULL;
				}
				return getPrimProp(target, node.name);
			}
			case "index": {
				const target = await this._eval(node.target, scope, callStack);
				if (isControl(target)) return target;
				const i = await this._eval(node.index, scope, callStack);
				if (isControl(i)) return i;
				if (isArray(target)) {
					assertNumber(i);
					assertArrayIndex(i.value, target.value.length);
					return target.value[i.value];
				} else if (isObject(target)) {
					assertString(i);
					if (target.value.has(i.value)) return target.value.get(i.value);
					return NULL;
				}
				throw new TonerikoScriptRuntimeError(`Cannot read prop (${reprValue(i)}) of ${target.type}.`);
			}
			case "plus": {
				const v = await this._eval(node.expr, scope, callStack);
				if (isControl(v)) return v;
				assertNumber(v);
				return v;
			}
			case "minus": {
				const v = await this._eval(node.expr, scope, callStack);
				if (isControl(v)) return v;
				assertNumber(v);
				return NUM(-v.value);
			}
			case "not": {
				const v = await this._eval(node.expr, scope, callStack);
				if (isControl(v)) return v;
				assertBoolean(v);
				return BOOL(!v.value);
			}
			case "fn": {
				const typeParams = [...node.typeParams, ...scope.getTypeParams()];
				const defaultScope = node.typeParams.length > 0 ? scope.createChildScope(/* @__PURE__ */ new Map(), void 0, node.typeParams) : scope;
				const params = await Promise.all(node.params.map(async (param) => {
					return {
						dest: param.dest,
						default: param.default ? await this._eval(param.default, defaultScope, callStack) : param.optional ? NULL : void 0,
						type: param.argType ? getTypeBySource(param.argType, typeParams) : void 0
					};
				}));
				for (const param of params) if (param.default != null && isControl(param.default)) return param.default;
				return FN(params, node.children, scope, node.typeParams);
			}
			case "block": return unWrapLabeledBreak(await this._run(node.statements, scope.createChildScope(), callStack), node.label);
			case "exists": return BOOL(scope.exists(node.identifier.name));
			case "tmpl": {
				let str = "";
				for (const x of node.tmpl) if (typeof x === "string") str += x;
				else {
					const v = await this._eval(x, scope, callStack);
					if (isControl(v)) return v;
					str += reprValue(v);
				}
				return STR(str);
			}
			case "return": {
				const val = await this._eval(node.expr, scope, callStack);
				if (isControl(val)) return val;
				this.log("block:return", {
					scope: scope.name,
					val
				});
				return RETURN(val);
			}
			case "break": {
				let val;
				if (node.expr != null) {
					const valueOrControl = await this._eval(node.expr, scope, callStack);
					if (isControl(valueOrControl)) return valueOrControl;
					val = valueOrControl;
				}
				this.log("block:break", { scope: scope.name });
				return BREAK(node.label, val);
			}
			case "continue":
				this.log("block:continue", { scope: scope.name });
				return CONTINUE(node.label);
			case "ns": return NULL;
			case "meta": return NULL;
			case "pow": return this._evalBinaryOperation("Core:pow", node.left, node.right, scope, callStack);
			case "mul": return this._evalBinaryOperation("Core:mul", node.left, node.right, scope, callStack);
			case "div": return this._evalBinaryOperation("Core:div", node.left, node.right, scope, callStack);
			case "rem": return this._evalBinaryOperation("Core:mod", node.left, node.right, scope, callStack);
			case "add": return this._evalBinaryOperation("Core:add", node.left, node.right, scope, callStack);
			case "sub": return this._evalBinaryOperation("Core:sub", node.left, node.right, scope, callStack);
			case "lt": return this._evalBinaryOperation("Core:lt", node.left, node.right, scope, callStack);
			case "lteq": return this._evalBinaryOperation("Core:lteq", node.left, node.right, scope, callStack);
			case "gt": return this._evalBinaryOperation("Core:gt", node.left, node.right, scope, callStack);
			case "gteq": return this._evalBinaryOperation("Core:gteq", node.left, node.right, scope, callStack);
			case "eq": return this._evalBinaryOperation("Core:eq", node.left, node.right, scope, callStack);
			case "neq": return this._evalBinaryOperation("Core:neq", node.left, node.right, scope, callStack);
			case "and": {
				const leftValue = await this._eval(node.left, scope, callStack);
				if (isControl(leftValue)) return leftValue;
				assertBoolean(leftValue);
				if (!leftValue.value) return leftValue;
				const rightValue = await this._eval(node.right, scope, callStack);
				if (isControl(rightValue)) return rightValue;
				assertBoolean(rightValue);
				return rightValue;
			}
			case "or": {
				const leftValue = await this._eval(node.left, scope, callStack);
				if (isControl(leftValue)) return leftValue;
				assertBoolean(leftValue);
				if (leftValue.value) return leftValue;
				const rightValue = await this._eval(node.right, scope, callStack);
				if (isControl(rightValue)) return rightValue;
				assertBoolean(rightValue);
				return rightValue;
			}
			case "namedTypeSource":
			case "fnTypeSource":
			case "unionTypeSource":
			case "attr": throw new Error("invalid node type");
			default: throw new Error("invalid node type");
		}
	}
	__evalSync(node, scope, callStack) {
		if (this.stop) return NULL;
		if (this.clockDue()) this.checkBusyTime(performance.now());
		this.stepCount++;
		if (callStack != null) callStack.execution.stepCount++;
		if (this.opts.maxStep && (callStack?.execution.stepCount ?? this.stepCount) > this.opts.maxStep) throw new TonerikoScriptRuntimeError("max step exceeded");
		switch (node.type) {
			case "call": {
				const callee = this._evalSync(node.target, scope, callStack);
				if (isControl(callee)) return callee;
				assertFunction(callee);
				const args = [];
				for (const expr of node.args) {
					const arg = this._evalSync(expr, scope, callStack);
					if (isControl(arg)) return arg;
					args.push(arg);
				}
				return this._fnSync(callee, args, callStack, node.loc.start);
			}
			case "if": {
				const cond = this._evalSync(node.cond, scope, callStack);
				if (isControl(cond)) return cond;
				assertBoolean(cond);
				if (cond.value) return unWrapLabeledBreak(this._evalClauseSync(node.then, scope, callStack), node.label);
				for (const elseif of node.elseif) {
					const cond = this._evalSync(elseif.cond, scope, callStack);
					if (isControl(cond)) return cond;
					assertBoolean(cond);
					if (cond.value) return unWrapLabeledBreak(this._evalClauseSync(elseif.then, scope, callStack), node.label);
				}
				if (node.else) return unWrapLabeledBreak(this._evalClauseSync(node.else, scope, callStack), node.label);
				return NULL;
			}
			case "match": {
				const about = this._evalSync(node.about, scope, callStack);
				if (isControl(about)) return about;
				for (const qa of node.qs) {
					const q = this._evalSync(qa.q, scope, callStack);
					if (isControl(q)) return q;
					if (eq(about, q)) {
						if (qa.guard) {
							const guard = this._evalSync(qa.guard, scope, callStack);
							if (isControl(guard)) return guard;
							assertBoolean(guard);
							if (!guard.value) continue;
						}
						return unWrapLabeledBreak(this._evalClauseSync(qa.a, scope, callStack), node.label);
					}
				}
				if (node.default) return unWrapLabeledBreak(this._evalClauseSync(node.default, scope, callStack), node.label);
				return NULL;
			}
			case "loop":
				while (true) {
					if (this.stop) return NULL;
					if (this.clockDue()) this.checkBusyTime(performance.now());
					const v = this._runSync(node.statements, scope.createChildScope(), callStack);
					if (v.type === "break") {
						if (v.label != null && v.label !== node.label) return v;
						break;
					} else if (v.type === "continue") {
						if (v.label != null && v.label !== node.label) return v;
					} else if (v.type === "return") return v;
				}
				return NULL;
			case "for":
				if (node.times) {
					const times = this._evalSync(node.times, scope, callStack);
					if (isControl(times)) return times;
					assertNumber(times);
					for (let i = 0; i < times.value; i++) {
						const v = this._evalClauseSync(node.for, scope, callStack);
						if (v.type === "break") {
							if (v.label != null && v.label !== node.label) return v;
							break;
						} else if (v.type === "continue") {
							if (v.label != null && v.label !== node.label) return v;
						} else if (v.type === "return") return v;
					}
				} else {
					const from = this._evalSync(node.from, scope, callStack);
					if (isControl(from)) return from;
					const to = this._evalSync(node.to, scope, callStack);
					if (isControl(to)) return to;
					assertNumber(from);
					assertNumber(to);
					let step = NUM(1);
					if (node.step) {
						const stepValue = this._evalSync(node.step, scope, callStack);
						if (isControl(stepValue)) return stepValue;
						assertNumber(stepValue);
						step = stepValue;
					}
					let i = from.value;
					for (let n = 0; n < to.value; n++, i += step.value) {
						const v = this._evalSync(node.for, scope.createChildScope(/* @__PURE__ */ new Map([[node.var, {
							isMutable: false,
							value: NUM(i)
						}]])), callStack);
						if (v.type === "break") {
							if (v.label != null && v.label !== node.label) return v;
							break;
						} else if (v.type === "continue") {
							if (v.label != null && v.label !== node.label) return v;
						} else if (v.type === "return") return v;
					}
				}
				return NULL;
			case "each": {
				const items = this._evalSync(node.items, scope, callStack);
				if (isControl(items)) return items;
				assertArray(items);
				for (const item of items.value) {
					let eachScope;
					if (node.var.type === "identifier") eachScope = scope.createChildScope(/* @__PURE__ */ new Map([[node.var.name, {
						isMutable: false,
						value: item
					}]]));
					else {
						eachScope = scope.createChildScope();
						this.define(eachScope, node.var, item, false);
					}
					const v = this._evalSync(node.for, eachScope, callStack);
					if (v.type === "break") {
						if (v.label != null && v.label !== node.label) return v;
						break;
					} else if (v.type === "continue") {
						if (v.label != null && v.label !== node.label) return v;
					} else if (v.type === "return") return v;
				}
				return NULL;
			}
			case "def": {
				let value = this._evalSync(node.expr, scope, callStack);
				if (isControl(value)) return value;
				value = this.evalAndSetAttrSync(node.attr, value, scope, callStack);
				if (node.expr.type === "fn" && node.dest.type === "identifier" && isFunction(value) && !value.native) value.name = node.dest.name;
				this.define(scope, node.dest, value, node.mut);
				return NULL;
			}
			case "identifier": return scope.get(node.name);
			case "assign": {
				const target = this.getReferenceSync(node.dest, scope, callStack);
				if (isControl(target)) return target;
				const v = this._evalSync(node.expr, scope, callStack);
				if (isControl(v)) return v;
				target.set(v);
				return NULL;
			}
			case "addAssign": {
				if (node.dest.type === "identifier") {
					const v = this._evalSync(node.expr, scope, callStack);
					if (isControl(v)) return v;
					assertNumber(v);
					scope.update(node.dest.name, (current) => {
						assertNumber(current);
						return NUM(current.value + v.value);
					});
					return NULL;
				}
				const target = this.getReferenceSync(node.dest, scope, callStack);
				if (isControl(target)) return target;
				const v = this._evalSync(node.expr, scope, callStack);
				if (isControl(v)) return v;
				assertNumber(v);
				const targetValue = target.get();
				assertNumber(targetValue);
				target.set(NUM(targetValue.value + v.value));
				return NULL;
			}
			case "subAssign": {
				if (node.dest.type === "identifier") {
					const v = this._evalSync(node.expr, scope, callStack);
					if (isControl(v)) return v;
					assertNumber(v);
					scope.update(node.dest.name, (current) => {
						assertNumber(current);
						return NUM(current.value - v.value);
					});
					return NULL;
				}
				const target = this.getReferenceSync(node.dest, scope, callStack);
				if (isControl(target)) return target;
				const v = this._evalSync(node.expr, scope, callStack);
				if (isControl(v)) return v;
				assertNumber(v);
				const targetValue = target.get();
				assertNumber(targetValue);
				target.set(NUM(targetValue.value - v.value));
				return NULL;
			}
			case "null": return NULL;
			case "bool": return BOOL(node.value);
			case "num": return NUM(node.value);
			case "str": return STR(node.value);
			case "arr": {
				const value = [];
				for (const item of node.value) {
					const valueItem = this._evalSync(item, scope, callStack);
					if (isControl(valueItem)) return valueItem;
					value.push(valueItem);
				}
				return ARR(value);
			}
			case "obj": {
				const obj = /* @__PURE__ */ new Map();
				for (const [key, valueExpr] of node.value) {
					const value = this._evalSync(valueExpr, scope, callStack);
					if (isControl(value)) return value;
					obj.set(key, value);
				}
				return OBJ(obj);
			}
			case "prop": {
				const target = this._evalSync(node.target, scope, callStack);
				if (isControl(target)) return target;
				if (isObject(target)) {
					if (target.value.has(node.name)) return target.value.get(node.name);
					return NULL;
				}
				return getPrimProp(target, node.name);
			}
			case "index": {
				const target = this._evalSync(node.target, scope, callStack);
				if (isControl(target)) return target;
				const i = this._evalSync(node.index, scope, callStack);
				if (isControl(i)) return i;
				if (isArray(target)) {
					assertNumber(i);
					assertArrayIndex(i.value, target.value.length);
					return target.value[i.value];
				} else if (isObject(target)) {
					assertString(i);
					if (target.value.has(i.value)) return target.value.get(i.value);
					return NULL;
				}
				throw new TonerikoScriptRuntimeError(`Cannot read prop (${reprValue(i)}) of ${target.type}.`);
			}
			case "plus": {
				const v = this._evalSync(node.expr, scope, callStack);
				if (isControl(v)) return v;
				assertNumber(v);
				return v;
			}
			case "minus": {
				const v = this._evalSync(node.expr, scope, callStack);
				if (isControl(v)) return v;
				assertNumber(v);
				return NUM(-v.value);
			}
			case "not": {
				const v = this._evalSync(node.expr, scope, callStack);
				if (isControl(v)) return v;
				assertBoolean(v);
				return BOOL(!v.value);
			}
			case "fn": {
				const typeParams = [...node.typeParams, ...scope.getTypeParams()];
				const defaultScope = node.typeParams.length > 0 ? scope.createChildScope(/* @__PURE__ */ new Map(), void 0, node.typeParams) : scope;
				const params = node.params.map((param) => {
					return {
						dest: param.dest,
						default: param.default ? this._evalSync(param.default, defaultScope, callStack) : param.optional ? NULL : void 0,
						type: param.argType ? getTypeBySource(param.argType, typeParams) : void 0
					};
				});
				for (const param of params) if (param.default != null && isControl(param.default)) return param.default;
				return FN(params, node.children, scope, node.typeParams);
			}
			case "block": return unWrapLabeledBreak(this._runSync(node.statements, scope.createChildScope(), callStack), node.label);
			case "exists": return BOOL(scope.exists(node.identifier.name));
			case "tmpl": {
				let str = "";
				for (const x of node.tmpl) if (typeof x === "string") str += x;
				else {
					const v = this._evalSync(x, scope, callStack);
					if (isControl(v)) return v;
					str += reprValue(v);
				}
				return STR(str);
			}
			case "return": {
				const val = this._evalSync(node.expr, scope, callStack);
				if (isControl(val)) return val;
				this.log("block:return", {
					scope: scope.name,
					val
				});
				return RETURN(val);
			}
			case "break": {
				let val;
				if (node.expr != null) {
					const valueOrControl = this._evalSync(node.expr, scope, callStack);
					if (isControl(valueOrControl)) return valueOrControl;
					val = valueOrControl;
				}
				this.log("block:break", { scope: scope.name });
				return BREAK(node.label, val);
			}
			case "continue":
				this.log("block:continue", { scope: scope.name });
				return CONTINUE(node.label);
			case "ns": return NULL;
			case "meta": return NULL;
			case "pow": return this._evalBinaryOperationSync("Core:pow", node.left, node.right, scope, callStack);
			case "mul": return this._evalBinaryOperationSync("Core:mul", node.left, node.right, scope, callStack);
			case "div": return this._evalBinaryOperationSync("Core:div", node.left, node.right, scope, callStack);
			case "rem": return this._evalBinaryOperationSync("Core:mod", node.left, node.right, scope, callStack);
			case "add": return this._evalBinaryOperationSync("Core:add", node.left, node.right, scope, callStack);
			case "sub": return this._evalBinaryOperationSync("Core:sub", node.left, node.right, scope, callStack);
			case "lt": return this._evalBinaryOperationSync("Core:lt", node.left, node.right, scope, callStack);
			case "lteq": return this._evalBinaryOperationSync("Core:lteq", node.left, node.right, scope, callStack);
			case "gt": return this._evalBinaryOperationSync("Core:gt", node.left, node.right, scope, callStack);
			case "gteq": return this._evalBinaryOperationSync("Core:gteq", node.left, node.right, scope, callStack);
			case "eq": return this._evalBinaryOperationSync("Core:eq", node.left, node.right, scope, callStack);
			case "neq": return this._evalBinaryOperationSync("Core:neq", node.left, node.right, scope, callStack);
			case "and": {
				const leftValue = this._evalSync(node.left, scope, callStack);
				if (isControl(leftValue)) return leftValue;
				assertBoolean(leftValue);
				if (!leftValue.value) return leftValue;
				const rightValue = this._evalSync(node.right, scope, callStack);
				if (isControl(rightValue)) return rightValue;
				assertBoolean(rightValue);
				return rightValue;
			}
			case "or": {
				const leftValue = this._evalSync(node.left, scope, callStack);
				if (isControl(leftValue)) return leftValue;
				assertBoolean(leftValue);
				if (leftValue.value) return leftValue;
				const rightValue = this._evalSync(node.right, scope, callStack);
				if (isControl(rightValue)) return rightValue;
				assertBoolean(rightValue);
				return rightValue;
			}
			case "namedTypeSource":
			case "fnTypeSource":
			case "unionTypeSource":
			case "attr": throw new Error("invalid node type");
			default: throw new Error("invalid node type");
		}
	}
	async _run(program, scope, callStack) {
		this.log("block:enter", { scope: scope.name });
		let v = NULL;
		for (let i = 0; i < program.length; i++) {
			const node = program[i];
			v = await this._eval(node, scope, callStack);
			if (v.type === "return") {
				this.log("block:return", {
					scope: scope.name,
					val: v.value
				});
				return v;
			} else if (v.type === "break") {
				this.log("block:break", { scope: scope.name });
				return v;
			} else if (v.type === "continue") {
				this.log("block:continue", { scope: scope.name });
				return v;
			}
		}
		this.log("block:leave", {
			scope: scope.name,
			val: v
		});
		return v;
	}
	_runSync(program, scope, callStack) {
		this.log("block:enter", { scope: scope.name });
		let v = NULL;
		for (let i = 0; i < program.length; i++) {
			const node = program[i];
			v = this._evalSync(node, scope, callStack);
			if (v.type === "return") {
				this.log("block:return", {
					scope: scope.name,
					val: v.value
				});
				return v;
			} else if (v.type === "break") {
				this.log("block:break", { scope: scope.name });
				return v;
			} else if (v.type === "continue") {
				this.log("block:continue", { scope: scope.name });
				return v;
			}
		}
		this.log("block:leave", {
			scope: scope.name,
			val: v
		});
		return v;
	}
	registerAbortHandler(handler) {
		this.abortHandlers.push(handler);
	}
	registerPauseHandler(handler) {
		this.pauseHandlers.push(handler);
	}
	registerUnpauseHandler(handler) {
		this.unpauseHandlers.push(handler);
	}
	unregisterAbortHandler(handler) {
		this.abortHandlers = this.abortHandlers.filter((h) => h !== handler);
	}
	unregisterPauseHandler(handler) {
		this.pauseHandlers = this.pauseHandlers.filter((h) => h !== handler);
	}
	unregisterUnpauseHandler(handler) {
		this.unpauseHandlers = this.unpauseHandlers.filter((h) => h !== handler);
	}
	abort() {
		this.stop = true;
		for (const handler of this.abortHandlers) handler();
		this.abortHandlers = [];
	}
	pause() {
		if (this.pausing) return;
		let resolve;
		const promise = new Promise((r) => {
			resolve = () => r();
		});
		this.pausing = {
			promise,
			resolve
		};
		for (const handler of this.pauseHandlers) handler();
		this.pauseHandlers = [];
	}
	unpause() {
		if (!this.pausing) return;
		this.pausing.resolve();
		this.pausing = null;
		for (const handler of this.unpauseHandlers) handler();
		this.unpauseHandlers = [];
	}
	async evalAndSetAttr(attr, value, scope, callStack) {
		if (attr.length > 0) {
			const attrs = [];
			for (const nAttr of attr) {
				const attrValue = await this._eval(nAttr.value, scope, callStack);
				assertValue(attrValue);
				attrs.push({
					name: nAttr.name,
					value: attrValue
				});
			}
			return {
				...value,
				attr: attrs
			};
		}
		return value;
	}
	evalAndSetAttrSync(attr, value, scope, callStack) {
		if (attr.length > 0) {
			const attrs = [];
			for (const nAttr of attr) {
				const attrValue = this._evalSync(nAttr.value, scope, callStack);
				assertValue(attrValue);
				attrs.push({
					name: nAttr.name,
					value: attrValue
				});
			}
			return {
				...value,
				attr: attrs
			};
		}
		return value;
	}
	define(scope, dest, value, isMutable) {
		switch (dest.type) {
			case "identifier":
				scope.add(dest.name, {
					isMutable,
					value
				});
				break;
			case "arr":
				assertArray(value);
				dest.value.forEach((item, index) => this.define(scope, item, value.value[index] ?? NULL, isMutable));
				break;
			case "obj":
				assertObject(value);
				for (const [key, item] of dest.value) this.define(scope, item, value.value.get(key) ?? NULL, isMutable);
				break;
			default: throw new TonerikoScriptRuntimeError("The left-hand side of an definition expression must be a variable.");
		}
	}
	async getReference(dest, scope, callStack) {
		switch (dest.type) {
			case "identifier": return Reference.variable(dest.name, scope);
			case "index": {
				const assignee = await this._eval(dest.target, scope, callStack);
				if (isControl(assignee)) return assignee;
				const i = await this._eval(dest.index, scope, callStack);
				if (isControl(i)) return i;
				if (isArray(assignee)) {
					assertNumber(i);
					return Reference.index(assignee, i.value);
				} else if (isObject(assignee)) {
					assertString(i);
					return Reference.prop(assignee, i.value);
				}
				throw new TonerikoScriptRuntimeError(`Cannot read prop (${reprValue(i)}) of ${assignee.type}.`);
			}
			case "prop": {
				const assignee = await this._eval(dest.target, scope, callStack);
				if (isControl(assignee)) return assignee;
				assertObject(assignee);
				return Reference.prop(assignee, dest.name);
			}
			case "arr": {
				const items = [];
				for (const item of dest.value) {
					const ref = await this.getReference(item, scope, callStack);
					if (isControl(ref)) return ref;
					items.push(ref);
				}
				return Reference.arr(items);
			}
			case "obj": {
				const entries = /* @__PURE__ */ new Map();
				for (const [key, item] of dest.value.entries()) {
					const ref = await this.getReference(item, scope, callStack);
					if (isControl(ref)) return ref;
					entries.set(key, ref);
				}
				return Reference.obj(entries);
			}
			default: throw new TonerikoScriptRuntimeError("The left-hand side of an assignment expression must be a variable or a property/index access.");
		}
	}
	getReferenceSync(dest, scope, callStack) {
		switch (dest.type) {
			case "identifier": return Reference.variable(dest.name, scope);
			case "index": {
				const assignee = this._evalSync(dest.target, scope, callStack);
				if (isControl(assignee)) return assignee;
				const i = this._evalSync(dest.index, scope, callStack);
				if (isControl(i)) return i;
				if (isArray(assignee)) {
					assertNumber(i);
					return Reference.index(assignee, i.value);
				} else if (isObject(assignee)) {
					assertString(i);
					return Reference.prop(assignee, i.value);
				}
				throw new TonerikoScriptRuntimeError(`Cannot read prop (${reprValue(i)}) of ${assignee.type}.`);
			}
			case "prop": {
				const assignee = this._evalSync(dest.target, scope, callStack);
				if (isControl(assignee)) return assignee;
				assertObject(assignee);
				return Reference.prop(assignee, dest.name);
			}
			case "arr": {
				const items = [];
				for (const item of dest.value) {
					const ref = this.getReferenceSync(item, scope, callStack);
					if (isControl(ref)) return ref;
					items.push(ref);
				}
				return Reference.arr(items);
			}
			case "obj": {
				const entries = /* @__PURE__ */ new Map();
				for (const [key, item] of dest.value.entries()) {
					const ref = this.getReferenceSync(item, scope, callStack);
					if (isControl(ref)) return ref;
					entries.set(key, ref);
				}
				return Reference.obj(entries);
			}
			default: throw new TonerikoScriptRuntimeError("The left-hand side of an assignment expression must be a variable or a property/index access.");
		}
	}
};
__decorate([autobind], Interpreter.prototype, "exec", null);
__decorate([autobind], Interpreter.prototype, "execSync", null);
__decorate([autobind], Interpreter.prototype, "execFn", null);
__decorate([autobind], Interpreter.prototype, "execFnSync", null);
__decorate([autobind], Interpreter.prototype, "execFnSimple", null);
__decorate([autobind], Interpreter, "collectMetadata", null);
__decorate([autobind], Interpreter.prototype, "handleError", null);
__decorate([autobind], Interpreter.prototype, "log", null);
__decorate([autobind], Interpreter.prototype, "collectNs", null);
__decorate([autobind], Interpreter.prototype, "collectNsSync", null);
__decorate([autobind], Interpreter.prototype, "collectNsMember", null);
__decorate([autobind], Interpreter.prototype, "collectNsMemberSync", null);
__decorate([autobind], Interpreter.prototype, "_fn", null);
__decorate([autobind], Interpreter.prototype, "_fnSync", null);
__decorate([autobind], Interpreter.prototype, "_evalClause", null);
__decorate([autobind], Interpreter.prototype, "_evalClauseSync", null);
__decorate([autobind], Interpreter.prototype, "_evalBinaryOperation", null);
__decorate([autobind], Interpreter.prototype, "_evalBinaryOperationSync", null);
__decorate([autobind], Interpreter.prototype, "_eval", null);
__decorate([autobind], Interpreter.prototype, "_evalSync", null);
__decorate([autobind], Interpreter.prototype, "__eval", null);
__decorate([autobind], Interpreter.prototype, "__evalSync", null);
__decorate([autobind], Interpreter.prototype, "_run", null);
__decorate([autobind], Interpreter.prototype, "_runSync", null);
__decorate([autobind], Interpreter.prototype, "registerAbortHandler", null);
__decorate([autobind], Interpreter.prototype, "registerPauseHandler", null);
__decorate([autobind], Interpreter.prototype, "registerUnpauseHandler", null);
__decorate([autobind], Interpreter.prototype, "unregisterAbortHandler", null);
__decorate([autobind], Interpreter.prototype, "unregisterPauseHandler", null);
__decorate([autobind], Interpreter.prototype, "unregisterUnpauseHandler", null);
__decorate([autobind], Interpreter.prototype, "abort", null);
__decorate([autobind], Interpreter.prototype, "pause", null);
__decorate([autobind], Interpreter.prototype, "unpause", null);
__decorate([autobind], Interpreter.prototype, "evalAndSetAttr", null);
__decorate([autobind], Interpreter.prototype, "evalAndSetAttrSync", null);
__decorate([autobind], Interpreter.prototype, "define", null);
__decorate([autobind], Interpreter.prototype, "getReference", null);
__decorate([autobind], Interpreter.prototype, "getReferenceSync", null);

//#endregion
export { Interpreter };
//# sourceMappingURL=index.js.map