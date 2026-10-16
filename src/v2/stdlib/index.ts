import { serviceDefinitions } from './services.js';
import { objectDefinitions } from './objects.js';
import { collectionDefinitions } from './collections.js';
import { arrayDefinitions, iteratorDefinitions } from './arrays.js';
import { stringDefinitions } from './strings.js';
import { numberDefinitions, mathConstants } from './numbers.js';
import { basicDefinitions } from './basics.js';
import { javascriptNamespaceMembers } from './js-names.js';
import { catalogOf, makeFunction, registerNamespace, type StdDefinition, type StdFunction } from './core.js';
import type { Value } from '../runtime/values.js';

export const definitions: readonly StdDefinition[] = [...basicDefinitions, ...numberDefinitions, ...stringDefinitions, ...arrayDefinitions, ...collectionDefinitions, ...objectDefinitions, ...serviceDefinitions, ...iteratorDefinitions];
export const constantDefinitions = [
	{ name: 'NaN', value: NaN, description: { ja: '数でない数値を表します。', en: 'Represent a not-a-number value.' } },
	{ name: 'Infinity', value: Infinity, description: { ja: '正の無限大を表します。', en: 'Represent positive infinity.' } },
	...Object.entries(mathConstants).map(([name, value]) => ({ name: `Math.${name}`, value, description: { ja: `数学定数 ${name} です。`, en: `The mathematical constant ${name}.` } })),
	{ name: 'Number.MAX_SAFE_INTEGER', value: Number.MAX_SAFE_INTEGER, description: { ja: '誤差なく表せる最大の整数です。', en: 'The largest integer represented exactly.' } },
	{ name: 'Number.MIN_SAFE_INTEGER', value: Number.MIN_SAFE_INTEGER, description: { ja: '誤差なく表せる最小の整数です。', en: 'The smallest integer represented exactly.' } },
].map(definition => ({ ...definition, receiver: 'global' as const, kind: 'constant' as const, args: [], returns: 'number' }));
export const catalog = [...catalogOf(definitions), ...constantDefinitions.map(({ value: _, ...metadata }) => metadata)];
const methods: Record<string, Record<string, StdFunction>> = Object.create(null);
for (const type of ['array', 'string', 'number', 'iterator']) methods[type] = Object.create(null);
const keys = new Set<string>();
for (const definition of definitions) {
	const key = `${definition.receiver}:${definition.name}`;
	if (keys.has(key)) throw new Error(`Duplicate standard definition: ${key}`);
	keys.add(key);
	if (definition.receiver !== 'global') methods[definition.receiver]![definition.name] = makeFunction(definition);
}
export function standardMethod(type: 'array' | 'string' | 'number' | 'iterator', name: string): StdFunction | null {
	return methods[type]![name] ?? null;
}
export function standardGlobals(): Record<string, Value> {
	const globals: Record<string, Value> = Object.create(null);
	// 呼べる名前空間を先に作り、同じ値に静的な関数を登録します。
	for (const definition of definitions) if (definition.receiver === 'global' && !definition.name.includes('.')) globals[definition.name] = makeFunction(definition);
	for (const definition of definitions) {
		if (definition.receiver !== 'global' || !definition.name.includes('.')) continue;
		const [namespace, name] = definition.name.split('.') as [string, string];
		const object = globals[namespace] ??= Object.create(null);
		Object.defineProperty(object, name, { value: makeFunction(definition), enumerable: false, writable: true, configurable: true });
	}
	for (const definition of constantDefinitions) {
		const [namespace, name] = definition.name.split('.');
		if (name === undefined) globals[namespace!] = definition.value;
		else Object.defineProperty(globals[namespace!]!, name, { value: definition.value, enumerable: false, writable: false, configurable: false });
	}
	// parseInt や Error のような名前空間でない標準関数は登録せず、無いプロパティの読み取りを UNSUPPORTED_VALUE のままにします。
	for (const name of Object.keys(javascriptNamespaceMembers)) if (globals[name] !== null && typeof globals[name] === 'object') registerNamespace(globals[name], name);
	return globals;
}
