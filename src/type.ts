import { AiScriptSyntaxError } from './error.js';
import type * as Ast from './node.js';

export type TSimple<N extends string = string> = {
	type: 'simple';
	name: N;
}

export function T_SIMPLE<T extends string>(name: T): TSimple<T> {
	return {
		type: 'simple',
		name: name,
	};
}

export type TGeneric<N extends string = string> = {
	type: 'generic';
	name: N;
	inners: Type[];
}

export function T_GENERIC<N extends string>(name: N, inners: Type[]): TGeneric<N> {
	return {
		type: 'generic',
		name: name,
		inners: inners,
	};
}

export type TFn = {
	type: 'fn';
	params: Type[];
	result: Type;
};

export function T_FN(params: Type[], result: Type): TFn {
	return {
		type: 'fn',
		params,
		result,
	};
}

export type TParam = {
	type: 'param';
	name: string;
}

export function T_PARAM(name: string): TParam {
	return {
		type: 'param',
		name,
	};
}

export type TUnion = {
	type: 'union';
	inners: Type[];
}

export function T_UNION(inners: Type[]): TUnion {
	return {
		type: 'union',
		inners,
	};
}

export type Type = TSimple | TGeneric | TFn | TParam | TUnion;

export function getTypeNameBySource(typeSource: Ast.TypeSource): string {
	switch (typeSource.type) {
		case 'namedTypeSource': {
			if (typeSource.inner) {
				const inner = getTypeNameBySource(typeSource.inner);
				return `${typeSource.name}<${inner}>`;
			} else {
				return typeSource.name;
			}
		}
		case 'fnTypeSource': {
			const params = typeSource.params.map(param => getTypeNameBySource(param)).join(', ');
			const result = getTypeNameBySource(typeSource.result);
			return `@(${params}) => ${result}`;
		}
		case 'unionTypeSource': {
			return typeSource.inners.map(inner => getTypeNameBySource(inner)).join(' | ');
		}
	}
}

export function getTypeBySource(typeSource: Ast.TypeSource, typeParams?: readonly Ast.TypeParam[]): Type {
	if (typeSource.type === 'namedTypeSource') {
		const typeParam = typeParams?.find((param) => param.name === typeSource.name);
		if (typeParam != null && typeSource.inner == null) {
			return T_PARAM(typeParam.name);
		}

		switch (typeSource.name) {
			case 'null':
			case 'bool':
			case 'num':
			case 'str':
			case 'error':
			case 'never':
			case 'any':
			case 'void': {
				if (typeSource.inner == null) {
					return T_SIMPLE(typeSource.name);
				}
				break;
			}
			case 'arr':
			case 'obj': {
				let innerType: Type;
				if (typeSource.inner != null) {
					innerType = getTypeBySource(typeSource.inner, typeParams);
				} else {
					innerType = T_SIMPLE('any');
				}
				return T_GENERIC(typeSource.name, [innerType]);
			}
		}
		throw new AiScriptSyntaxError(`Unknown type: '${getTypeNameBySource(typeSource)}'`, typeSource.loc.start);
	} else if (typeSource.type === 'fnTypeSource') {
		let fnTypeParams = typeSource.typeParams;
		if (typeParams != null) {
			fnTypeParams = fnTypeParams.concat(typeParams);
		}
		const paramTypes = typeSource.params.map(param => getTypeBySource(param, fnTypeParams));
		return T_FN(paramTypes, getTypeBySource(typeSource.result, fnTypeParams));
	} else {
		const innerTypes = typeSource.inners.map(inner => getTypeBySource(inner, typeParams));
		return T_UNION(innerTypes);
	}
}
