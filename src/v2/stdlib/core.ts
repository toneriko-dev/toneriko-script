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
export interface StdDefinition {
	name: string;
	receiver: 'global' | 'array' | 'string' | 'number' | 'iterator';
	args: { name: string; type: string; optional?: boolean; rest?: boolean }[];
	returns: string;
	description: { ja: string; en: string };
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
