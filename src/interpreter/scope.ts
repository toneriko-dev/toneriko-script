import { AiScriptRuntimeError } from '../error.js';
import type { TypeParam } from '../node.js';
import type { Value } from './value.js';
import type { Variable } from './variable.js';
import type { LogObject } from './index.js';

export class Scope {
	private parent?: Scope;
	private states: Map<string, Variable>;
	public name: string;
	public opts: {
		log?(type: string, params: LogObject): void;
		onUpdated?(name: string, value: Value): void;
	} = {};
	public nsName?: string;

	constructor(states: Map<string, Variable> = new Map(), parent?: Scope, name?: Scope['name'], nsName?: string, private typeParams: readonly TypeParam[] = []) {
		this.states = states;
		this.parent = parent;
		this.name = name || (parent == null ? '<root>' : '<anonymous>');
		this.nsName = nsName;
	}

	private log(type: string, params: LogObject): void {
		if (this.parent) {
			this.parent.log(type, params);
		} else {
			if (this.opts.log) this.opts.log(type, params);
		}
	}

	private onUpdated(name: string, value: Value): void {
		if (this.parent) {
			this.parent.onUpdated(name, value);
		} else {
			if (this.opts.onUpdated) this.opts.onUpdated(name, value);
		}
	}

	public createChildScope(states: Map<string, Variable> = new Map(), name?: Scope['name'], typeParams: readonly TypeParam[] = []): Scope {
		return new Scope(states, this, name, undefined, typeParams);
	}

	public createChildNamespaceScope(nsName: string, states: Map<string, Variable> = new Map(), name?: Scope['name']): Scope {
		return new Scope(states, this, name, nsName);
	}

	public getTypeParams(): TypeParam[] {
		return [...this.typeParams, ...(this.parent?.getTypeParams() ?? [])];
	}

	public get(name: string): Value {
		let variable = this.states.get(name);
		for (let layer = this.parent; variable == null && layer != null; layer = layer.parent) {
			variable = layer.states.get(name);
		}
		if (variable != null) {
			this.log('read', { var: name, val: variable.value });
			return variable.value;
		}

		throw new AiScriptRuntimeError(
			`No such variable '${name}' in scope '${this.name}'`,
			{ scope: this.getLayerdStates() });
	}

	public getNsPrefix(): string {
		if (this.parent == null || this.nsName == null) return '';
		return this.parent.getNsPrefix() + this.nsName + ':';
	}

	public exists(name: string): boolean {
		let found = this.states.has(name);
		for (let layer = this.parent; !found && layer != null; layer = layer.parent) {
			found = layer.states.has(name);
		}
		if (found) {
			this.log('exists', { var: name });
			return true;
		}

		this.log('not exists', { var: name });
		return false;
	}

	public getAll(): Map<string, Variable> {
		const vars = new Map<string, Variable>();
		for (const [key, variable] of this.states) {
			vars.set(key, variable);
		}
		for (let layer = this.parent; layer != null; layer = layer.parent) {
			for (const [key, variable] of layer.states) {
				if (!vars.has(key)) vars.set(key, variable);
			}
		}
		return vars;
	}

	public add(name: string, variable: Variable): void {
		this.log('add', { var: name, val: variable });
		if (this.states.has(name)) {
			throw new AiScriptRuntimeError(
				`Variable '${name}' already exists in scope '${this.name}'`,
				{ scope: this.getLayerdStates() });
		}
		this.states.set(name, variable);
		if (this.parent == null) this.onUpdated(name, variable.value);
		else if (this.nsName != null) this.parent.add(this.nsName + ':' + name, variable);
	}

	public assign(name: string, val: Value): void {
		const own = this.states.get(name);
		if (own != null) {
			if (!own.isMutable) {
				throw new AiScriptRuntimeError(`Cannot assign to an immutable variable ${name}.`);
			}
			own.value = val;
			this.log('assign', { var: name, val: val });
			if (this.parent == null) this.onUpdated(name, val);
			return;
		}
		for (let layer = this.parent; layer != null; layer = layer.parent) {
			const variable = layer.states.get(name);
			if (variable != null) {
				if (!variable.isMutable) {
					throw new AiScriptRuntimeError(`Cannot assign to an immutable variable ${name}.`);
				}

				variable.value = val;

				this.log('assign', { var: name, val: val });
				if (layer.parent == null) this.onUpdated(name, val);
				return;
			}
		}

		throw new AiScriptRuntimeError(
			`No such variable '${name}' in scope '${this.name}'`,
			{ scope: this.getLayerdStates() });
	}

	// get() と assign() の二重探索を避け、複合代入を1回のスコープ探索で処理する。
	public update(name: string, updater: (current: Value) => Value): void {
		const own = this.states.get(name);
		if (own != null) {
			const val = updater(own.value);
			if (!own.isMutable) {
				throw new AiScriptRuntimeError(`Cannot assign to an immutable variable ${name}.`);
			}
			own.value = val;
			this.log('assign', { var: name, val: val });
			if (this.parent == null) this.onUpdated(name, val);
			return;
		}
		for (let layer = this.parent; layer != null; layer = layer.parent) {
			const variable = layer.states.get(name);
			if (variable != null) {
				const val = updater(variable.value);

				if (!variable.isMutable) {
					throw new AiScriptRuntimeError(`Cannot assign to an immutable variable ${name}.`);
				}

				variable.value = val;

				this.log('assign', { var: name, val: val });
				if (layer.parent == null) this.onUpdated(name, val);
				return;
			}
		}

		throw new AiScriptRuntimeError(
			`No such variable '${name}' in scope '${this.name}'`,
			{ scope: this.getLayerdStates() });
	}

	// エラー情報の構築専用。get/exists/assign のホットパスでは呼び出さない。
	private getLayerdStates(): Map<string, Variable>[] {
		const layers: Map<string, Variable>[] = [this.states];
		for (let layer = this.parent; layer != null; layer = layer.parent) {
			layers.push(layer.states);
		}
		return layers;
	}
}
