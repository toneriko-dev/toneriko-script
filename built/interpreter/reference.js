import { TonerikoScriptIndexOutOfRangeError } from "../error.js";
import { ARR, NULL, OBJ } from "./value.js";
import { assertArray, assertObject } from "./util.js";

//#region src/interpreter/reference.ts
function assertArrayIndex(index, length) {
	if (!Number.isInteger(index) || index < 0 || length <= index) throw new TonerikoScriptIndexOutOfRangeError(`Index out of range. index: ${index} max: ${length - 1}`);
}
const Reference = {
	variable(name, scope) {
		return new VariableReference(name, scope);
	},
	index(target, index) {
		return new IndexReference(target.value, index);
	},
	prop(target, name) {
		return new PropReference(target.value, name);
	},
	arr(dest) {
		return new ArrReference(dest);
	},
	obj(dest) {
		return new ObjReference(dest);
	}
};
var VariableReference = class {
	name;
	scope;
	constructor(name, scope) {
		this.name = name;
		this.scope = scope;
		this.type = "reference";
	}
	type;
	get() {
		return this.scope.get(this.name);
	}
	set(value) {
		this.scope.assign(this.name, value);
	}
};
var IndexReference = class {
	target;
	index;
	constructor(target, index) {
		this.target = target;
		this.index = index;
		this.type = "reference";
	}
	type;
	get() {
		this.assertIndexInRange();
		return this.target[this.index];
	}
	set(value) {
		this.assertIndexInRange();
		this.target[this.index] = value;
	}
	assertIndexInRange() {
		assertArrayIndex(this.index, this.target.length);
	}
};
var PropReference = class {
	target;
	index;
	constructor(target, index) {
		this.target = target;
		this.index = index;
		this.type = "reference";
	}
	type;
	get() {
		return this.target.get(this.index) ?? NULL;
	}
	set(value) {
		this.target.set(this.index, value);
	}
};
var ArrReference = class {
	items;
	constructor(items) {
		this.items = items;
		this.type = "reference";
	}
	type;
	get() {
		return ARR(this.items.map((item) => item.get()));
	}
	set(value) {
		assertArray(value);
		for (const [index, item] of this.items.entries()) item.set(value.value[index] ?? NULL);
	}
};
var ObjReference = class {
	entries;
	constructor(entries) {
		this.entries = entries;
		this.type = "reference";
	}
	type;
	get() {
		return OBJ(new Map([...this.entries].map(([key, item]) => [key, item.get()])));
	}
	set(value) {
		assertObject(value);
		for (const [key, item] of this.entries.entries()) item.set(value.value.get(key) ?? NULL);
	}
};

//#endregion
export { Reference, assertArrayIndex };
//# sourceMappingURL=reference.js.map