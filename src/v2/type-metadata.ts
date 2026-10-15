import type { Program } from './ast.js';

const annotations = new WeakMap<Program, boolean>();

/** 解析後に変更しない構文木にだけ、パーサーが確かめた注釈の有無を保存します。 */
export function recordTypeAnnotations(program: Program, present: boolean): void {
	annotations.set(program, present);
}

/** 外部で作った構文木は未確認なので、通常の線形走査を必要とします。 */
export function parsedTypeAnnotations(program: Program): boolean | undefined {
	return annotations.get(program);
}
