import { serviceDefinitions } from './services.js';
import { objectDefinitions } from './objects.js';
import { collectionDefinitions } from './collections.js';
import { arrayDefinitions } from './arrays.js';
import { stringDefinitions } from './strings.js';
import { numberDefinitions, mathConstants } from './numbers.js';
import { basicDefinitions } from './basics.js';
import { catalogOf, makeFunction, type StdDefinition, type StdFunction } from './core.js';
import type { Value } from '../runtime/values.js';

export const definitions: readonly StdDefinition[] = [...basicDefinitions, ...numberDefinitions, ...stringDefinitions, ...arrayDefinitions, ...collectionDefinitions, ...objectDefinitions, ...serviceDefinitions];
export const catalog = catalogOf(definitions);
const methods: Record<string, Record<string, StdFunction>> = Object.create(null);
for (const type of ['array', 'string', 'number']) methods[type] = Object.create(null);
const keys = new Set<string>();
for (const definition of definitions) {
	const key = `${definition.receiver}:${definition.name}`;
	if (keys.has(key)) throw new Error(`Duplicate standard definition: ${key}`);
	keys.add(key);
	if (definition.receiver !== 'global') methods[definition.receiver]![definition.name] = makeFunction(definition);
}
export function standardMethod(type: 'array' | 'string' | 'number', name: string): StdFunction | null {
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
		Object.defineProperty(object, name, { value: makeFunction(definition), enumerable: true, writable: true, configurable: true });
	}
	Object.assign(globals['Math'] as object, mathConstants);
	return globals;
}
