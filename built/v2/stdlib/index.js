import { basicDefinitions } from "./basics.js";
import { catalogOf, makeFunction } from "./core.js";
import { arrayDefinitions, iteratorDefinitions } from "./arrays.js";
import { serviceDefinitions } from "./services.js";
import { objectDefinitions } from "./objects.js";
import { collectionDefinitions } from "./collections.js";
import { stringDefinitions } from "./strings.js";
import { mathConstants, numberDefinitions } from "./numbers.js";

//#region src/v2/stdlib/index.ts
const definitions = [
	...basicDefinitions,
	...numberDefinitions,
	...stringDefinitions,
	...arrayDefinitions,
	...collectionDefinitions,
	...objectDefinitions,
	...serviceDefinitions,
	...iteratorDefinitions
];
const constantDefinitions = [
	{
		name: "NaN",
		value: NaN,
		description: {
			ja: "数でない数値を表します。",
			en: "Represent a not-a-number value."
		}
	},
	{
		name: "Infinity",
		value: Infinity,
		description: {
			ja: "正の無限大を表します。",
			en: "Represent positive infinity."
		}
	},
	...Object.entries(mathConstants).map(([name, value]) => ({
		name: `Math.${name}`,
		value,
		description: {
			ja: `数学定数 ${name} です。`,
			en: `The mathematical constant ${name}.`
		}
	}))
].map((definition) => ({
	...definition,
	receiver: "global",
	kind: "constant",
	args: [],
	returns: "number"
}));
const catalog = [...catalogOf(definitions), ...constantDefinitions.map(({ value: _, ...metadata }) => metadata)];
const methods = Object.create(null);
for (const type of [
	"array",
	"string",
	"number",
	"iterator"
]) methods[type] = Object.create(null);
const keys = /* @__PURE__ */ new Set();
for (const definition of definitions) {
	const key = `${definition.receiver}:${definition.name}`;
	if (keys.has(key)) throw new Error(`Duplicate standard definition: ${key}`);
	keys.add(key);
	if (definition.receiver !== "global") methods[definition.receiver][definition.name] = makeFunction(definition);
}
function standardMethod(type, name) {
	return methods[type][name] ?? null;
}
function standardGlobals() {
	const globals = Object.create(null);
	for (const definition of definitions) if (definition.receiver === "global" && !definition.name.includes(".")) globals[definition.name] = makeFunction(definition);
	for (const definition of definitions) {
		if (definition.receiver !== "global" || !definition.name.includes(".")) continue;
		const [namespace, name] = definition.name.split(".");
		const object = globals[namespace] ??= Object.create(null);
		Object.defineProperty(object, name, {
			value: makeFunction(definition),
			enumerable: false,
			writable: true,
			configurable: true
		});
	}
	for (const definition of constantDefinitions) {
		const [namespace, name] = definition.name.split(".");
		if (name === void 0) globals[namespace] = definition.value;
		else Object.defineProperty(globals[namespace], name, {
			value: definition.value,
			enumerable: false,
			writable: false,
			configurable: false
		});
	}
	return globals;
}

//#endregion
export { catalog, constantDefinitions, definitions, standardGlobals, standardMethod };
//# sourceMappingURL=index.js.map