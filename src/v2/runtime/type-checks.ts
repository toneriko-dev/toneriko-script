import type * as A from '../ast.js';
import { runtimeError } from './errors.js';
import { isScriptFunction, valueTypeof, type Value, type PropertyAccess } from './values.js';
import { projectBranch, combineProjections, type ProjectionAdapter, type ProjectionOperation } from '../type-projection.js';
import { isStdFunction } from '../stdlib/core.js';

export type TypePropertyCheck = { key: string; optional: boolean; check: TypeCheck };
export type TypeCheck =
	| { kind: 'number' | 'string' | 'boolean' | 'null' | 'any' | 'void' | 'function' }
	| { kind: 'array'; element: TypeCheck }
	| { kind: 'object'; properties: TypePropertyCheck[]; byKey: ReadonlyMap<string, TypePropertyCheck> }
	| { kind: 'union'; types: TypeCheck[] }
	| { kind: 'projection'; source: TypeCheck; operation: { kind: 'key'; key: string | null; rest: boolean } | { kind: 'rest'; excluded: ReadonlySet<string> }; resolved?: TypeCheck | null };

export function objectCheck(properties: TypePropertyCheck[]): TypeCheck {
	return { kind: 'object', properties, byKey: new Map(properties.map(property => [property.key, property])) };
}

export function compileType(annotation: A.TypeAnnotation): TypeCheck {
	const compiled = new Map<A.TypeAnnotation, TypeCheck>();
	const pending: { node: A.TypeAnnotation; ready: boolean }[] = [{ node: annotation, ready: false }];
	while (pending.length) {
		const { node, ready } = pending.pop()!;
		if (!ready) {
			pending.push({ node, ready: true });
			const children = node.type === 'ParenthesizedTypeAnnotation' ? [node.typeAnnotation] : node.type === 'ArrayTypeAnnotation' ? [node.elementType] : node.type === 'UnionTypeAnnotation' ? node.types : node.type === 'ObjectTypeAnnotation' ? node.properties.map(property => property.typeAnnotation) : [];
			for (const child of children) pending.push({ node: child, ready: false });
			continue;
		}
		switch (node.type) {
			case 'KeywordTypeAnnotation': compiled.set(node, { kind: node.name }); break;
			case 'FunctionTypeAnnotation': compiled.set(node, { kind: 'function' }); break;
			case 'ParenthesizedTypeAnnotation': compiled.set(node, compiled.get(node.typeAnnotation)!); break;
			case 'ArrayTypeAnnotation': compiled.set(node, { kind: 'array', element: compiled.get(node.elementType)! }); break;
			case 'UnionTypeAnnotation': compiled.set(node, { kind: 'union', types: node.types.map(part => compiled.get(part)!) }); break;
			case 'ObjectTypeAnnotation': compiled.set(node, objectCheck(node.properties.map(property => ({ key: property.key.type === 'Identifier' ? property.key.name : String(property.key.value), optional: property.optional, check: compiled.get(property.typeAnnotation)! })))); break;
		}
	}
	return compiled.get(annotation)!;
}

const projectionAdapter: ProjectionAdapter<TypeCheck> = {
	kind: type => type.kind,
	element: type => (type as Extract<TypeCheck, {kind:'array'}>).element,
	keyword: kind => ({kind}),
	array: element => ({kind:'array',element}),
	property: (type, key) => {
		if (type.kind !== 'object') return undefined;
		const property = type.byKey.get(key);
		return property ? property.optional ? {kind:'union',types:[property.check,{kind:'null'}]} : property.check : undefined;
	},
	objectRest: () => undefined,
};

/** 投影の展開は検査時に限り、広い合併型や rest の作業も実行予算に含める。 */
function* resolveType(check: TypeCheck, tick: () => boolean): Generator<void, TypeCheck | undefined> {
	if (check.kind !== 'projection') return check;
	if (check.resolved !== undefined) return check.resolved ?? undefined;
	if (tick()) yield;
	const source = yield* resolveType(check.source, tick);
	if (!source) { check.resolved = null; return undefined; }
	const operation: ProjectionOperation = check.operation.kind === 'rest'
		? {kind:'objectRest',excluded:check.operation.excluded}
		: check.operation.key === null ? {kind:'array',rest:check.operation.rest} : {kind:'property',key:check.operation.key};
	let result: TypeCheck | undefined;
	if (source.kind === 'union') {
		const types: (TypeCheck | undefined)[] = [];
		for (const part of source.types) {
			types.push(yield* resolveType({kind:'projection',source:part,operation:check.operation},tick));
		}
		result = combineProjections(types, projectionAdapter, types => ({kind:'union',types}), operation);
	} else {
		let rest: TypeCheck | undefined;
		if (operation.kind === 'objectRest' && source.kind === 'object') {
			const properties: TypePropertyCheck[] = [];
			for (const property of source.properties) {
				if (!operation.excluded.has(property.key)) properties.push(property);
				if (tick()) yield;
			}
			rest = objectCheck(properties);
		}
		result = projectBranch(source, operation, {...projectionAdapter,objectRest:()=>rest});
	}
	check.resolved = result ?? null;
	return result;
}

function resolvedType(check: TypeCheck): TypeCheck {
	const iterator = resolveType(check, () => false);
	let result = iterator.next();
	while (!result.done) result = iterator.next();
	return result.value ?? {kind:'any'};
}

export function typeName(check: TypeCheck): string {
	const parts: string[] = [];
	const pending: (string | TypeCheck)[] = [check];
	while (pending.length) {
		const part = pending.pop()!;
		if (typeof part === 'string') { parts.push(part); continue; }
		switch (part.kind) {
			case 'projection': pending.push(resolvedType(part)); break;
			case 'array': {
				const element = part.element.kind === 'projection' ? resolvedType(part.element) : part.element;
				if (element.kind === 'union') pending.push(')[]', element, '(');
				else pending.push('[]', element);
				break;
			}
			case 'object':
				pending.push(' }');
				for (let i = part.properties.length - 1; i >= 0; i--) {
					const property = part.properties[i]!;
					if (i < part.properties.length - 1) pending.push(', ');
					pending.push(property.check, `${property.key}${property.optional ? '?' : ''}: `);
				}
				pending.push('{ '); break;
			case 'union':
				for (let i = part.types.length - 1; i >= 0; i--) { if (i < part.types.length - 1) pending.push(' | '); pending.push(part.types[i]!); }
				break;
			case 'function': parts.push('Function'); break;
			default: parts.push(part.kind);
		}
	}
	return parts.join('');
}

export function isComposite(check: TypeCheck): boolean {
	return check.kind === 'array' || check.kind === 'object' || check.kind === 'union' || check.kind === 'projection';
}

export function matchesOuter(check: TypeCheck, value: Value): boolean {
	switch (check.kind) {
		case 'projection': return matchesOuter(resolvedType(check), value);
		case 'any': return true;
		case 'void': case 'null': return value === null;
		case 'function': return typeof value === 'function' || isScriptFunction(value) || isStdFunction(value);
		case 'array': return Array.isArray(value);
		case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value) && !isScriptFunction(value) && !isStdFunction(value);
		case 'union': return check.types.some(part => matchesOuter(part, value));
		default: return typeof value === check.kind;
	}
}

function summary(value: Value): string {
	if (typeof value === 'string') return JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}…` : value);
	if (value === null) return 'null';
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) return '[…]';
	return valueTypeof(value) === 'function' || typeof value === 'function' ? 'Function' : '{…}';
}

type Mismatch = { name: string; check: TypeCheck; value: Value; missing?: boolean };
function fail(failure: Mismatch, pos: A.Pos): never {
	throw runtimeError('TYPE_ANNOTATION_MISMATCH', pos, {
		name: failure.name, expected: typeName(failure.check),
		actual: failure.missing ? 'missing' : failure.value === null ? 'null' : Array.isArray(failure.value) ? 'array' : valueTypeof(failure.value),
		value: summary(failure.value),
	}, 'TypeError');
}

export function checkScalar(check: TypeCheck, value: Value, name: string, pos: A.Pos): void {
	// 原始型は typeof 一回で判定し、Function だけ実行時の関数ブランドも確認する。
	if (typeof value === check.kind || check.kind === 'any' || ((check.kind === 'null' || check.kind === 'void') && value === null)) return;
	if (check.kind === 'function' && matchesOuter(check, value)) return;
	fail({ name, check, value }, pos);
}

/** コピー前に射影だけを展開し、同じコピーの走査内で要素を検査する。 */
export function copiedArrayType(check: TypeCheck): Extract<TypeCheck, {kind:'array'}> | undefined {
	const resolved = resolvedType(check);
	return resolved.kind === 'array' ? resolved : undefined;
}

/** コピーの取得直後に外形を確かめ、途中で譲らず実際に束縛する値を守る。 */
export function checkCopiedElement(check: TypeCheck, value: Value, name: string, index: number, pos: A.Pos, diagnosticName: (name: string) => string, tick: () => void): void {
	// 要素自体はコピー走査の予算を使い、合併の実照合枝だけ追加で課金する。
	const matched = check.kind === 'union' || check.kind === 'projection'
		? matchesShallow(check, value, () => { tick(); return false; }).next().value === true
		: matchesOuter(check, value);
	if (!matched) fail({ name: diagnosticName(`${name}[${index}]`), check, value }, pos);
}

/** 合併の枝にも同じ予算を使い、要素の検査では入れ子の外形までに留める。 */
function* matchesShallow(check: TypeCheck, value: Value, tick: () => boolean): Generator<void, boolean> {
	const resolved = yield* resolveType(check, tick);
	if (!resolved) return true;
	check = resolved;
	if (check.kind !== 'union') return matchesOuter(check, value);
	for (const part of check.types) {
		const pause = tick();
		const matched = yield* matchesShallow(part, value, tick);
		if (pause) yield;
		if (matched) return true;
	}
	return false;
}

/** 入れ子の要素は外形だけを調べ、合併型の枝を選ぶときには深さを減らさない。 */
function* mismatch(check: TypeCheck, value: Value, name: string, properties: PropertyAccess, pos: A.Pos, tick: () => boolean): Generator<void, Mismatch | null> {
	const resolved = yield* resolveType(check, tick);
	if (!resolved) return null;
	check = resolved;
	if (check.kind === 'union') {
		for (const part of check.types) {
			const pause = tick();
			const failure = yield* mismatch(part, value, name, properties, pos, tick);
			if (pause) yield;
			if (failure === null) return null;
		}
		return { name, check, value };
	}
	if (!matchesOuter(check, value)) return { name, check, value };
	if (check.kind === 'array') {
		const length = (value as unknown[]).length;
		for (let i = 0; i < length; i++) {
			const pause = tick();
			const item = properties.get(value, i, pos);
			const matched = check.element.kind === 'union' || check.element.kind === 'projection' ? yield* matchesShallow(check.element, item, tick) : matchesOuter(check.element, item);
			if (!matched) return { name: `${name}[${i}]`, check: check.element, value: item };
			if (pause) yield;
		}
	} else if (check.kind === 'object') {
		for (const property of check.properties) {
			const pause = tick();
			if (!properties.has(value, property.key, pos)) {
				if (!property.optional) return { name: `${name}.${property.key}`, check: property.check, value: null, missing: true };
			} else {
				const item = properties.get(value, property.key, pos);
				const matched = property.check.kind === 'union' || property.check.kind === 'projection' ? yield* matchesShallow(property.check, item, tick) : matchesOuter(property.check, item);
				if (!matched) return { name: `${name}.${property.key}`, check: property.check, value: item };
			}
			if (pause) yield;
		}
	}
	return null;
}

export function* checkValue(check: TypeCheck, value: Value, name: string, properties: PropertyAccess, pos: A.Pos, tick: () => void, diagnosticName?: (name: string) => string): Generator<void, void> {
	let steps = 0;
	const step = () => { tick(); return ++steps % 64 === 0; };
	if (check.kind === 'projection') {
		const projected = yield* resolveType(check, step);
		if (!projected || projected.kind === 'any') return;
		check = projected;
	}
	step();
	const failure = yield* mismatch(check, value, name, properties, pos, step);
	if (failure) {
		if (diagnosticName) failure.name = diagnosticName(failure.name);
		fail(failure, pos);
	}
}
