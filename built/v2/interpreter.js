import { defaultYieldToHost, macrotaskTick } from "../interpreter/host-yield.js";
import { ExecutionStopped, RuntimeError, createScriptError, runtimeError, scriptErrorDiagnostic } from "./runtime/errors.js";
import { errorDefinition } from "./stdlib/basics.js";
import { STANDARD_FUNCTION, isStdFunction, validateArguments } from "./stdlib/core.js";
import { SCRIPT_FUNCTION, isScriptFunction, scriptObject, valueTypeof } from "./runtime/brands.js";
import { RuntimeServices } from "./stdlib/services.js";
import { standardGlobals } from "./stdlib/index.js";
import { Environment, boundNames } from "./runtime/environment.js";
import { PropertyAccess, errorValue } from "./runtime/values.js";
import { checkCopiedElement, checkScalar, checkValue, copiedArrayType, isComposite } from "./runtime/type-checks.js";
import { TypePlan, projectType } from "./runtime/type-plan.js";

//#region src/v2/interpreter.ts
const origin = {
	line: 1,
	column: 1
};
const shortCircuit = Symbol("optional chain");
const promiseThen = Promise.prototype.then;
var ScriptThrown = class {
	value;
	pos;
	diagnostic;
	constructor(value, pos, diagnostic) {
		this.value = value;
		this.pos = pos;
		this.diagnostic = diagnostic;
	}
};
const BINDING_TYPE = Symbol("binding type");
/** 型付きの周回は既知の束縛項目だけを写し、同じ複製関数を引き継ぐ。 */
function typedIteration() {
	const next = new Environment(this.parent);
	for (const [name, source] of this.bindings) {
		const binding = {
			initialized: source.initialized,
			mutable: source.mutable,
			value: source.value
		};
		const check = source[BINDING_TYPE];
		if (check) binding[BINDING_TYPE] = check;
		next.bindings.set(name, binding);
	}
	next.iteration = typedIteration;
	return next;
}
function patternLabel(pattern) {
	if (pattern.type === "Identifier") return pattern.name;
	if (pattern.type === "AssignmentPattern") return patternLabel(pattern.left);
	if (pattern.type === "RestElement") return patternLabel(pattern.argument);
	const names = boundNames(pattern).join(", ");
	return pattern.type === "ArrayPattern" ? `[${names}]` : `{${names}}`;
}
/** 親の直下検査で失敗した要素も、分割先が分かればその束縛名で示す。 */
function patternDiagnosticName(pattern, label, failure) {
	const suffix = failure.startsWith(label) ? failure.slice(label.length) : "";
	let key = /^\[[0-9]+\]$/.test(suffix) ? Number(suffix.slice(1, -1)) : suffix.startsWith(".") ? suffix.slice(1) : void 0;
	let name = label;
	while (true) {
		if (pattern.type === "AssignmentPattern" || pattern.type === "RestElement") {
			pattern = pattern.type === "AssignmentPattern" ? pattern.left : pattern.argument;
			continue;
		}
		name = patternLabel(pattern);
		if (pattern.type === "Identifier" || key === void 0) break;
		let next;
		if (pattern.type === "ArrayPattern" && typeof key === "number") {
			const restIndex = pattern.elements.findIndex((item) => item?.type === "RestElement");
			if (restIndex >= 0 && key >= restIndex) {
				pattern = pattern.elements[restIndex].argument;
				key -= restIndex;
				continue;
			}
			next = pattern.elements[key];
		} else if (pattern.type === "ObjectPattern") {
			const property = pattern.properties.find((item) => item.type === "Property" && (!item.computed || item.key.type === "Literal") && (item.key.type === "Identifier" ? item.key.name : String(item.key.value)) === String(key));
			if (property?.type === "Property") next = property.value;
			else {
				const rest = pattern.properties.find((item) => item.type === "RestElement");
				if (rest?.type === "RestElement") {
					pattern = rest.argument;
					continue;
				}
			}
		}
		if (!next) break;
		pattern = next;
		key = void 0;
	}
	return name + (key === void 0 ? "" : typeof key === "number" ? `[${key}]` : `.${key}`);
}
/** 別の実行器と共有する AST から注釈を外し、深い構文木も反復で複製する。 */
function detachAnnotations(root) {
	const result = Array.isArray(root) ? [] : {};
	const copies = new WeakMap([[root, result]]);
	const pending = [[root, result]];
	while (pending.length) {
		const [source, target] = pending.pop();
		for (const key of Object.keys(source)) {
			if (key === "typeAnnotation" || key === "returnType") continue;
			const value = source[key];
			let copied = value;
			if (value !== null && typeof value === "object") {
				copied = copies.get(value);
				if (!copied) {
					copied = Array.isArray(value) ? [] : {};
					copies.set(value, copied);
					pending.push([value, copied]);
				}
			}
			target[key] = copied;
		}
	}
	return result;
}
const hostBodies = /* @__PURE__ */ new WeakMap();
function hostFunction(body) {
	const fn = (..._args) => {
		throw new Error("Use Interpreter.call");
	};
	hostBodies.set(fn, body);
	return fn;
}
var Interpreter = class Interpreter {
	options;
	stepCount = 0;
	evaluationFrameCount = 0;
	synchronousNodes = /* @__PURE__ */ new WeakMap();
	synchronousCallbacks = /* @__PURE__ */ new WeakMap();
	maxCallDepth;
	global;
	services;
	controller = new AbortController();
	stopped = null;
	now;
	yieldInterval;
	maxBusyTime;
	yieldToHost;
	lastClock = 0;
	lastYield = 0;
	busy = 0;
	yielding = 0;
	idleTickPending = false;
	idle = true;
	active = 0;
	typePlan = new TypePlan();
	runtimePatterns = /* @__PURE__ */ new WeakMap();
	functionReturns = /* @__PURE__ */ new WeakMap();
	simpleParameters = /* @__PURE__ */ new WeakMap();
	detachedFunctions = /* @__PURE__ */ new WeakMap();
	checkedBinding = null;
	typeExecution = null;
	typesEnabled = false;
	preparedWithoutTypes = false;
	constructor(globals = {}, options = {}) {
		this.options = options;
		this.options = {
			...options,
			maxSteps: options.maxSteps ?? 5e5
		};
		this.services = new RuntimeServices(options, this.controller.signal, (fn, args, pos) => {
			const execution = this.execution();
			return this.run(this.invoke(fn, args, null, execution, pos), execution);
		});
		this.now = options.now ?? (() => performance.now());
		this.yieldInterval = options.yieldInterval ?? 8;
		this.maxBusyTime = options.maxBusyTime ?? 5e3;
		this.maxCallDepth = options.maxCallDepth ?? 1e4;
		if (!Number.isSafeInteger(this.maxCallDepth) || this.maxCallDepth < 1) throw new RangeError("Invalid call depth limit");
		if (!(this.yieldInterval >= 0) || !(this.maxBusyTime > 0) || options.maxSteps !== void 0 && (!Number.isSafeInteger(options.maxSteps) || options.maxSteps < 0)) throw new RangeError("Invalid execution limit");
		this.yieldToHost = options.yieldToHost ?? defaultYieldToHost;
		const builtins = new Environment();
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
	async exec(program) {
		this.prepareProgram(program);
		const execution = this.execution();
		await this.run(this.sequence(program.body, this.global, execution, true), execution);
	}
	getGlobal(name) {
		return this.global.read(name, origin);
	}
	async call(fn, args) {
		const execution = this.execution();
		return this.run(this.invokeHost(fn, args, execution, origin), execution);
	}
	abort() {
		this.stop("EXECUTION_ABORTED", origin);
	}
	execution() {
		const execution = {
			callDepth: 0,
			steps: 0,
			clock: 0,
			properties: void 0,
			pos: origin
		};
		execution.properties = new PropertyAccess(() => this.tick(execution, execution.pos));
		return execution;
	}
	stop(code, pos) {
		if (!this.stopped) {
			this.stopped = new ExecutionStopped(code, pos);
			this.controller.abort(this.stopped);
		}
		return this.stopped;
	}
	tick(execution, pos) {
		execution.pos = pos;
		if (this.stopped) throw this.stopped;
		execution.steps++;
		this.stepCount++;
		if (this.options.maxSteps !== void 0 && execution.steps > this.options.maxSteps) throw this.stop("STEP_LIMIT_EXCEEDED", pos);
		if (++execution.clock % 64 === 0) this.checkTime(pos);
	}
	resume() {
		if (this.idle) {
			this.idle = false;
			this.lastClock = this.lastYield = this.now();
		}
		this.armIdle();
	}
	armIdle() {
		if (this.idleTickPending) return;
		this.idleTickPending = true;
		macrotaskTick().then(() => {
			this.idleTickPending = false;
			if (this.yielding === 0) {
				this.busy = 0;
				this.idle = true;
			}
		});
	}
	checkTime(pos) {
		const now = this.now();
		this.busy += now - this.lastClock;
		this.lastClock = now;
		this.armIdle();
		if (this.busy > this.maxBusyTime) throw this.stop("BUSY_TIME_EXCEEDED", pos);
	}
	wait(promise) {
		return new Promise((resolve, reject) => {
			const signal = this.controller.signal;
			const aborted = () => reject(this.stopped);
			Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
			if (signal.aborted) {
				reject(this.stopped);
				return;
			}
			signal.addEventListener("abort", aborted, { once: true });
		});
	}
	async run(first, execution, internal = false) {
		const frames = [first];
		let value;
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
						try {
							await this.wait(this.yieldToHost());
						} finally {
							this.yielding--;
						}
						this.lastClock = this.lastYield = this.now();
						this.armIdle();
					}
				}
				let result;
				try {
					result = throwing ? frames.at(-1).throw(value) : frames.at(-1).next(value);
				} catch (error) {
					if (this.stopped) throw this.stopped;
					error = this.internalException(error, execution);
					frames.pop();
					value = error;
					throwing = true;
					continue;
				}
				throwing = false;
				if (result.done) {
					frames.pop();
					value = result.value;
					continue;
				}
				if ("ready" in result.value) value = result.value.ready;
				else if ("wait" in result.value) {
					this.checkTime(result.value.pos);
					try {
						value = await this.wait(result.value.wait);
					} catch (error) {
						value = error;
						throwing = true;
					}
					this.resume();
				} else {
					frames.push(result.value);
					value = void 0;
				}
			}
			if (throwing) {
				if (internal && value instanceof RuntimeError) throw new ScriptThrown(createScriptError(value.name, value.message, value), value.pos, value);
				if (value instanceof ScriptThrown && !internal) {
					let name;
					let message;
					try {
						if (errorValue(value.value, value.pos)) {
							name = execution.properties.get(value.value, "name", value.pos);
							message = execution.properties.get(value.value, "message", value.pos);
						}
					} catch {}
					const diagnostic = typeof name === "string" && typeof message === "string" ? value.diagnostic : void 0;
					const error = runtimeError(diagnostic?.code ?? "UNCAUGHT_EXCEPTION", diagnostic?.pos ?? value.pos, diagnostic?.params ?? {}, typeof name === "string" ? name : void 0);
					if (typeof message === "string") error.message = message;
					Object.assign(error, {
						thrownValue: value.value,
						cause: value.value
					});
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
	internalException(error, execution) {
		let defaultName = "Error";
		let name = defaultName;
		let message = "";
		try {
			if (error instanceof RuntimeError || error instanceof ScriptThrown) return error;
			if (!errorValue(error, execution.pos)) return error;
			for (const type of [
				EvalError,
				RangeError,
				ReferenceError,
				SyntaxError,
				TypeError,
				URIError,
				AggregateError
			]) if (error instanceof type) {
				defaultName = type.name;
				break;
			}
			const candidateName = execution.properties.get(error, "name", execution.pos);
			const candidateMessage = execution.properties.get(error, "message", execution.pos);
			name = typeof candidateName === "string" ? candidateName : defaultName;
			message = typeof candidateMessage === "string" ? candidateMessage : "";
		} catch {
			name = defaultName;
			message = "";
		}
		return new ScriptThrown(createScriptError(name, message), execution.pos);
	}
	/** 初回だけ構文木を走査し、注釈なしの実行経路には型判定を追加しない。 */
	prepareProgram(program) {
		if (!this.typePlan.prepare(program)) return;
		if (!this.typePlan.hasTypes) {
			this.preparedWithoutTypes = true;
			return;
		}
		this.synchronousNodes = /* @__PURE__ */ new WeakMap();
		this.synchronousCallbacks = /* @__PURE__ */ new WeakMap();
		if (this.typesEnabled) return;
		this.typesEnabled = true;
		if (this.preparedWithoutTypes) this.tick = this.tickTyped;
		this.prepare = this.prepareTyped;
		this.functionValue = this.functionValueTyped;
		this.bind = this.bindTyped;
		this.invoke = this.invokeTyped;
		this.callback = this.callbackTyped;
		this.synchronous = this.synchronousTyped;
		this.evaluateSuspending = this.evaluateTyped;
	}
	tickTyped(execution, pos) {
		this.typeExecution = execution;
		execution.pos = pos;
		if (this.stopped) throw this.stopped;
		execution.steps++;
		this.stepCount++;
		if (this.options.maxSteps !== void 0 && execution.steps > this.options.maxSteps) throw this.stop("STEP_LIMIT_EXCEEDED", pos);
		if (++execution.clock % 64 === 0) this.checkTime(pos);
	}
	*checkType(check, value, name, execution, pos, diagnosticName) {
		for (const _ of checkValue(check, value, name, execution.properties, pos, () => this.tick(execution, pos), diagnosticName)) yield this.checkpoint();
		return null;
	}
	installType(env, name, check) {
		const binding = env.bindings.get(name);
		if (!binding) return;
		if (binding[BINDING_TYPE]) {
			binding[BINDING_TYPE] = check;
			return;
		}
		binding[BINDING_TYPE] = check;
		let value = binding.value;
		env.iteration = typedIteration;
		if (env === this.global && this.preparedWithoutTypes) Object.defineProperty(binding, "value", {
			enumerable: true,
			configurable: true,
			get: () => value,
			set: (next) => {
				if (this.checkedBinding !== binding) {
					const execution = this.typeExecution;
					for (const _ of checkValue(binding[BINDING_TYPE], next, name, execution.properties, execution.pos, () => this.tick(execution, execution.pos)));
				}
				value = next;
			}
		});
	}
	registerPattern(pattern, env, projection) {
		const pending = [pattern];
		while (pending.length) {
			const part = pending.pop();
			if (projection) {
				const projected = projection.get(part);
				if (projected) {
					let plans = this.runtimePatterns.get(env);
					if (!plans) {
						plans = /* @__PURE__ */ new WeakMap();
						this.runtimePatterns.set(env, plans);
					}
					plans.set(part, projected);
				}
			}
			if (part.type === "Identifier") {
				const plan = this.runtimePatterns.get(env)?.get(part) ?? this.typePlan.patterns.get(part);
				if (plan) this.installType(env, part.name, plan.check);
			} else if (part.type === "AssignmentPattern") pending.push(part.left);
			else if (part.type === "RestElement") pending.push(part.argument);
			else if (part.type === "ArrayPattern") {
				for (const item of part.elements) if (item) pending.push(item);
			} else if (part.type === "ObjectPattern") for (const property of part.properties) pending.push(property.type === "RestElement" ? property.argument : property.value);
		}
	}
	writeChecked(env, name, value, pos, initialize = false) {
		const binding = initialize ? env.bindings.get(name) : env.resolve(name);
		const previous = this.checkedBinding;
		this.checkedBinding = binding ?? null;
		try {
			env.write(name, value, pos, initialize);
		} finally {
			this.checkedBinding = previous;
		}
	}
	checkBindingScalar(env, name, value, execution, pos) {
		const binding = env.resolve(name);
		const check = binding?.[BINDING_TYPE];
		if (check) {
			if (isComposite(check)) for (const _ of checkValue(check, value, name, execution.properties, pos, () => this.tick(execution, pos)));
			else {
				this.tick(execution, pos);
				checkScalar(check, value, name, pos);
			}
		}
		return binding;
	}
	writeScalar(env, name, value, execution, pos) {
		const binding = this.checkBindingScalar(env, name, value, execution, pos);
		if (!binding) throw runtimeError("UNBOUND_IDENTIFIER", pos, { name }, "ReferenceError");
		if (!binding.initialized) throw runtimeError("TDZ_ACCESS", pos, { name }, "ReferenceError");
		if (!binding.mutable) throw runtimeError("CONST_ASSIGNMENT", pos, { name }, "TypeError");
		const previous = this.checkedBinding;
		this.checkedBinding = binding;
		try {
			binding.value = value;
			binding.initialized = true;
		} finally {
			this.checkedBinding = previous;
		}
	}
	prepareTyped(body, env, execution) {
		Interpreter.prototype.prepare.call(this, body, env, execution);
		for (const statement of body) {
			const node = statement.type === "ExportMetaDeclaration" ? statement.declaration : statement;
			if (node.type === "VariableDeclaration") for (const declaration of node.declarations) this.registerPattern(declaration.id, env);
		}
	}
	functionValueTyped(node, environment) {
		const fn = Interpreter.prototype.functionValue.call(this, node, environment);
		const check = this.typePlan.returns.get(node);
		if (check) this.functionReturns.set(fn, check);
		this.simpleParameters.set(fn, node.params.every((pattern) => pattern.type === "Identifier") ? node.params.map((pattern) => ({
			pattern,
			check: this.typePlan.patterns.get(pattern)?.check
		})) : null);
		return fn;
	}
	*bindTyped(pattern, value, env, execution, initialize, reference, checkedValue) {
		if (initialize) this.registerPattern(pattern, env);
		const plan = this.runtimePatterns.get(env)?.get(pattern) ?? this.typePlan.patterns.get(pattern);
		const pos = pattern.loc.start;
		if (pattern.type === "AssignmentPattern") {
			this.tick(execution, pos);
			reference = reference === void 0 ? yield this.bindingReference(pattern, env, execution) : reference;
			const assigned = value === null ? yield this.evaluate(pattern.right, env, execution) : value;
			const projected = this.runtimePatterns.get(env)?.get(pattern.left) ?? this.typePlan.patterns.get(pattern.left);
			if (value === null && projected && !projected.explicit && pattern.left.type !== "Identifier") {
				const label = patternLabel(pattern.left);
				yield this.checkType(projected.check, assigned, label, execution, pos, (name) => patternDiagnosticName(pattern.left, label, name));
			}
			if (reference) this.write(reference, assigned, execution, pos);
			else yield this.bind(pattern.left, assigned, env, execution, initialize);
			return null;
		}
		if (pattern.type === "Identifier") {
			this.tick(execution, pos);
			const check = (initialize ? env.bindings.get(pattern.name) : env.resolve(pattern.name))?.[BINDING_TYPE];
			if (check && (!initialize || !checkedValue || plan?.explicit)) {
				if (isComposite(check)) yield this.checkType(check, value, pattern.name, execution, pos);
				else {
					this.tick(execution, pos);
					checkScalar(check, value, pattern.name, pos);
				}
			}
			this.writeChecked(env, pattern.name, value, pos, initialize);
			return null;
		}
		if (plan?.explicit) {
			const label = patternLabel(pattern);
			yield this.checkType(plan.check, value, label, execution, pos, (name) => patternDiagnosticName(pattern, label, name));
		}
		if (pattern.type === "RestElement") {
			this.tick(execution, pos);
			return yield this.bindTyped(pattern.argument, value, env, execution, initialize, reference, plan?.explicit ? plan.check : checkedValue);
		}
		if (pattern.type === "ArrayPattern" && plan && pattern.elements.some((part) => part?.type === "RestElement")) {
			this.tick(execution, pos);
			yield this.prepared(value, execution, pos);
			const items = execution.properties.iterableIterator(value, pos);
			const restPattern = pattern.elements.find((part) => part?.type === "RestElement");
			const restPlan = this.runtimePatterns.get(env)?.get(restPattern) ?? this.typePlan.patterns.get(restPattern);
			const copiedCheck = copiedArrayType(restPlan?.check ?? projectType(plan.check, null, true));
			const label = patternLabel(pattern);
			const diagnosticName = (name) => patternDiagnosticName(pattern, label, name);
			const copyStep = () => this.tick(execution, pos);
			let exhausted = false;
			let index = 0;
			for (const part of pattern.elements) {
				const target = part ? yield this.bindingReference(part, env, execution) : null;
				let item = null;
				if (part?.type === "RestElement") {
					const rest = scriptObject([]);
					while (!exhausted) {
						const next = items.next();
						exhausted = !!next.done;
						if (!next.done) {
							if (copiedCheck) checkCopiedElement(copiedCheck.element, next.value, label, index, pos, diagnosticName, copyStep);
							rest.push(next.value);
							index++;
						}
						if (execution.clock >= 64) yield this.checkpoint();
					}
					yield this.bindTyped(part, rest, env, execution, initialize, target, copiedCheck);
				} else {
					if (!exhausted) {
						const next = items.next();
						exhausted = !!next.done;
						if (!next.done) {
							item = next.value;
							index++;
						}
					}
					if (part) yield this.bind(part, item, env, execution, initialize, target);
				}
				if (execution.clock >= 64) yield this.checkpoint();
			}
			return null;
		}
		if (pattern.type === "ObjectPattern" && plan) {
			this.tick(execution, pos);
			if (value === null) throw runtimeError("NULL_PROPERTY_ACCESS", pos, {}, "TypeError");
			yield this.prepared(value, execution, pos);
			const excluded = /* @__PURE__ */ new Set();
			const dynamic = pattern.properties.some((property) => property.type !== "RestElement" && property.computed && property.key.type !== "Literal");
			for (const property of pattern.properties) if (property.type === "RestElement") {
				const target = yield this.bindingReference(property, env, execution);
				const rest = scriptObject(Object.create(null));
				if (initialize && !dynamic && !plan.transient) this.registerPattern(property.argument, env, this.typePlan.project(property.argument, plan.check, excluded));
				for (const [key, item] of execution.properties.entriesIterator(value, pos)) {
					if (!excluded.has(key)) rest[key] = item;
					if (execution.clock >= 64) yield this.checkpoint();
				}
				yield this.bind(property.argument, rest, env, execution, initialize, target);
			} else {
				const key = property.computed ? yield this.evaluate(property.key, env, execution) : property.key.type === "Identifier" ? property.key.name : property.key.value;
				const validated = execution.properties.key(key, property.loc.start);
				excluded.add(validated);
				if (initialize) {
					if (property.computed && property.key.type !== "Literal") {
						const preparation = this.typePlan.projectDynamic(property.value, plan.check, validated, () => this.tick(execution, pos));
						let result = preparation.next();
						while (!result.done) {
							yield this.checkpoint();
							result = preparation.next();
						}
						this.registerPattern(property.value, env, result.value);
					} else if (!plan.transient) this.registerPattern(property.value, env, this.typePlan.project(property.value, plan.check, validated));
				}
				const target = yield this.bindingReference(property.value, env, execution);
				yield this.bind(property.value, execution.properties.get(value, validated, property.loc.start), env, execution, initialize, target);
			}
			return null;
		}
		return yield Interpreter.prototype.bind.call(this, pattern, value, env, execution, initialize, reference);
	}
	detachedFunction(fn) {
		const cached = this.detachedFunctions.get(fn);
		if (cached) return cached;
		const nodes = detachAnnotations({
			params: fn.params,
			body: fn.body
		});
		const detached = {
			...fn,
			...nodes
		};
		this.detachedFunctions.set(fn, detached);
		this.detachedFunctions.set(detached, detached);
		return detached;
	}
	*invokeTyped(fn, args, receiver, execution, pos) {
		if (!isScriptFunction(fn)) return yield Interpreter.prototype.invoke.call(this, fn, args, receiver, execution, pos);
		this.tick(execution, pos);
		if (execution.callDepth >= this.maxCallDepth) throw runtimeError("CALL_DEPTH_EXCEEDED", pos, { limit: this.maxCallDepth }, "RangeError");
		execution.callDepth++;
		try {
			const simple = this.simpleParameters.get(fn);
			const target = simple === void 0 ? this.detachedFunction(fn) : fn;
			const parameters = new Environment(target.environment);
			if (simple) {
				for (const { pattern, check } of simple) {
					this.tick(execution, pattern.loc.start);
					parameters.declare(pattern.name, true);
					if (check) parameters.bindings.get(pattern.name)[BINDING_TYPE] = check;
				}
				for (let i = 0; i < simple.length; i++) {
					const { pattern, check } = simple[i];
					const value = args[i] ?? null;
					this.tick(execution, pattern.loc.start);
					if (check) {
						if (isComposite(check)) yield this.checkType(check, value, pattern.name, execution, pattern.loc.start);
						else {
							this.tick(execution, pattern.loc.start);
							checkScalar(check, value, pattern.name, pattern.loc.start);
						}
					}
					parameters.write(pattern.name, value, pattern.loc.start, true);
				}
			} else {
				for (const pattern of target.params) for (const name of boundNames(pattern)) {
					this.tick(execution, pattern.loc.start);
					parameters.declare(name, true);
				}
				for (let i = 0; i < target.params.length; i++) {
					const pattern = target.params[i];
					yield this.bind(pattern, pattern.type === "RestElement" ? scriptObject(args.slice(i)) : args[i] ?? null, parameters, execution, true);
				}
			}
			let value;
			let returnedAt;
			if (target.body.type !== "BlockStatement") {
				value = yield this.evaluate(target.body, parameters, execution);
				returnedAt = target.body.loc.start;
			} else {
				const result = yield this.sequence(target.body.body, new Environment(parameters), execution);
				value = result?.kind === "return" ? result.value : null;
				returnedAt = result?.pos ?? target.body.loc.end;
			}
			const check = this.functionReturns.get(target);
			if (check) {
				if (isComposite(check)) yield this.checkType(check, value, `${target.name ?? "<anonymous>"}()`, execution, returnedAt);
				else {
					this.tick(execution, returnedAt);
					checkScalar(check, value, `${target.name ?? "<anonymous>"}()`, returnedAt);
				}
			}
			return value;
		} finally {
			execution.callDepth--;
		}
	}
	callbackTyped(fn, args, receiver, execution, pos) {
		if (!isScriptFunction(fn)) return Interpreter.prototype.callback.call(this, fn, args, receiver, execution, pos);
		const returned = this.functionReturns.get(fn);
		if (!returned && !this.simpleParameters.has(fn)) return Interpreter.prototype.callback.call(this, this.detachedFunction(fn), args, receiver, execution, pos);
		if (!(returned || fn.params.some((pattern) => this.typePlan.patterns.has(pattern) || pattern.type === "AssignmentPattern" && this.typePlan.patterns.has(pattern.left)))) return Interpreter.prototype.callback.call(this, fn, args, receiver, execution, pos);
		if (!this.synchronousCallbacks.has(fn)) {
			const checks = fn.params.map((pattern) => this.typePlan.patterns.get(pattern)?.check);
			const expression = fn.body.type !== "BlockStatement" ? this.synchronous(fn.body) : null;
			const statements = fn.body.type === "BlockStatement" ? fn.body.body.map((node) => this.synchronous(node)) : null;
			const valid = fn.params.every((pattern) => pattern.type === "Identifier") && checks.every((check) => !check || !isComposite(check)) && (!returned || !isComposite(returned)) && (expression !== null || statements !== null && statements.every(Boolean) && fn.body.type === "BlockStatement" && fn.body.body.every((node) => node.type !== "VariableDeclaration" && node.type !== "FunctionDeclaration"));
			const cost = 1 + fn.params.length * 2 + checks.filter(Boolean).length + Number(!!returned) + (expression?.cost ?? statements?.reduce((sum, part) => sum + (part?.cost ?? 33), 0) ?? 33);
			this.synchronousCallbacks.set(fn, valid && cost <= 32 ? (values, current, at) => {
				this.tick(current, at);
				if (current.callDepth >= this.maxCallDepth) throw runtimeError("CALL_DEPTH_EXCEEDED", at, { limit: this.maxCallDepth }, "RangeError");
				current.callDepth++;
				try {
					const parameters = new Environment(fn.environment);
					for (const param of fn.params) {
						this.tick(current, param.loc.start);
						parameters.declare(param.name, true);
						this.registerPattern(param, parameters);
					}
					for (let i = 0; i < fn.params.length; i++) {
						const param = fn.params[i];
						const value = values[i] ?? null;
						this.tick(current, param.loc.start);
						if (checks[i]) {
							this.tick(current, param.loc.start);
							checkScalar(checks[i], value, param.name, param.loc.start);
						}
						this.writeChecked(parameters, param.name, value, param.loc.start, true);
					}
					let value = null;
					let returnedAt = fn.body.loc.end;
					if (expression) {
						value = expression.evaluate(parameters, current);
						returnedAt = fn.body.loc.start;
					} else {
						const body = new Environment(parameters);
						for (const statement of statements) {
							const result = statement.evaluate(body, current);
							if (result) {
								value = result.kind === "return" ? result.value : null;
								returnedAt = result.pos ?? returnedAt;
								break;
							}
						}
					}
					if (returned) {
						this.tick(current, returnedAt);
						checkScalar(returned, value, `${fn.name ?? "<anonymous>"}()`, returnedAt);
					}
					return value;
				} finally {
					current.callDepth--;
				}
			} : null);
		}
		const synchronous = this.synchronousCallbacks.get(fn);
		return synchronous ? { ready: synchronous(args, execution, pos) } : this.invoke(fn, args, receiver, execution, pos);
	}
	synchronousTyped(node, depth = 0) {
		if (depth >= 32) return null;
		if (this.synchronousNodes.has(node)) return this.synchronousNodes.get(node);
		const pos = node.loc.start;
		let cost = 1;
		let body = null;
		if (node.type === "ReturnStatement") {
			const argument = node.argument ? this.synchronous(node.argument, depth + 1) : {
				cost: 0,
				evaluate: () => null
			};
			if (!argument) {
				this.synchronousNodes.set(node, null);
				return null;
			}
			cost += argument.cost;
			body = (env, execution) => ({
				kind: "return",
				value: argument.evaluate(env, execution),
				label: null,
				pos: node.argument?.loc.start ?? pos
			});
		} else if (node.type === "VariableDeclaration") {
			if (node.declarations.some((declaration) => declaration.id.type !== "Identifier" || this.typePlan.compositeNames.has(declaration.id.name))) {
				this.synchronousNodes.set(node, null);
				return null;
			}
			const declarations = node.declarations.map((declaration) => ({
				id: declaration.id,
				init: declaration.init,
				value: declaration.init ? this.synchronous(declaration.init, depth + 1) : {
					cost: 0,
					evaluate: () => null
				}
			}));
			if (declarations.some((declaration) => !declaration.value)) {
				this.synchronousNodes.set(node, null);
				return null;
			}
			cost += declarations.reduce((sum, declaration) => sum + 2 + declaration.value.cost, 0);
			body = (env, execution) => {
				for (const declaration of declarations) {
					const value = declaration.value.evaluate(env, execution);
					this.tick(execution, declaration.id.loc.start);
					if (declaration.init) this.checkBindingScalar(env, declaration.id.name, value, execution, declaration.id.loc.start);
					this.writeChecked(env, declaration.id.name, value, declaration.id.loc.start, true);
				}
				return null;
			};
		} else if (node.type === "AssignmentExpression" && node.left.type === "Identifier") {
			const target = node.left;
			if (this.typePlan.compositeNames.has(target.name)) {
				this.synchronousNodes.set(node, null);
				return null;
			}
			const right = this.synchronous(node.right, depth + 1);
			if (!right) {
				this.synchronousNodes.set(node, null);
				return null;
			}
			cost += 2 + right.cost;
			body = (env, execution) => {
				this.tick(execution, target.loc.start);
				const previous = node.operator === "=" ? null : env.read(target.name, pos);
				if (node.operator === "??=" && previous !== null) return previous;
				const value = right.evaluate(env, execution);
				const assigned = node.operator === "=" || node.operator === "??=" ? value : this.binary(node.operator.slice(0, -1), previous, value, execution, pos);
				this.writeScalar(env, target.name, assigned, execution, pos);
				return assigned;
			};
		} else if (node.type === "UpdateExpression" && node.argument.type === "Identifier") {
			const target = node.argument;
			if (this.typePlan.compositeNames.has(target.name)) {
				this.synchronousNodes.set(node, null);
				return null;
			}
			cost += 2;
			body = (env, execution) => {
				this.tick(execution, target.loc.start);
				const value = env.read(target.name, pos);
				if (typeof value !== "number") throw runtimeError("IMPLICIT_COERCION", pos, {}, "TypeError");
				const next = value + (node.operator === "++" ? 1 : -1);
				this.writeScalar(env, target.name, next, execution, pos);
				return node.prefix ? next : value;
			};
		} else return Interpreter.prototype.synchronous.call(this, node, depth);
		const result = cost <= 32 ? {
			cost,
			evaluate: (env, execution) => {
				this.tick(execution, pos);
				return body(env, execution);
			}
		} : null;
		this.synchronousNodes.set(node, result);
		return result;
	}
	*evaluateTyped(node, env, execution, labels = []) {
		const pos = node.loc.start;
		if (node.type === "ReturnStatement") {
			this.tick(execution, pos);
			return {
				kind: "return",
				value: node.argument ? yield this.evaluate(node.argument, env, execution) : null,
				label: null,
				pos: node.argument?.loc.start ?? pos
			};
		}
		if (node.type === "VariableDeclaration") {
			this.tick(execution, pos);
			for (const declaration of node.declarations) if (!declaration.init && declaration.id.type === "Identifier") {
				this.tick(execution, declaration.id.loc.start);
				this.writeChecked(env, declaration.id.name, null, declaration.id.loc.start, true);
			} else yield this.bind(declaration.id, declaration.init ? yield this.evaluate(declaration.init, env, execution) : null, env, execution, true);
			return null;
		}
		if (node.type === "UpdateExpression") {
			this.tick(execution, pos);
			const ref = yield this.reference(node.argument, env, execution);
			const value = this.read(ref, execution, pos);
			if (typeof value !== "number") throw runtimeError("IMPLICIT_COERCION", pos, {}, "TypeError");
			const next = value + (node.operator === "++" ? 1 : -1);
			if (ref.kind === "binding") {
				const check = ref.env.resolve(ref.name)?.[BINDING_TYPE];
				if (check) {
					if (isComposite(check)) yield this.checkType(check, next, ref.name, execution, pos);
					else {
						this.tick(execution, pos);
						checkScalar(check, next, ref.name, pos);
					}
				}
				this.writeChecked(ref.env, ref.name, next, pos);
			} else this.write(ref, next, execution, pos);
			return node.prefix ? next : value;
		}
		if (node.type === "AssignmentExpression" && (node.left.type === "Identifier" || node.left.type === "MemberExpression")) {
			this.tick(execution, pos);
			const ref = yield this.reference(node.left, env, execution);
			const previous = node.operator === "=" ? null : this.read(ref, execution, pos);
			if (node.operator === "??=" && previous !== null) return previous;
			const right = yield this.evaluate(node.right, env, execution);
			const value = node.operator === "=" || node.operator === "??=" ? right : this.binary(node.operator.slice(0, -1), previous, right, execution, pos);
			if (ref.kind === "binding") {
				const check = ref.env.resolve(ref.name)?.[BINDING_TYPE];
				if (check) {
					if (isComposite(check)) yield this.checkType(check, value, ref.name, execution, pos);
					else {
						this.tick(execution, pos);
						checkScalar(check, value, ref.name, pos);
					}
				}
				this.writeChecked(ref.env, ref.name, value, pos);
			} else this.write(ref, value, execution, pos);
			return value;
		}
		return yield Interpreter.prototype.evaluateSuspending.call(this, node, env, execution, labels);
	}
	prepare(body, env, execution) {
		for (const statement of body) {
			const node = statement.type === "ExportMetaDeclaration" ? statement.declaration : statement;
			const names = node.type === "VariableDeclaration" ? node.declarations.flatMap((declaration) => boundNames(declaration.id)) : node.type === "FunctionDeclaration" ? [node.id.name] : [];
			for (const name of names) if (env.bindings.has(name)) throw runtimeError("DUPLICATE_DECLARATION", node.loc.start, { name }, "SyntaxError");
		}
		for (const statement of body) {
			const node = statement.type === "ExportMetaDeclaration" ? statement.declaration : statement;
			if (node.type === "VariableDeclaration") for (const declaration of node.declarations) for (const name of boundNames(declaration.id)) {
				this.tick(execution, declaration.loc.start);
				env.declare(name, node.kind === "let");
			}
			else if (node.type === "FunctionDeclaration") {
				this.tick(execution, node.loc.start);
				env.declare(node.id.name, true);
				env.write(node.id.name, this.functionValue(node, env), node.loc.start, true);
			}
		}
	}
	functionValue(node, environment) {
		return {
			[SCRIPT_FUNCTION]: true,
			params: node.params,
			body: node.body,
			environment,
			...node.type === "FunctionDeclaration" ? { name: node.id.name } : {}
		};
	}
	*sequence(body, env, execution, prepare = true) {
		if (prepare) this.prepare(body, env, execution);
		for (const node of body) {
			const result = yield this.evaluate(node, env, execution);
			if (result) return result;
		}
		return null;
	}
	*reference(node, env, execution) {
		this.tick(execution, node.loc.start);
		if (node.type === "Identifier") return {
			kind: "binding",
			name: node.name,
			env
		};
		const object = yield this.evaluate(node.object, env, execution);
		if (object === shortCircuit || node.optional && object === null) return shortCircuit;
		const key = node.computed ? yield this.evaluate(node.property, env, execution) : node.property.name;
		execution.properties.key(key, node.loc.start);
		yield this.prepared(object, execution, node.loc.start, key !== "length");
		return {
			kind: "property",
			object,
			key
		};
	}
	read(ref, execution, pos) {
		return ref.kind === "binding" ? ref.env.read(ref.name, pos) : execution.properties.get(ref.object, ref.key, pos);
	}
	write(ref, value, execution, pos) {
		if (ref.kind === "binding") ref.env.write(ref.name, value, pos);
		else execution.properties.set(ref.object, ref.key, value, pos);
	}
	*bindingReference(pattern, env, execution) {
		const target = pattern.type === "RestElement" ? pattern.argument : pattern.type === "AssignmentPattern" ? pattern.left : pattern;
		return target.type === "MemberExpression" ? yield this.reference(target, env, execution) : null;
	}
	*bind(pattern, value, env, execution, initialize, reference) {
		this.tick(execution, pattern.loc.start);
		const pos = pattern.loc.start;
		switch (pattern.type) {
			case "Identifier":
				env.write(pattern.name, value, pos, initialize);
				return null;
			case "MemberExpression":
				this.write(reference ?? (yield this.reference(pattern, env, execution)), value, execution, pos);
				return null;
			case "AssignmentPattern": {
				reference = reference === void 0 ? yield this.bindingReference(pattern, env, execution) : reference;
				const assigned = value === null ? yield this.evaluate(pattern.right, env, execution) : value;
				if (reference) this.write(reference, assigned, execution, pos);
				else yield this.bind(pattern.left, assigned, env, execution, initialize);
				return null;
			}
			case "RestElement":
				yield this.bind(pattern.argument, value, env, execution, initialize, reference);
				return null;
			case "ArrayPattern": {
				yield this.prepared(value, execution, pos);
				const items = execution.properties.iterableIterator(value, pos);
				let exhausted = false;
				for (const part of pattern.elements) {
					const target = part ? yield this.bindingReference(part, env, execution) : null;
					let item = null;
					if (part?.type === "RestElement") {
						const rest = scriptObject([]);
						while (!exhausted) {
							const next = items.next();
							exhausted = !!next.done;
							if (!next.done) rest.push(next.value);
							if (execution.clock >= 64) yield this.checkpoint();
						}
						item = rest;
					} else if (!exhausted) {
						const next = items.next();
						exhausted = !!next.done;
						if (!next.done) item = next.value;
					}
					if (part) yield this.bind(part, item, env, execution, initialize, target);
					if (execution.clock >= 64) yield this.checkpoint();
				}
				return null;
			}
			case "ObjectPattern": {
				if (value === null) throw runtimeError("NULL_PROPERTY_ACCESS", pos, {}, "TypeError");
				yield this.prepared(value, execution, pos);
				const excluded = /* @__PURE__ */ new Set();
				for (const property of pattern.properties) if (property.type === "RestElement") {
					const target = yield this.bindingReference(property, env, execution);
					const rest = scriptObject(Object.create(null));
					yield this.prepared(value, execution, pos);
					for (const [key, item] of execution.properties.entriesIterator(value, pos)) {
						if (!excluded.has(key)) rest[key] = item;
						if (execution.clock >= 64) yield this.checkpoint();
					}
					yield this.bind(property.argument, rest, env, execution, initialize, target);
				} else {
					const key = property.computed ? yield this.evaluate(property.key, env, execution) : property.key.type === "Identifier" ? property.key.name : property.key.value;
					const validatedKey = execution.properties.key(key, property.loc.start);
					excluded.add(validatedKey);
					const target = yield this.bindingReference(property.value, env, execution);
					yield this.bind(property.value, execution.properties.get(value, validatedKey, property.loc.start), env, execution, initialize, target);
				}
				return null;
			}
		}
	}
	text(value, pos) {
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
		throw runtimeError("INVALID_STRING_CONVERSION", pos, {}, "TypeError");
	}
	binary(operator, left, right, execution, pos) {
		if (operator === "===" || operator === "==") return left === right;
		if (operator === "!==" || operator === "!=") return left !== right;
		if (operator === "in") return execution.properties.has(right, left, pos);
		if (operator === "+" && (typeof left === "string" || typeof right === "string")) return execution.properties.concat(this.text(left, pos), this.text(right, pos));
		if ([
			"<",
			"<=",
			">",
			">="
		].includes(operator) && typeof left === "string" && typeof right === "string") {
			if (operator === "<") return left < right;
			if (operator === "<=") return left <= right;
			if (operator === ">") return left > right;
			return left >= right;
		}
		if (typeof left !== "number" || typeof right !== "number") throw runtimeError("IMPLICIT_COERCION", pos, {}, "TypeError");
		switch (operator) {
			case "+": return left + right;
			case "-": return left - right;
			case "*": return left * right;
			case "/": return left / right;
			case "%": return left % right;
			case "**": return left ** right;
			case "<": return left < right;
			case "<=": return left <= right;
			case ">": return left > right;
			case ">=": return left >= right;
			default: throw new Error("Unknown binary operation");
		}
	}
	*checkpoint() {
		return null;
	}
	*prepared(value, execution, pos, parts = true) {
		for (const _ of execution.properties.prepare(value, pos, parts)) yield this.checkpoint();
		return null;
	}
	*spread(value, execution, pos) {
		yield this.prepared(value, execution, pos);
		const items = [];
		for (const item of execution.properties.iterableIterator(value, pos)) {
			items.push(item);
			if (execution.clock >= 64) yield this.checkpoint();
		}
		return items;
	}
	*arguments(nodes, env, execution) {
		const args = [];
		for (const arg of nodes) if (arg.type === "SpreadElement") {
			const items = yield this.spread(yield this.evaluate(arg.argument, env, execution), execution, arg.loc.start);
			for (const item of items) {
				this.tick(execution, arg.loc.start);
				args.push(item);
				if (execution.clock >= 64) yield this.checkpoint();
			}
		} else args.push(yield this.evaluate(arg, env, execution));
		return args;
	}
	/** then プロパティは読まず、組み込みの then が持つ Promise の内部判定を使います。 */
	promiseResult(value) {
		if (value === null || typeof value !== "object" && typeof value !== "function") return null;
		let resolve;
		let reject;
		const result = new Promise((yes, no) => {
			resolve = yes;
			reject = no;
		});
		try {
			Reflect.apply(promiseThen, value, [(next) => resolve({ value: next }), reject]);
		} catch (error) {
			if (error instanceof TypeError) {
				let prototype = Object.getPrototypeOf(value);
				while (prototype) {
					const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor");
					if (constructor && "value" in constructor && typeof constructor.value === "function" && /^function\s+Promise\s*\(\s*\)\s*\{\s*\[native code\]\s*\}$/.test(Function.prototype.toString.call(constructor.value))) throw error;
					prototype = Object.getPrototypeOf(prototype);
				}
				return null;
			}
			throw error;
		}
		return result;
	}
	/** 呼び出し全体が32ステップ以内なら、引数と本体のフレームを作らず同じ予算で評価します。 */
	callback(fn, args, receiver, execution, pos) {
		if (!isScriptFunction(fn)) return this.invoke(fn, args, receiver, execution, pos);
		if (!this.synchronousCallbacks.has(fn)) {
			const params = fn.params;
			const expression = fn.body.type !== "BlockStatement" ? this.synchronous(fn.body) : null;
			const statements = fn.body.type === "BlockStatement" ? fn.body.body.map((node) => this.synchronous(node)) : null;
			const valid = params.every((param) => param.type === "Identifier") && (expression !== null || statements !== null && statements.every(Boolean) && fn.body.type === "BlockStatement" && fn.body.body.every((node) => node.type !== "VariableDeclaration" && node.type !== "FunctionDeclaration"));
			const cost = 1 + params.length * 2 + (expression?.cost ?? statements?.reduce((sum, part) => sum + (part?.cost ?? 33), 0) ?? 33);
			this.synchronousCallbacks.set(fn, valid && cost <= 32 ? (values, current, at) => {
				this.tick(current, at);
				if (current.callDepth >= this.maxCallDepth) throw runtimeError("CALL_DEPTH_EXCEEDED", at, { limit: this.maxCallDepth }, "RangeError");
				current.callDepth++;
				try {
					const parameters = new Environment(fn.environment);
					for (const param of params) {
						this.tick(current, param.loc.start);
						parameters.declare(param.name, true);
					}
					for (let i = 0; i < params.length; i++) {
						const param = params[i];
						this.tick(current, param.loc.start);
						parameters.write(param.name, values[i] ?? null, param.loc.start, true);
					}
					if (expression) return expression.evaluate(parameters, current);
					const body = new Environment(parameters);
					for (const statement of statements) {
						const result = statement.evaluate(body, current);
						if (result) return result.kind === "return" ? result.value : null;
					}
					return null;
				} finally {
					current.callDepth--;
				}
			} : null);
		}
		const synchronous = this.synchronousCallbacks.get(fn);
		return synchronous ? { ready: synchronous(args, execution, pos) } : this.invoke(fn, args, receiver, execution, pos);
	}
	*invokeHost(fn, args, execution, pos) {
		const values = [];
		for (let i = 0; i < args.length; i++) {
			values.push(execution.properties.get(args, i, pos));
			this.tick(execution, pos);
			if (i % 64 === 63) yield this.checkpoint();
		}
		return yield this.invoke(fn, values, null, execution, pos);
	}
	*invoke(fn, args, receiver, execution, pos) {
		this.tick(execution, pos);
		if (isStdFunction(fn)) {
			const context = {
				pos,
				properties: execution.properties,
				services: this.services,
				wait: function* (promise) {
					return yield {
						wait: promise,
						pos
					};
				},
				parallel: (callback, arguments_) => this.run(this.invoke(callback, arguments_, null, execution, pos), execution, true),
				tick: () => this.tick(execution, pos),
				checkpoint: () => this.checkpoint(),
				call: (callback, arguments_, target = null) => this.callback(callback, arguments_, target, execution, pos)
			};
			validateArguments(context, fn[STANDARD_FUNCTION], args);
			const result = yield fn[STANDARD_FUNCTION].implementation(context, receiver, args);
			yield this.prepared(result, execution, pos);
			return execution.properties.normalize(result, pos);
		}
		if (isScriptFunction(fn)) {
			if (execution.callDepth >= this.maxCallDepth) throw runtimeError("CALL_DEPTH_EXCEEDED", pos, { limit: this.maxCallDepth }, "RangeError");
			execution.callDepth++;
			try {
				const parameters = new Environment(fn.environment);
				for (const pattern of fn.params) for (const name of boundNames(pattern)) {
					this.tick(execution, pattern.loc.start);
					parameters.declare(name, true);
				}
				for (let i = 0; i < fn.params.length; i++) {
					const pattern = fn.params[i];
					yield this.bind(pattern, pattern.type === "RestElement" ? scriptObject(args.slice(i)) : args[i] ?? null, parameters, execution, true);
				}
				if (fn.body.type !== "BlockStatement") return yield this.evaluate(fn.body, parameters, execution);
				const body = new Environment(parameters);
				const result = yield this.sequence(fn.body.body, body, execution);
				return result?.kind === "return" ? result.value : null;
			} finally {
				execution.callDepth--;
			}
		}
		if (typeof fn !== "function") throw runtimeError("NOT_CALLABLE", pos, {}, "TypeError");
		this.checkTime(pos);
		const context = {
			call: (callback, arguments_) => {
				this.resume();
				return this.run(this.invokeHost(callback, arguments_, execution, pos), execution, true);
			},
			signal: this.controller.signal
		};
		const hostException = (error) => {
			if (error instanceof ExecutionStopped || error instanceof ScriptThrown) throw error;
			throw new ScriptThrown(execution.properties.normalize(error, pos), pos, scriptErrorDiagnostic(error));
		};
		let result;
		try {
			result = hostBodies.has(fn) ? hostBodies.get(fn)(args, context) : Reflect.apply(fn, receiver, args);
		} catch (error) {
			hostException(error);
		}
		this.checkTime(pos);
		let pending = null;
		try {
			pending = this.promiseResult(result);
		} catch (error) {
			hostException(error);
		}
		if (pending) try {
			result = (yield {
				wait: pending,
				pos
			}).value;
		} catch (error) {
			hostException(error);
		}
		yield this.prepared(result, execution, pos);
		return execution.properties.normalize(result, pos);
	}
	evaluate(node, env, execution, labels = []) {
		const synchronous = this.synchronous(node);
		if (synchronous) return { ready: synchronous.evaluate(env, execution) };
		this.evaluationFrameCount++;
		return this.evaluateSuspending(node, env, execution, labels);
	}
	/** 同期区間の構文は最大32ステップとし、深い構文や中断を伴う操作はスケジューラへ返します。 */
	synchronous(node, depth = 0) {
		if (depth >= 32) return null;
		if (this.synchronousNodes.has(node)) return this.synchronousNodes.get(node);
		const pos = node.loc.start;
		let cost = 1;
		let valid = true;
		const child = (part) => {
			const result = this.synchronous(part, depth + 1);
			if (!result) {
				valid = false;
				return () => null;
			}
			cost += result.cost;
			return result.evaluate;
		};
		let body = null;
		switch (node.type) {
			case "Literal":
				body = () => node.value;
				break;
			case "Identifier":
				body = (env) => env.read(node.name, pos);
				break;
			case "EmptyStatement":
			case "FunctionDeclaration":
				body = () => null;
				break;
			case "ExpressionStatement": {
				const expression = child(node.expression);
				body = (env, execution) => {
					expression(env, execution);
					return null;
				};
				break;
			}
			case "BlockStatement": {
				const statements = node.body.map(child);
				for (const statement of node.body) {
					if (statement.type === "VariableDeclaration") cost += statement.declarations.length;
					if (statement.type === "FunctionDeclaration") cost++;
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
			case "VariableDeclaration": {
				if (node.declarations.some((declaration) => declaration.id.type !== "Identifier")) break;
				const declarations = node.declarations.map((declaration) => ({
					id: declaration.id,
					value: declaration.init ? child(declaration.init) : () => null
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
			case "ReturnStatement": {
				const argument = node.argument ? child(node.argument) : () => null;
				body = (env, execution) => ({
					kind: "return",
					value: argument(env, execution),
					label: null
				});
				break;
			}
			case "BreakStatement":
			case "ContinueStatement":
				body = () => ({
					kind: node.type === "BreakStatement" ? "break" : "continue",
					value: null,
					label: node.label?.name ?? null
				});
				break;
			case "IfStatement": {
				const test = child(node.test), consequent = child(node.consequent), alternate = node.alternate ? child(node.alternate) : () => null;
				body = (env, execution) => test(env, execution) ? consequent(env, execution) : alternate(env, execution);
				break;
			}
			case "BinaryExpression": {
				const left = child(node.left), right = child(node.right);
				if (node.operator === "in") break;
				body = (env, execution) => this.binary(node.operator, left(env, execution), right(env, execution), execution, pos);
				break;
			}
			case "LogicalExpression": {
				const left = child(node.left), right = child(node.right);
				body = (env, execution) => {
					const value = left(env, execution);
					return (node.operator === "&&" ? !value : node.operator === "||" ? !!value : value !== null) ? value : right(env, execution);
				};
				break;
			}
			case "ConditionalExpression": {
				const test = child(node.test), consequent = child(node.consequent), alternate = child(node.alternate);
				body = (env, execution) => test(env, execution) ? consequent(env, execution) : alternate(env, execution);
				break;
			}
			case "UnaryExpression": {
				if (node.operator === "delete") break;
				const argument = child(node.argument);
				body = (env, execution) => {
					if (node.operator === "typeof" && node.argument.type === "Identifier" && !env.resolve(node.argument.name)) return "undefined";
					const value = argument(env, execution);
					if (node.operator === "!") return !value;
					if (node.operator === "typeof") return valueTypeof(value);
					if (typeof value !== "number") throw runtimeError("IMPLICIT_COERCION", pos, {}, "TypeError");
					return node.operator === "-" ? -value : +value;
				};
				break;
			}
			case "AssignmentExpression": {
				if (node.left.type !== "Identifier") break;
				const target = node.left;
				const right = child(node.right);
				cost++;
				body = (env, execution) => {
					this.tick(execution, target.loc.start);
					const previous = node.operator === "=" ? null : env.read(target.name, pos);
					if (node.operator === "??=" && previous !== null) return previous;
					const value = right(env, execution);
					const assigned = node.operator === "=" || node.operator === "??=" ? value : this.binary(node.operator.slice(0, -1), previous, value, execution, pos);
					env.write(target.name, assigned, pos);
					return assigned;
				};
				break;
			}
			case "UpdateExpression": {
				if (node.argument.type !== "Identifier") break;
				const target = node.argument;
				cost++;
				body = (env, execution) => {
					this.tick(execution, target.loc.start);
					const value = env.read(target.name, pos);
					if (typeof value !== "number") throw runtimeError("IMPLICIT_COERCION", pos, {}, "TypeError");
					const next = value + (node.operator === "++" ? 1 : -1);
					env.write(target.name, next, pos);
					return node.prefix ? next : value;
				};
				break;
			}
		}
		const result = valid && body && cost <= 32 ? {
			cost,
			evaluate: (env, execution) => {
				this.tick(execution, pos);
				return body(env, execution);
			}
		} : null;
		this.synchronousNodes.set(node, result);
		return result;
	}
	*evaluateSuspending(node, env, execution, labels = []) {
		const pos = node.loc.start;
		const properties = execution.properties;
		this.tick(execution, pos);
		switch (node.type) {
			case "Literal": return node.value;
			case "Identifier": return env.read(node.name, pos);
			case "EmptyStatement":
			case "FunctionDeclaration": return null;
			case "ExpressionStatement":
				yield this.evaluate(node.expression, env, execution);
				return null;
			case "ExportMetaDeclaration": return yield this.evaluate(node.declaration, env, execution);
			case "BlockStatement": return yield this.sequence(node.body, new Environment(env), execution);
			case "VariableDeclaration":
				for (const declaration of node.declarations) yield this.bind(declaration.id, declaration.init ? yield this.evaluate(declaration.init, env, execution) : null, env, execution, true);
				return null;
			case "ArrowFunctionExpression": return this.functionValue(node, env);
			case "ReturnStatement": return {
				kind: "return",
				value: node.argument ? yield this.evaluate(node.argument, env, execution) : null,
				label: null
			};
			case "BreakStatement":
			case "ContinueStatement": return {
				kind: node.type === "BreakStatement" ? "break" : "continue",
				value: null,
				label: node.label?.name ?? null
			};
			case "IfStatement":
				if (yield this.evaluate(node.test, env, execution)) return yield this.evaluate(node.consequent, env, execution);
				return node.alternate ? yield this.evaluate(node.alternate, env, execution) : null;
			case "LabeledStatement": {
				const result = yield this.evaluate(node.body, env, execution, [...labels, node.label.name]);
				return result?.kind === "break" && result.label === node.label.name ? null : result;
			}
			case "WhileStatement":
			case "DoWhileStatement": {
				const test = this.synchronous(node.test);
				const body = this.synchronous(node.body);
				let first = true;
				while (first && node.type === "DoWhileStatement" || (test ? test.evaluate(env, execution) : yield this.evaluate(node.test, env, execution))) {
					first = false;
					const result = body ? body.evaluate(env, execution) : yield this.evaluate(node.body, env, execution);
					if (result) {
						if (result.kind === "break" && (result.label === null || labels.includes(result.label))) break;
						if (result.kind !== "continue" || result.label !== null && !labels.includes(result.label)) return result;
					}
					if (execution.clock >= 64) yield this.checkpoint();
				}
				return null;
			}
			case "ForStatement": {
				const test = node.test ? this.synchronous(node.test) : null;
				const body = this.synchronous(node.body);
				const update = node.update ? this.synchronous(node.update) : null;
				let loop = new Environment(env);
				if (node.init?.type === "VariableDeclaration") this.prepare([node.init], loop, execution);
				if (node.init) yield this.evaluate(node.init, loop, execution);
				const perIteration = node.init?.type === "VariableDeclaration" && node.init.kind === "let";
				if (perIteration) loop = loop.iteration();
				while (!node.test || (test ? test.evaluate(loop, execution) : yield this.evaluate(node.test, loop, execution))) {
					const result = body ? body.evaluate(loop, execution) : yield this.evaluate(node.body, loop, execution);
					if (result) {
						if (result.kind === "break" && (result.label === null || labels.includes(result.label))) break;
						if (result.kind !== "continue" || result.label !== null && !labels.includes(result.label)) return result;
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
			case "ForOfStatement": {
				const declaration = node.left.type === "VariableDeclaration" ? node.left : null;
				const rightScope = new Environment(env);
				if (declaration) this.prepare([declaration], rightScope, execution);
				const source = yield this.evaluate(node.right, rightScope, execution);
				yield this.prepared(source, execution, pos);
				const items = properties.iterableIterator(source, pos);
				for (const item of items) {
					this.tick(execution, pos);
					const scope = declaration ? new Environment(env) : env;
					if (declaration) this.prepare([declaration], scope, execution);
					yield this.bind(declaration ? declaration.declarations[0].id : node.left, item, scope, execution, !!declaration);
					const result = yield this.evaluate(node.body, scope, execution);
					if (result) {
						if (result.kind === "break" && (result.label === null || labels.includes(result.label))) break;
						if (result.kind !== "continue" || result.label !== null && !labels.includes(result.label)) return result;
					}
				}
				return null;
			}
			case "SwitchStatement": {
				const discriminant = yield this.evaluate(node.discriminant, env, execution);
				const scope = new Environment(env);
				this.prepare(node.cases.flatMap((c) => c.consequent), scope, execution);
				let matched = -1;
				let defaultIndex = -1;
				for (let i = 0; i < node.cases.length; i++) {
					const test = node.cases[i].test;
					if (!test) defaultIndex = i;
					else if ((yield this.evaluate(test, scope, execution)) === discriminant) {
						matched = i;
						break;
					}
				}
				if (matched < 0) matched = defaultIndex;
				if (matched >= 0) for (let i = matched; i < node.cases.length; i++) {
					const result = yield this.sequence(node.cases[i].consequent, scope, execution, false);
					if (result?.kind === "break" && result.label === null) return null;
					if (result) return result;
				}
				return null;
			}
			case "ThrowStatement": {
				const value = yield this.evaluate(node.argument, env, execution);
				throw new ScriptThrown(value, pos, scriptErrorDiagnostic(value));
			}
			case "TryStatement": {
				let result = null;
				let thrown = false;
				let error;
				try {
					result = yield this.evaluate(node.block, env, execution);
				} catch (caught) {
					if (caught instanceof ExecutionStopped) throw caught;
					if (node.handler) try {
						const scope = new Environment(env);
						if (node.handler.param) {
							for (const name of boundNames(node.handler.param)) scope.declare(name, true);
							yield this.bind(node.handler.param, properties.normalize(caught instanceof ScriptThrown ? caught.value : caught instanceof RuntimeError ? createScriptError(caught.name, caught.message, caught) : caught, pos), scope, execution, true);
						}
						result = yield this.evaluate(node.handler.body, scope, execution);
					} catch (caughtAgain) {
						thrown = true;
						error = caughtAgain;
					}
					else {
						thrown = true;
						error = caught;
					}
				}
				if (node.finalizer) {
					const final = yield this.evaluate(node.finalizer, env, execution);
					if (final) return final;
				}
				if (thrown) throw error;
				return result;
			}
			case "ArrayExpression": {
				const result = scriptObject([]);
				for (const element of node.elements) {
					if (!element) throw runtimeError("SPARSE_ARRAY", pos);
					if (element.type === "SpreadElement") {
						const items = yield this.spread(yield this.evaluate(element.argument, env, execution), execution, element.loc.start);
						for (const item of items) {
							this.tick(execution, element.loc.start);
							result.push(item);
							if (execution.clock >= 64) yield this.checkpoint();
						}
					} else result.push(yield this.evaluate(element, env, execution));
				}
				return result;
			}
			case "ObjectExpression": {
				const result = scriptObject(Object.create(null));
				for (const property of node.properties) if (property.type === "SpreadElement") {
					const source = yield this.evaluate(property.argument, env, execution);
					yield this.prepared(source, execution, property.loc.start);
					for (const [key, value] of properties.entriesIterator(source, property.loc.start)) {
						properties.set(result, key, value, property.loc.start);
						if (execution.clock >= 64) yield this.checkpoint();
					}
				} else {
					const key = property.computed ? yield this.evaluate(property.key, env, execution) : property.key.type === "Identifier" ? property.key.name : property.key.value;
					const validatedKey = properties.key(key, property.loc.start);
					properties.set(result, validatedKey, yield this.evaluate(property.value, env, execution), property.loc.start);
				}
				return result;
			}
			case "TemplateLiteral": {
				let result = node.quasis[0].value.cooked;
				for (let i = 0; i < node.expressions.length; i++) result = properties.concat(properties.concat(result, this.text(yield this.evaluate(node.expressions[i], env, execution), pos)), node.quasis[i + 1].value.cooked);
				return result;
			}
			case "BinaryExpression": return this.binary(node.operator, yield this.evaluate(node.left, env, execution), yield this.evaluate(node.right, env, execution), execution, pos);
			case "LogicalExpression": {
				const left = yield this.evaluate(node.left, env, execution);
				if (node.operator === "&&" ? !left : node.operator === "||" ? !!left : left !== null) return left;
				return yield this.evaluate(node.right, env, execution);
			}
			case "ConditionalExpression": return yield this.evaluate((yield this.evaluate(node.test, env, execution)) ? node.consequent : node.alternate, env, execution);
			case "AwaitExpression": return yield this.evaluate(node.argument, env, execution);
			case "ChainExpression": {
				const result = yield this.evaluate(node.expression, env, execution);
				return result === shortCircuit ? null : result;
			}
			case "MemberExpression": {
				const ref = yield this.reference(node, env, execution);
				return ref === shortCircuit ? shortCircuit : this.read(ref, execution, pos);
			}
			case "CallExpression": {
				let ref = null;
				let fn;
				const member = node.callee.type === "MemberExpression" ? node.callee : node.callee.type === "ChainExpression" && node.callee.expression.type === "MemberExpression" ? node.callee.expression : null;
				if (member) {
					const target = yield this.reference(member, env, execution);
					if (target === shortCircuit) {
						if (node.callee.type === "MemberExpression") return shortCircuit;
						fn = null;
					} else {
						ref = target;
						fn = this.read(target, execution, node.callee.loc.start);
					}
				} else fn = yield this.evaluate(node.callee, env, execution);
				if (fn === shortCircuit || node.optional && fn === null) return shortCircuit;
				const args = yield this.arguments(node.arguments, env, execution);
				if (fn === null && ref?.kind === "property" && [
					"hasOwnProperty",
					"propertyIsEnumerable",
					"isPrototypeOf",
					"toString",
					"toLocaleString",
					"valueOf",
					"__defineGetter__",
					"__defineSetter__",
					"__lookupGetter__",
					"__lookupSetter__"
				].includes(String(ref.key))) throw runtimeError("PROTOTYPE_METHOD_CALL", pos, {}, "TypeError");
				return yield this.invoke(fn, args, ref?.kind === "property" ? ref.object : null, execution, pos);
			}
			case "NewExpression": {
				const constructor = env.read(node.callee.name, pos);
				const args = yield this.arguments(node.arguments, env, execution);
				if (!isStdFunction(constructor) || constructor[STANDARD_FUNCTION] !== errorDefinition) throw runtimeError("NOT_CALLABLE", pos, {}, "TypeError");
				return yield this.invoke(constructor, args, null, execution, pos);
			}
			case "UnaryExpression": {
				if (node.operator === "typeof" && node.argument.type === "Identifier" && !env.resolve(node.argument.name)) return "undefined";
				if (node.operator === "delete") {
					const argument = node.argument.type === "ChainExpression" ? node.argument.expression : node.argument;
					if (argument.type !== "MemberExpression") {
						yield this.evaluate(node.argument, env, execution);
						return true;
					}
					const ref = yield this.reference(argument, env, execution);
					return ref === shortCircuit ? true : properties.delete(ref.object, ref.key, pos);
				}
				const value = yield this.evaluate(node.argument, env, execution);
				if (node.operator === "!") return !value;
				if (node.operator === "typeof") return valueTypeof(value);
				if (typeof value !== "number") throw runtimeError("IMPLICIT_COERCION", pos, {}, "TypeError");
				return node.operator === "-" ? -value : +value;
			}
			case "AssignmentExpression": {
				if (node.left.type !== "Identifier" && node.left.type !== "MemberExpression") {
					const value = yield this.evaluate(node.right, env, execution);
					yield this.bind(node.left, value, env, execution, false);
					return value;
				}
				const ref = yield this.reference(node.left, env, execution);
				const previous = node.operator === "=" ? null : this.read(ref, execution, pos);
				if (node.operator === "??=" && previous !== null) return previous;
				const right = yield this.evaluate(node.right, env, execution);
				const value = node.operator === "=" || node.operator === "??=" ? right : this.binary(node.operator.slice(0, -1), previous, right, execution, pos);
				this.write(ref, value, execution, pos);
				return value;
			}
			case "UpdateExpression": {
				const ref = yield this.reference(node.argument, env, execution);
				const value = this.read(ref, execution, pos);
				if (typeof value !== "number") throw runtimeError("IMPLICIT_COERCION", pos, {}, "TypeError");
				const next = value + (node.operator === "++" ? 1 : -1);
				this.write(ref, next, execution, pos);
				return node.prefix ? next : value;
			}
		}
	}
};

//#endregion
export { ExecutionStopped, Interpreter, RuntimeError, hostFunction };
//# sourceMappingURL=interpreter.js.map