import type * as A from '../ast.js';
import { runtimeError } from './errors.js';
import type { Value } from './values.js';

export type Binding = { initialized: boolean; mutable: boolean; value: Value };
export class Environment {
	readonly bindings = new Map<string, Binding>();
	constructor(readonly parent: Environment | null = null) {}
	declare(name: string, mutable: boolean): void {
		if (!this.bindings.has(name)) this.bindings.set(name, { initialized: false, mutable, value: null });
	}
	resolve(name: string): Binding | undefined {
		return this.bindings.get(name) ?? this.parent?.resolve(name);
	}
	read(name: string, pos: A.Pos): Value {
		const binding = this.resolve(name);
		if (!binding) throw runtimeError('UNBOUND_IDENTIFIER', pos, { name }, 'ReferenceError');
		if (!binding.initialized) throw runtimeError('TDZ_ACCESS', pos, { name }, 'ReferenceError');
		return binding.value;
	}
	write(name: string, value: Value, pos: A.Pos, initialize = false): void {
		const binding = initialize ? this.bindings.get(name) : this.resolve(name);
		if (!binding) throw runtimeError('UNBOUND_IDENTIFIER', pos, { name }, 'ReferenceError');
		if (!initialize && !binding.initialized) throw runtimeError('TDZ_ACCESS', pos, { name }, 'ReferenceError');
		if (!initialize && !binding.mutable) throw runtimeError('CONST_ASSIGNMENT', pos, { name }, 'TypeError');
		binding.value = value;
		binding.initialized = true;
	}
	iteration(): Environment {
		const next = new Environment(this.parent);
		for (const [name, binding] of this.bindings) next.bindings.set(name, { ...binding });
		return next;
	}
}

export function boundNames(pattern: A.Pattern | A.MemberExpression): string[] {
	switch (pattern.type) {
		case 'Identifier': return [pattern.name];
		case 'MemberExpression': return [];
		case 'AssignmentPattern': return boundNames(pattern.left);
		case 'RestElement': return boundNames(pattern.argument);
		case 'ArrayPattern': return pattern.elements.flatMap(p => p ? boundNames(p) : []);
		case 'ObjectPattern': return pattern.properties.flatMap(p => boundNames(p.type === 'RestElement' ? p.argument : p.value as A.Pattern));
	}
}
