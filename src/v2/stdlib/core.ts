import type { CatalogFunction } from '../catalog.js';
import type { RuntimeServices } from './services.js';
import type { Pos } from '../ast.js';
import type { PropertyAccess, Value } from '../runtime/values.js';
import { runtimeError } from '../runtime/errors.js';

export type StdFrame = Generator<any, Value, any>;
export interface StdContext {
	pos: Pos;
	services?: RuntimeServices;
	wait?(promise: PromiseLike<unknown>): StdFrame;
	parallel?(fn: Value, args: Value[]): Promise<Value>;
	properties: PropertyAccess;
	tick(): void;
	checkpoint(): StdFrame;
	call(fn: Value, args: Value[], receiver?: Value): StdFrame | { ready: Value };
}
export interface StdDefinition extends CatalogFunction {
	implementation(ctx: StdContext, receiver: Value, args: Value[]): StdFrame;
}
export const STANDARD_FUNCTION = Symbol('standard function');
export interface StdFunction {
	[STANDARD_FUNCTION]: StdDefinition;
}
export function isStdFunction(value: unknown): value is StdFunction {
	return typeof value === 'object' && value !== null && Object.getOwnPropertyDescriptor(value, STANDARD_FUNCTION)?.value !== undefined;
}
export function makeFunction(definition: StdDefinition): StdFunction {
	return Object.assign(Object.create(null), { [STANDARD_FUNCTION]: definition });
}
// 標準の名前空間から、名前と同じ名前の JavaScript の組み込みへの対応です。組み込みにだけある名前を読んだときに、まだ使えないと案内します。
const namespaces = new WeakMap<object, { name: string; origin: object }>();
export function registerNamespace(namespace: object, name: string, origin: object): void {
	namespaces.set(namespace, { name, origin });
}
export function isNamespace(value: object): boolean {
	return namespaces.has(value);
}
/** 組み込みにだけある名前なら、案内に使う名前空間付きの名前を返します。 */
export function unavailableNamespaceMember(value: object, key: string): string | null {
	const namespace = namespaces.get(value);
	return namespace !== undefined && Object.hasOwn(namespace.origin, key) ? `${namespace.name}.${key}` : null;
}
export function requireNumber(ctx: StdContext, value: unknown): number {
	if (typeof value !== 'number') throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'number' }, 'TypeError');
	return value;
}
export function requireString(ctx: StdContext, value: unknown): string {
	if (typeof value !== 'string') throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'string' }, 'TypeError');
	return value;
}
export function requireArray(ctx: StdContext, value: unknown): Value[] {
	if (!Array.isArray(value)) throw runtimeError('STDLIB_ARGUMENT_TYPE', ctx.pos, { expected: 'any[]' }, 'TypeError');
	return value;
}
export function validateArguments(ctx: StdContext, definition: StdDefinition, args: Value[]): void {
	const required = definition.args.filter(arg => !arg.optional && !arg.rest).length;
	if (args.length < required) throw runtimeError('STDLIB_ARGUMENT_COUNT', ctx.pos, { name: definition.name, count: required }, 'TypeError');
}
export function catalogOf(definitions: readonly StdDefinition[]) {
	return definitions.map(({ implementation: _, ...metadata }) => metadata);
}
