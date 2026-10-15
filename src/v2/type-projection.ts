export type ProjectionOperation =
	| { kind: 'array'; rest: boolean }
	| { kind: 'property'; key: string }
	| { kind: 'objectRest'; excluded: ReadonlySet<string> };

export type ProjectionAdapter<T> = {
	kind(type: T): string;
	element(type: T): T;
	keyword(name: 'any' | 'number', source: T): T;
	array(element: T, source: T): T;
	property(type: T, key: string): T | undefined;
	objectRest(type: T, excluded: ReadonlySet<string>): T | undefined;
};

/** 構文型と実行時型で、分割できない枝を同じ規則で除く。 */
export function projectBranch<T>(type: T, operation: ProjectionOperation, adapter: ProjectionAdapter<T>): T | undefined {
	const kind = adapter.kind(type);
	if (kind === 'any') return type;
	if (operation.kind === 'array') {
		if (kind === 'array') return operation.rest ? type : adapter.element(type);
		if (kind === 'string') return operation.rest ? adapter.array(type, type) : type;
		return undefined;
	}
	if (kind === 'null') return undefined;
	if (operation.kind === 'objectRest') return adapter.objectRest(type, operation.excluded) ?? adapter.keyword('any', type);
	if (kind === 'array') {
		if (/^(0|[1-9][0-9]*)$/.test(operation.key) && Number(operation.key) < 4294967295) return adapter.element(type);
		return adapter.keyword(operation.key === 'length' ? 'number' : 'any', type);
	}
	return adapter.property(type, operation.key) ?? adapter.keyword('any', type);
}

export function combineProjections<T>(parts: readonly (T | undefined)[], adapter: ProjectionAdapter<T>, union: (types: T[]) => T): T | undefined {
	const types: T[] = [];
	for (const part of parts) {
		if (part === undefined) continue;
		if (adapter.kind(part) === 'any') return part;
		types.push(part);
	}
	return types.length === 0 ? undefined : types.length === 1 ? types[0] : union(types);
}
