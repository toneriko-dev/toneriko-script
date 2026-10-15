import { Program } from "./ast.js";
//#region src/v2/type-metadata.d.ts
/** 解析後に変更しない構文木にだけ、パーサーが確かめた注釈の有無を保存します。 */
export declare function recordTypeAnnotations(program: Program, present: boolean): void;
/** 外部で作った構文木は未確認なので、通常の線形走査を必要とします。 */
export declare function parsedTypeAnnotations(program: Program): boolean | undefined;
//#endregion
//# sourceMappingURL=type-metadata.d.ts.map