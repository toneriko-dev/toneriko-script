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

	/**
	 * 指定した名前の変数を取得します
	 * @param name - 変数名
	 */
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

	/**
	 * 名前空間名を取得します。
	 */
	public getNsPrefix(): string {
		if (this.parent == null || this.nsName == null) return '';
		return this.parent.getNsPrefix() + this.nsName + ':';
	}

	/**
	 * 指定した名前の変数が存在するか判定します
	 * @param name - 変数名
	 */
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

	/**
	 * 現在のスコープに存在する全ての変数を取得します
	 */
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

	/**
	 * 指定した名前の変数を現在のスコープに追加します。名前空間である場合は接頭辞を付して親のスコープにも追加します
	 * @param name - 変数名
	 * @param val - 初期値
	 */
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

	/**
	 * 指定した名前の変数に値を再代入します
	 * @param name - 変数名
	 * @param val - 値
	 */
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

	/**
	 * 指定した名前の変数を1回のスコープ探索で取得・更新します(get()してからassign()すると
	 * 同じ変数を2回探索することになるため、+=/-=のような複合代入で使います)
	 * @param name - 変数名
	 * @param updater - 現在値を受け取り新しい値を返す関数(不正な現在値なら例外を投げてよい)
	 */
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

	/**
	 * エラー情報用に、自身から祖先方向へ辿った各レイヤーのMapを配列として構築します(ホットパスの get/exists/assign では使いません)
	 */
	private getLayerdStates(): Map<string, Variable>[] {
		const layers: Map<string, Variable>[] = [this.states];
		for (let layer = this.parent; layer != null; layer = layer.parent) {
			layers.push(layer.states);
		}
		return layers;
	}
}
