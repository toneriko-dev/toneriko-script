import { TonerikoScriptRuntimeError } from "../error.js";

//#region src/interpreter/scope.ts
var Scope = class Scope {
	typeParams;
	parent;
	states;
	name;
	opts = {};
	nsName;
	constructor(states = /* @__PURE__ */ new Map(), parent, name, nsName, typeParams = []) {
		this.typeParams = typeParams;
		this.states = states;
		this.parent = parent;
		this.name = name || (parent == null ? "<root>" : "<anonymous>");
		this.nsName = nsName;
	}
	log(type, params) {
		if (this.parent) this.parent.log(type, params);
		else if (this.opts.log) this.opts.log(type, params);
	}
	onUpdated(name, value) {
		if (this.parent) this.parent.onUpdated(name, value);
		else if (this.opts.onUpdated) this.opts.onUpdated(name, value);
	}
	createChildScope(states = /* @__PURE__ */ new Map(), name, typeParams = []) {
		return new Scope(states, this, name, void 0, typeParams);
	}
	createChildNamespaceScope(nsName, states = /* @__PURE__ */ new Map(), name) {
		return new Scope(states, this, name, nsName);
	}
	getTypeParams() {
		return [...this.typeParams, ...this.parent?.getTypeParams() ?? []];
	}
	get(name) {
		let variable = this.states.get(name);
		for (let layer = this.parent; variable == null && layer != null; layer = layer.parent) variable = layer.states.get(name);
		if (variable != null) {
			this.log("read", {
				var: name,
				val: variable.value
			});
			return variable.value;
		}
		throw new TonerikoScriptRuntimeError(`No such variable '${name}' in scope '${this.name}'`, { scope: this.getLayerdStates() });
	}
	getNsPrefix() {
		if (this.parent == null || this.nsName == null) return "";
		return this.parent.getNsPrefix() + this.nsName + ":";
	}
	exists(name) {
		let found = this.states.has(name);
		for (let layer = this.parent; !found && layer != null; layer = layer.parent) found = layer.states.has(name);
		if (found) {
			this.log("exists", { var: name });
			return true;
		}
		this.log("not exists", { var: name });
		return false;
	}
	getAll() {
		const vars = /* @__PURE__ */ new Map();
		for (const [key, variable] of this.states) vars.set(key, variable);
		for (let layer = this.parent; layer != null; layer = layer.parent) for (const [key, variable] of layer.states) if (!vars.has(key)) vars.set(key, variable);
		return vars;
	}
	add(name, variable) {
		this.log("add", {
			var: name,
			val: variable
		});
		if (this.states.has(name)) throw new TonerikoScriptRuntimeError(`Variable '${name}' already exists in scope '${this.name}'`, { scope: this.getLayerdStates() });
		this.states.set(name, variable);
		if (this.parent == null) this.onUpdated(name, variable.value);
		else if (this.nsName != null) this.parent.add(this.nsName + ":" + name, variable);
	}
	assign(name, val) {
		const own = this.states.get(name);
		if (own != null) {
			if (!own.isMutable) throw new TonerikoScriptRuntimeError(`Cannot assign to an immutable variable ${name}.`);
			own.value = val;
			this.log("assign", {
				var: name,
				val
			});
			if (this.parent == null) this.onUpdated(name, val);
			return;
		}
		for (let layer = this.parent; layer != null; layer = layer.parent) {
			const variable = layer.states.get(name);
			if (variable != null) {
				if (!variable.isMutable) throw new TonerikoScriptRuntimeError(`Cannot assign to an immutable variable ${name}.`);
				variable.value = val;
				this.log("assign", {
					var: name,
					val
				});
				if (layer.parent == null) this.onUpdated(name, val);
				return;
			}
		}
		throw new TonerikoScriptRuntimeError(`No such variable '${name}' in scope '${this.name}'`, { scope: this.getLayerdStates() });
	}
	update(name, updater) {
		const own = this.states.get(name);
		if (own != null) {
			const val = updater(own.value);
			if (!own.isMutable) throw new TonerikoScriptRuntimeError(`Cannot assign to an immutable variable ${name}.`);
			own.value = val;
			this.log("assign", {
				var: name,
				val
			});
			if (this.parent == null) this.onUpdated(name, val);
			return;
		}
		for (let layer = this.parent; layer != null; layer = layer.parent) {
			const variable = layer.states.get(name);
			if (variable != null) {
				const val = updater(variable.value);
				if (!variable.isMutable) throw new TonerikoScriptRuntimeError(`Cannot assign to an immutable variable ${name}.`);
				variable.value = val;
				this.log("assign", {
					var: name,
					val
				});
				if (layer.parent == null) this.onUpdated(name, val);
				return;
			}
		}
		throw new TonerikoScriptRuntimeError(`No such variable '${name}' in scope '${this.name}'`, { scope: this.getLayerdStates() });
	}
	getLayerdStates() {
		const layers = [this.states];
		for (let layer = this.parent; layer != null; layer = layer.parent) layers.push(layer.states);
		return layers;
	}
};

//#endregion
export { Scope };
//# sourceMappingURL=scope.js.map