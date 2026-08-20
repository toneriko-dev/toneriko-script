export type Pos = {
	line: number;
	column: number;
};

export type Loc = {
	start: Pos;
	end: Pos;
};

export type Node = Namespace | Meta | Statement | Expression | TypeSource | Attribute;

type NodeBase = {
	loc: Loc;
};

export type Namespace = NodeBase & {
	type: 'ns';
	name: string;
	members: (Definition | Namespace)[];
};

export type Meta = NodeBase & {
	type: 'meta';
	name: string | null;
	value: Expression;
};

export type Statement =
	Definition |
	Return |
	Each |
	For |
	Loop |
	Break |
	Continue |
	Assign |
	AddAssign |
	SubAssign;

const statementTypes = new Set([
	'def', 'return', 'each', 'for', 'loop', 'break', 'continue', 'assign', 'addAssign', 'subAssign',
]);
export function isStatement(x: Node): x is Statement {
	return statementTypes.has(x.type);
}

export type Definition = NodeBase & {
	type: 'def';
	dest: Expression;
	varType?: TypeSource;
	expr: Expression;
	mut: boolean;
	attr: Attribute[];
};

export type Attribute = NodeBase & {
	type: 'attr';
	name: string;
	value: Expression;
};

export type Return = NodeBase & {
	type: 'return';
	expr: Expression;
};

export type Each = NodeBase & {
	type: 'each';
	label?: string;
	var: Expression;
	items: Expression;
	for: Statement | Expression;
};

export type For = NodeBase & {
	type: 'for';
	label?: string;
	var?: string;
	from?: Expression;
	to?: Expression;
	step?: Expression;
	times?: Expression;
	for: Statement | Expression;
};

export type Loop = NodeBase & {
	type: 'loop';
	label?: string;
	statements: (Statement | Expression)[];
};

export type Break = NodeBase & {
	type: 'break';
	label?: string;
	expr?: Expression;
};

export type Continue = NodeBase & {
	type: 'continue';
	label?: string;
};

export type AddAssign = NodeBase & {
	type: 'addAssign';
	dest: Expression;
	expr: Expression;
};

export type SubAssign = NodeBase & {
	type: 'subAssign';
	dest: Expression;
	expr: Expression;
};

export type Assign = NodeBase & {
	type: 'assign';
	dest: Expression;
	expr: Expression;
};

export type Expression =
	If |
	Fn |
	Match |
	Block |
	Exists |
	Tmpl |
	Str |
	Num |
	Bool |
	Null |
	Obj |
	Arr |
	Plus |
	Minus |
	Not |
	Pow |
	Mul |
	Div |
	Rem |
	Add |
	Sub |
	Lt |
	Lteq |
	Gt |
	Gteq |
	Eq |
	Neq |
	And |
	Or |
	Identifier |
	Call |
	Index |
	Prop;

export type Plus = NodeBase & {
	type: 'plus';
	expr: Expression;
};

export type Minus = NodeBase & {
	type: 'minus';
	expr: Expression;
};

export type Not = NodeBase & {
	type: 'not';
	expr: Expression;
};

export type Pow = NodeBase & {
	type: 'pow';
	left: Expression;
	right: Expression;
}

export type Mul = NodeBase & {
	type: 'mul';
	left: Expression;
	right: Expression;
}

export type Div = NodeBase & {
	type: 'div';
	left: Expression;
	right: Expression;
}

export type Rem = NodeBase & {
	type: 'rem';
	left: Expression;
	right: Expression;
}

export type Add = NodeBase & {
	type: 'add';
	left: Expression;
	right: Expression;
}

export type Sub = NodeBase & {
	type: 'sub';
	left: Expression;
	right: Expression;
}

export type Lt = NodeBase & {
	type: 'lt';
	left: Expression;
	right: Expression;
}

export type Lteq = NodeBase & {
	type: 'lteq';
	left: Expression;
	right: Expression;
}

export type Gt = NodeBase & {
	type: 'gt';
	left: Expression;
	right: Expression;
}

export type Gteq = NodeBase & {
	type: 'gteq';
	left: Expression;
	right: Expression;
}

export type Eq = NodeBase & {
	type: 'eq';
	left: Expression;
	right: Expression;
}

export type Neq = NodeBase & {
	type: 'neq';
	left: Expression;
	right: Expression;
}

export type And = NodeBase & {
	type: 'and';
	left: Expression;
	right: Expression;
}

export type Or = NodeBase & {
	type: 'or';
	left: Expression;
	right: Expression;
}

export type If = NodeBase & {
	type: 'if';
	label?: string;
	cond: Expression;
	then: Statement | Expression;
	elseif: {
		cond: Expression;
		then: Statement | Expression;
	}[];
	else?: Statement | Expression;
};

export type Fn = NodeBase & {
	type: 'fn';
	typeParams: TypeParam[];
	params: {
		dest: Expression;
		optional: boolean;
		default?: Expression;
		argType?: TypeSource;
	}[];
	retType?: TypeSource;
	children: (Statement | Expression)[];
};

export type Match = NodeBase & {
	type: 'match';
	label?: string;
	about: Expression;
	qs: {
		q: Expression;
		guard?: Expression;
		a: Statement | Expression;
	}[];
	default?: Statement | Expression;
};

export type Block = NodeBase & {
	type: 'block';
	label?: string;
	statements: (Statement | Expression)[];
};

export type Exists = NodeBase & {
	type: 'exists';
	identifier: Identifier;
};

export type Tmpl = NodeBase & {
	type: 'tmpl';
	tmpl: Expression[];
};

export type Str = NodeBase & {
	type: 'str';
	value: string;
};

export type Num = NodeBase & {
	type: 'num';
	value: number;
};

export type Bool = NodeBase & {
	type: 'bool';
	value: boolean;
};

export type Null = NodeBase & {
	type: 'null';
};

export type Obj = NodeBase & {
	type: 'obj';
	value: Map<string, Expression>;
};

export type Arr = NodeBase & {
	type: 'arr';
	value: Expression[];
};

export type Identifier = NodeBase & {
	type: 'identifier';
	name: string;
};

export type Call = NodeBase & {
	type: 'call';
	target: Expression;
	args: Expression[];
};

export type Index = NodeBase & {
	type: 'index';
	target: Expression;
	index: Expression;
};

export type Prop = NodeBase & {
	type: 'prop';
	target: Expression;
	name: string;
};

export type TypeSource = NamedTypeSource | FnTypeSource | UnionTypeSource;

export type NamedTypeSource = NodeBase & {
	type: 'namedTypeSource';
	name: string;
	inner?: TypeSource;
};

export type FnTypeSource = NodeBase & {
	type: 'fnTypeSource';
	typeParams: TypeParam[];
	params: TypeSource[];
	result: TypeSource;
};

export type UnionTypeSource = NodeBase & {
	type: 'unionTypeSource';
	inners: TypeSource[];
};

export type TypeParam = {
	name: string;
}
