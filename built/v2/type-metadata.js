//#region src/v2/type-metadata.ts
const annotations = /* @__PURE__ */ new WeakMap();
/** 解析後に変更しない構文木にだけ、パーサーが確かめた注釈の有無を保存します。 */
function recordTypeAnnotations(program, present) {
	annotations.set(program, present);
}
/** 外部で作った構文木は未確認なので、通常の線形走査を必要とします。 */
function parsedTypeAnnotations(program) {
	return annotations.get(program);
}

//#endregion
export { parsedTypeAnnotations, recordTypeAnnotations };
//# sourceMappingURL=type-metadata.js.map