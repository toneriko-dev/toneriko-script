import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { nodeExecutable } from '../../scripts/v2-node.mjs';
import { numberDefinitions, seededRandom } from '../../src/v2/stdlib/numbers.js';
import { PropertyAccess, type Value } from '../../src/v2/runtime/values.js';
import { validateArguments, type StdContext } from '../../src/v2/stdlib/core.js';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';

const context: StdContext = { pos: { line: 3, column: 2 }, properties: new PropertyAccess(), tick() {}, *checkpoint() { return null; }, *call() { throw new Error('unexpected callback'); } };
function invoke(name: string, args: Value[], receiver: Value = null): Value {
	const definition = numberDefinitions.find(item => item.name === name)!;
	validateArguments(context, definition, args);
	const result = definition.implementation(context, receiver, args).next();
	expect(result.done).toBe(true);
	return result.value;
}
const pack = (value: unknown): unknown => typeof value === 'number' ? Number.isNaN(value) ? 'NaN' : value === Infinity ? '+Infinity' : value === -Infinity ? '-Infinity' : Object.is(value, -0) ? '-0' : value : value;

// BigInt の符号なし演算で、製品の int32 演算と独立に仕様を表します。
function reference(seed: number | string): () => number {
	const data = typeof seed === 'number' ? Buffer.alloc(9) : Buffer.from('\x01' + seed, 'utf16le').subarray(1);
	if (typeof seed === 'number') data.writeDoubleLE(seed, 1);
	else data[0] = 1;
	const mask = 0xffffffffn;
	let state = [0, 1, 2, 3].map(prefix => {
		let hash = 2166136261n;
		for (const byte of [prefix, ...data]) hash = ((hash ^ BigInt(byte)) * 16777619n) & mask;
		return hash;
	});
	if (state.every(x => x === 0n)) state[0] = 1n;
	const rotate = (x: bigint, bits: bigint) => ((x << bits) | (x >> (32n - bits))) & mask;
	const next = () => {
		const [a, b, c, d] = state as [bigint, bigint, bigint, bigint];
		const result = rotate((b * 5n) & mask, 7n) * 9n & mask;
		state = [a ^ d ^ b, b ^ c ^ a, (c ^ a ^ b << 9n) & mask, rotate(d ^ b, 11n)];
		return result;
	};
	return () => Number((next() >> 5n) * 67108864n + (next() >> 6n)) / 9007199254740992;
}

const seeds = ['', 0, -0, 1, -42, 1.5, '日本語', '👩‍💻', '2026-10-15:user-id'];
const golden = [
	{
		"first": [
			0.20594360408227486,
			0.43159288114292493,
			0.5675394205362718,
			0.3991137695003535,
			0.1420872139545366,
			0.448480799546489,
			0.4741116087621119,
			0.33017676639780325,
			0.582393058273272,
			0.27807366111707377,
			0.3866107695468113,
			0.19106713879139492,
			0.34952538095939534,
			0.8558968361974568,
			0.9266297740949915,
			0.24132038852507431,
			0.23539141384618867,
			0.18675604445977068,
			0.6106060462120839,
			0.5651523303178294,
			0.14531033427722162,
			0.03932642729052804,
			0.6841095588409001,
			0.8078304920842392,
			0.8977885678196557,
			0.880515640438544,
			0.2632614717880045,
			0.5221189022926433,
			0.5617566721463015,
			0.42940783520069026,
			0.03577293810384674,
			0.64772010987279
		],
		"digest": "a1c9c49a4ca17d30752a4c2b9c76b52d9d1f499cda39c541679c330a9b36f15c"
	},
	{
		"first": [
			0.717598695890687,
			0.7999364940080653,
			0.7079501617247187,
			0.864367599483629,
			0.3711646480851747,
			0.9321515088897244,
			0.13818499757779767,
			0.18233441121379645,
			0.590699083111934,
			0.4551787535707573,
			0.636726958632747,
			0.862042090259504,
			0.8464860846656539,
			0.5333201186507602,
			0.19562183394325394,
			0.6302213596275503,
			0.23017565349173974,
			0.688498192011715,
			0.6297895465518379,
			0.8909012690197541,
			0.2823858053441045,
			0.9750882239481874,
			0.1494267356986212,
			0.9027400575824444,
			0.42438997915819177,
			0.7077014972878032,
			0.5122046097421076,
			0.43611040929652667,
			0.8419598100861233,
			0.38057314862889313,
			0.38590756292772554,
			0.5898249364700269
		],
		"digest": "4961ca614966d8571e443b3a239d2433120d8f01830bfdc27b160527379fea2c"
	},
	{
		"first": [
			0.7867780971873087,
			0.9502736465342558,
			0.3345109209565308,
			0.4905001556696099,
			0.3873647605459368,
			0.2431734290512938,
			0.5824908950849366,
			0.5350049315581542,
			0.8313294324516192,
			0.6345691253962875,
			0.7462930629821697,
			0.8109283925295209,
			0.2889685092381036,
			0.6063005467134496,
			0.3226118852475498,
			0.7803062113112663,
			0.46751470936001294,
			0.21339744632830393,
			0.5979440069603769,
			0.11724070466371272,
			0.5881143940702221,
			0.0994593555199963,
			0.5083076858858487,
			0.9742309578585095,
			0.007437529661746156,
			0.35307923041439504,
			0.9649073835211082,
			0.3356794556582876,
			0.920241014346173,
			0.1844215405117111,
			0.35187449702352036,
			0.36746899950561174
		],
		"digest": "67c9f50eba06d7b98b69ac945641d434189510f958ac87f841a7e005706fcacc"
	},
	{
		"first": [
			0.6158155209140936,
			0.9554008686080346,
			0.8949487329124935,
			0.9274913544982394,
			0.7874985247254471,
			0.7006933989511385,
			0.3297302507208486,
			0.5438006929803886,
			0.5743820066291154,
			0.5354702297865216,
			0.22856013942148323,
			0.6852425610633289,
			0.37312872955904564,
			0.7883944892870645,
			0.09948544318708008,
			0.21389131042502507,
			0.1720873525997758,
			0.12665870220669984,
			0.7533103281150466,
			0.44790451668928044,
			0.41874596875934766,
			0.6467580868056267,
			0.14722069758569434,
			0.09701827246827188,
			0.8083300750557573,
			0.9173468926979353,
			0.41980862163569377,
			0.05961903328812035,
			0.9366237377576828,
			0.9054303412172043,
			0.2740403600983239,
			0.18329008377221512
		],
		"digest": "804f4032346e6cf669233dfbbaa9b565c2db5a9c3efb7fbcffdfeeb6ac08eb71"
	},
	{
		"first": [
			0.08991032511121233,
			0.43025968543765103,
			0.8322574522273705,
			0.5214133042919498,
			0.2380629118294707,
			0.8567877009921135,
			0.6532926628205693,
			0.07170449889568242,
			0.8303099802450472,
			0.927093639542632,
			0.8095637551630609,
			0.8708528023365363,
			0.023166375601191835,
			0.029112186745842705,
			0.16339077952152892,
			0.38306487938230915,
			0.038622301164017436,
			0.7335975297397905,
			0.27961017302241864,
			0.15013858665510993,
			0.38130557815169774,
			0.5738669067633715,
			0.33300065701994597,
			0.3435589650689942,
			0.5260901969647274,
			0.026816914716116802,
			0.27779990565050794,
			0.055937754685635,
			0.6190182661349405,
			0.6896898133330918,
			0.46727463704720806,
			0.051555038032619294
		],
		"digest": "845bc7e8ed38c1c4849cb9c10abcc5f9824c7af06182fb16e06215dcd0c28fe4"
	},
	{
		"first": [
			0.3323327339013823,
			0.8608909286153876,
			0.882805185965533,
			0.5383958937826177,
			0.8172736090694493,
			0.9860245527615008,
			0.4116580711719463,
			0.645062852628215,
			0.7602178263706875,
			0.7289408366255617,
			0.4675686318079181,
			0.09713539844483376,
			0.44831564351482867,
			0.38807810408014753,
			0.1637048926683261,
			0.035983924520584964,
			0.783751684928502,
			0.8665938963951848,
			0.5950444722710491,
			0.6432492643426317,
			0.8638225278929531,
			0.632101307593277,
			0.02974401636789592,
			0.29916511696853176,
			0.25966980487739943,
			0.31026351976355315,
			0.9071625481440553,
			0.20833683046443252,
			0.7573140139226839,
			0.9640465026516408,
			0.37597269132203004,
			0.9924623967839408
		],
		"digest": "c441831452d8d88e9e420f97c8f87b89acb78ddcb7469ef4d639667437b01f09"
	},
	{
		"first": [
			0.17015356102536672,
			0.5612135400432093,
			0.4994132250424539,
			0.7718731423690565,
			0.4446359577536616,
			0.2554920472847184,
			0.2693162575192243,
			0.10934117843847191,
			0.8404515042936629,
			0.7150213184004311,
			0.8746256609531435,
			0.0957291317682929,
			0.08181306363358654,
			0.5407672827101091,
			0.9015701217664254,
			0.17134438455606782,
			0.10666277836713955,
			0.712742826676452,
			0.9563836731892612,
			0.8707608249512443,
			0.02275054678538002,
			0.1476506828441202,
			0.6873554693306883,
			0.22457581404230065,
			0.35909785863473276,
			0.23406702267742507,
			0.5175723375571877,
			0.8511406287018928,
			0.6613128539711346,
			0.39228328395396483,
			0.38873805663062233,
			0.5246121988869509
		],
		"digest": "6f2eaab38856a302bfce5f6f42b88e37c8eace559eb90fdd26dbdd895eee6df6"
	},
	{
		"first": [
			0.03683273221926131,
			0.5183374183531342,
			0.9180597680641297,
			0.8780764128224414,
			0.8157788186892391,
			0.31858788352532963,
			0.8452613142183559,
			0.4271428585780477,
			0.8351462082521243,
			0.48901525792848755,
			0.03286101867347491,
			0.7157840462112014,
			0.03631942418565848,
			0.9122172896254872,
			0.21228916545766996,
			0.7368948560956605,
			0.8960343700225523,
			0.32205687662162663,
			0.9242555657222687,
			0.8631458533080835,
			0.23178093925382626,
			0.127859572249575,
			0.8175892659055678,
			0.5339453651928184,
			0.024156337054947352,
			0.834447957081803,
			0.8277843263994759,
			0.836291570574053,
			0.8213596878398332,
			0.48902556582772916,
			0.2726445702880914,
			0.05928265791452281
		],
		"digest": "7dd08b90538e247c6391355e1019e3ef9e7adbbe3747a0a7a7cbdee6414d8a95"
	},
	{
		"first": [
			0.048223321746218906,
			0.6049616164737163,
			0.7059954881981615,
			0.7885343707909408,
			0.2059205139566589,
			0.9100389640753188,
			0.4261790167439401,
			0.9789278791542878,
			0.12165196170719883,
			0.5996288135569545,
			0.2676414193367289,
			0.9974777339297473,
			0.216135656490283,
			0.37145910861771114,
			0.9475953066520029,
			0.22643082977916795,
			0.6296597686392499,
			0.8226162047690562,
			0.2670871705257265,
			0.6227659684768997,
			0.33497470544070174,
			0.5185395304062257,
			0.6390909504900915,
			0.15008450835442955,
			0.8868830906719181,
			0.7164968420576031,
			0.9535720326618454,
			0.565544645839827,
			0.592803784751101,
			0.9874869672807361,
			0.05814269640344083,
			0.6115612366695933
		],
		"digest": "2775d974357ccbce06d689dfce477b733026c9f2aa906889c2a569737b548ee2"
	}
];
// 近似計算と非十進の文字列化は実行環境に従うため、別エンジンとの完全一致を要求しない。
const nativeMath = new Set(['acos', 'acosh', 'asin', 'asinh', 'atan', 'atanh', 'cbrt', 'cos', 'cosh', 'exp', 'expm1', 'log', 'log1p', 'log2', 'log10', 'sin', 'sinh', 'tan', 'tanh', 'atan2', 'pow', 'hypot'].map(name => `Math.${name}`));
describe('標準の数と変換', () => {
	for (const definition of numberDefinitions.filter(item => !['Math.random', 'Math.randomInt', 'Math.seededRandom', 'Math.clamp'].includes(item.name))) {
		const sameRuntime = nativeMath.has(definition.name) || definition.name === 'toString';
		test(`${definition.name}: ${sameRuntime ? '同じ実行環境のネイティブ' : 'Node'} と 500 件比較し全件の到達を検査`, async () => {
			const cases: { args: Value[]; receiver: Value }[] = [];
			for (const seed of [11, 29, 73, 151, 257]) {
				const generated = fc.sample(fc.tuple(fc.integer({ min: -10000, max: 10000 }), fc.integer({ min: 2, max: 36 })), { seed, numRuns: 100 });
				for (const [x, radix] of generated) {
					let args: Value[] = [x / 100]; let receiver: Value = null;
					if (definition.name === 'toFixed' || definition.name === 'toString') { receiver = x / 100; args = [definition.name === 'toFixed' ? radix % 20 : radix]; }
					else if (definition.name === 'Array.isArray') args = [x % 2 ? [x] : x];
					else if (definition.name === 'Number' || definition.name === 'parseFloat' || definition.name === 'parseInt') args = [String(x / 100)];
					else if (definition.name.includes('URIComponent')) args = [`a${Math.abs(x)}_ !`];
					else if (definition.args.length === 2) args = [x / 100, radix];
					else if (definition.args[0]?.rest) args = [x / 100, radix, -radix];
					cases.push({ args, receiver });
				}
			}
			const expression = definition.receiver === 'number' ? `row.receiver.${definition.name}(...row.args)` : `${definition.name}(...row.args)`;
			let expected: unknown[];
			if (sameRuntime) {
				const native = new Function('row', `return ${expression};`);
				expected = cases.map(row => pack(native(row)));
			} else {
				const node = spawnSync(nodeExecutable, ['--input-type=module', '--eval', `const rows=JSON.parse(process.argv[1]);const pack=${pack.toString()};process.stdout.write(JSON.stringify(rows.map(row=>pack(${expression}))));`, JSON.stringify(cases)], { encoding: 'utf8' });
				expect(node.status, node.stderr).toBe(0);
				expected = JSON.parse(node.stdout);
			}
			let reached = 0; let completed = 0; let compared = 0;
			const actual: unknown[] = [];
			const source = `for (const row of inputs) { reached(); out(${expression}); }`;
			const parsed = parse(source);
			expect(parsed.warnings).toEqual([]);
			const vm = new Interpreter({ inputs: cases, reached: () => { reached++; }, out: (value: unknown) => { completed++; actual.push(pack(value)); } });
			await vm.exec(parsed.program);
			for (let i = 0; i < cases.length; i++) { expect(actual[i]).toEqual(expected[i]); compared++; }
			expect([cases.length, reached, completed, compared]).toEqual([500, 500, 500, 500]);
		});
	}
	test('省略、特殊数、URI 例外と値域', () => {
		expect(invoke('Number', [])).toBe(0); expect(invoke('String', [])).toBe('');
		expect(invoke('Math.min', [])).toBe(Infinity); expect(invoke('Math.max', [])).toBe(-Infinity);
		expect(invoke('Math.hypot', [])).toBe(0); expect(invoke('Math.sin', [])).toBeNaN();
		expect(invoke('Number', [null])).toBe(0); expect(invoke('String', [null])).toBe('null');
		expect(invoke('parseInt', ['ff', 16])).toBe(255); expect(invoke('parseFloat', ['3.14tail'])).toBe(3.14);
		expect(() => invoke('decodeURIComponent', ['%'])).toThrow(expect.objectContaining({ name: 'URIError', code: 'STDLIB_URI_ERROR', pos: context.pos }));
		expect(() => invoke('toFixed', [101], 1)).toThrow(expect.objectContaining({ name: 'RangeError', code: 'STDLIB_ARGUMENT_RANGE', pos: context.pos }));
		expect(() => invoke('Math.clamp', [2, 3, 1])).toThrow();
		expect(() => invoke('Math.randomInt', [1])).toThrow();
		for (const value of [Infinity, NaN, null, {}]) expect(() => invoke('Math.seededRandom', [value])).toThrow();
		for (let i = 0; i < 500; i++) { const value = invoke('Math.randomInt', [-3, 3]) as number; expect(Number.isInteger(value) && value >= -3 && value <= 3).toBe(true); }
		expect(invoke('Math.randomInt', [7, 7])).toBe(7);
		expect(invoke('Math.clamp', [-10, 0, 2])).toBe(0); expect(invoke('Math.clamp', [10, 0, 2])).toBe(2);
	});
	test('Number.isNaN と Number.isFinite は数以外を変換せず false を返す', () => {
		expect([NaN, 1, 'NaN', null, {}].map(value => invoke('Number.isNaN', [value]))).toEqual([true, false, false, false, false]);
		expect([1, -0, Infinity, -Infinity, NaN, '1', null].map(value => invoke('Number.isFinite', [value]))).toEqual([true, true, false, false, false, false, false]);
		expect(invoke('Number.isNaN', [])).toBe(false);
	});
	test('Number の安全な整数の範囲を定数で読め、書き換えられない', async () => {
		const result: unknown[] = [];
		const vm = new Interpreter({ out: (value: unknown) => { result.push(value); } });
		await vm.exec(parse('out(Number.MAX_SAFE_INTEGER); out(Number.MIN_SAFE_INTEGER); out(Number.isSafeInteger);').program).catch(error => result.push(error.code));
		expect(result).toEqual([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 'METHOD_NOT_AVAILABLE']);
		await expect(new Interpreter({}).exec(parse('Number.MAX_SAFE_INTEGER = 1;').program)).rejects.toBeTruthy();
	});
	test('名前空間に無く JavaScript の標準にある名前は、名前空間付きの名前でまだ使えないと案内する', async () => {
		for (const [source, key] of [['Number.EPSILON', 'Number.EPSILON'], ['Number.parseInt("1")', 'Number.parseInt'], ['Object.assign({}, {})', 'Object.assign'], ['Array.of(1)', 'Array.of'], ['String.raw', 'String.raw'], ['Date.UTC(2020)', 'Date.UTC'], ['console.warn("x")', 'console.warn']] as const) {
			await expect(new Interpreter({}).exec(parse(`${source};`).program)).rejects.toMatchObject({ code: 'METHOD_NOT_AVAILABLE', params: { key } });
		}
	});
	test('名前空間にも ECMAScript 2025 にも無い名前は、実行環境の組み込みにあっても null を返す', async () => {
		const result: unknown[] = [];
		const vm = new Interpreter({ out: (value: unknown) => { result.push(value); } });
		await vm.exec(parse('out(Number.missing); out(Math.missing); out(Object.missing); out(Number.isNaN?.(1)); const M = Math; out(M.floor(1.5)); out(Math.sumPrecise ?? "fallback"); out(JSON.rawJSON); out(Array.fromAsync); out(Number.name);').program);
		expect(result).toEqual([null, null, null, false, 1, 'fallback', null, null, null]);
	});
	test('登録した数の API を評価器から呼べる', async () => {
		const result: unknown[] = [];
		const vm = new Interpreter({ out: (value: unknown) => { result.push(value); } });
		await vm.exec(parse('out(Math.sqrt(9)); out(Number.isInteger(Number("3"))); out((15).toString(16)); const rng = Math.seededRandom("x"); out(rng());').program);
		expect(result).toEqual([3, true, 'f', seededRandom('x')()]);
	});
	for (const [seedIndex, seed] of seeds.entries()) test(`乱数の独立参照と 4096 個の固定列: ${String(seed)} ${Object.is(seed, -0)}`, () => {
		const actual = seededRandom(seed); const expected = reference(seed);
		const values = Array.from({ length: 4096 }, () => actual());
		expect(values).toEqual(Array.from({ length: 4096 }, () => expected()));
		const digest = createHash('sha256').update(JSON.stringify(values)).digest('hex');
		expect(values.slice(0, 32)).toEqual(golden[seedIndex]!.first);
		expect(digest).toBe(golden[seedIndex]!.digest);
	});
});

test('長い乱数の種は符号単位数のステップを計上し、ハッシュ中にホストへ譲る', async () => {
	const seed = 'a👩\ud800'.repeat(250000);
	let clock = 0, yields = 0;
	const vm = new Interpreter({ seed }, { maxSteps: seed.length + 100, now: () => ++clock, yieldInterval: 1, maxBusyTime: Infinity, yieldToHost: async () => { yields++; } });
	await vm.exec(parse('const rng = Math.seededRandom(seed); const result = rng();').program);
	expect(vm.getGlobal('result')).toBe(reference(seed)());
	expect(vm.stepCount).toBeGreaterThanOrEqual(seed.length);
	expect(vm.stepCount).toBeLessThan(seed.length + 100);
	expect(yields).toBeGreaterThan(100);
	await expect(new Interpreter({ seed }, { maxSteps: 1000 }).exec(parse('Math.seededRandom(seed);').program)).rejects.toMatchObject({ code: 'STEP_LIMIT_EXCEEDED' });
});
