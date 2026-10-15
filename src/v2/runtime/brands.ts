import { registerScriptArray, registerPrivateObject } from './array-trust.js';
import type * as AST from '../ast.js';
import { isStdFunction } from '../stdlib/core.js';

export type Value = null | boolean | number | string | object;
export const SCRIPT_FUNCTION = Symbol('script function');
export interface ScriptFunction {
	[SCRIPT_FUNCTION]: true;
	name?: string;
	params: AST.Pattern[];
	body: AST.BlockStatement | AST.Expression;
	environment: unknown;
}
export function isScriptFunction(value: unknown): value is ScriptFunction {
	return typeof value === 'object' && value !== null && Object.getOwnPropertyDescriptor(value, SCRIPT_FUNCTION)?.value === true;
}
export function valueTypeof(value: Value): string {
	return isScriptFunction(value) || isStdFunction(value) ? 'function' : typeof value;
}

export const scriptObjects = new WeakSet<object>();

/** 通常の辞書と配列の作成元だけを記録し、ホストへ渡した後も現在の原型を別に確かめます。 */
export function scriptObject<T extends object>(value: T): T {
	scriptObjects.add(value);
	registerPrivateObject(value);
	if (Array.isArray(value)) registerScriptArray(value);
	return value;
}

