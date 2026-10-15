// ホストが別名や入れ子の参照を保持できるため、失効は配列をたどらず世代で管理します。
let hostEpoch = 0;
let revision = 0;
type Checked = { host: number; revision: number; privateHost?: number };
const checked = new WeakMap<object, Checked>();
const privateObjects = new WeakMap<object, number>();
export function registerPrivateObject(value: object): void { privateObjects.set(value, hostEpoch); }
export function privateObject(value: object): boolean { return privateObjects.get(value) === hostEpoch; }
export function invalidateHostArrays(): void { hostEpoch++; revision++; }
export function invalidateYieldArrays(): void { revision++; }
export function arrayRevision(): number { return revision; }
export function registerScriptArray(array: object): void {
	checked.set(array, { host: hostEpoch, revision, privateHost: hostEpoch });
}
export function trustedArray(array: object): boolean {
	const state = checked.get(array);
	// 作成後にホスト呼び出しがなければ、標準の譲渡だけでは配列はホストへ公開されません。
	return !!state && state.host === hostEpoch && (state.privateHost === hostEpoch || state.revision === revision);
}
export function trustArray(array: object): void {
	checked.set(array, { host: hostEpoch, revision, privateHost: checked.get(array)?.privateHost });
}
let prototypeRevision = -1;
let safePrototype = false;
export function safeArrayPrototype(): boolean {
	if (prototypeRevision === revision) return safePrototype;
	prototypeRevision = revision;
	safePrototype = Object.getPrototypeOf(Array.prototype) === Object.prototype && Object.getPrototypeOf(Object.prototype) === null;
	if (!safePrototype) return false;
	for (const object of [Array.prototype, Object.prototype]) for (const key of Object.getOwnPropertyNames(object)) {
		const index = Number(key);
		if (!Number.isInteger(index) || index < 0 || index >= 0xffffffff || String(index) !== key) continue;
		const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
		if (!('value' in descriptor) || !descriptor.writable) safePrototype = false;
	}
	return safePrototype;
}
