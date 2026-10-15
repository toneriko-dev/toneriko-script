import { describe, expect, test } from 'vitest';
import { Interpreter } from '../../src/v2/interpreter.js';
import { parse } from '../../src/v2/parser/index.js';
import { GraphemeCache } from '../../src/v2/runtime/strings.js';

async function execute(source: string) {
	const output: unknown[] = [];
	const vm = new Interpreter({ out: (value: unknown) => { output.push(value); } }, { maxSteps: 2_000_000, now: () => 0 });
	try { await vm.exec(parse(source).program); return { output, steps: vm.stepCount }; }
	finally { vm.abort(); }
}

const workloads = [
	{
		name: 'CRLF の indexOf を次の位置から繰り返す', size: 5000,
		source: (size: number) => `const s="a\\r\\n".repeat(${size}); let i=-1; let count=0; let sum=0; do {i=s.indexOf("a",i+1); if(i!==-1){count++;sum+=i;}} while(i!==-1); out([count,sum]);`,
		sum: (size: number) => size * (size - 1),
	},
	{
		name: 'CRLF の startsWith を全書記素位置で調べる', size: 2000,
		source: (size: number) => `const s="ab\\r\\n".repeat(${size}); let count=0; let sum=0; for(let i=0;i<s.length;i++){if(s.startsWith("ab",i)){count++;sum+=i;}} out([count,sum]);`,
		sum: (size: number) => 3 * size * (size - 1) / 2,
	},
	{
		name: '絵文字の startsWith を全書記素位置で調べる', size: 4000,
		source: (size: number) => `const s="😀,".repeat(${size}); let count=0; let sum=0; for(let i=0;i<s.length;i++){if(s.startsWith(",",i)){count++;sum+=i;}} out([count,sum]);`,
		sum: (size: number) => size * size,
	},
];

describe('書記素検索の境界キャッシュ', () => {
	for (const workload of workloads) test(`${workload.name}: 倍量でもステップ数は線形`, async () => {
		const base = await execute(workload.source(workload.size));
		const doubled = await execute(workload.source(workload.size * 2));
		expect(base.output).toEqual([[workload.size, workload.sum(workload.size)]]);
		expect(doubled.output).toEqual([[workload.size * 2, workload.sum(workload.size * 2)]]);
		expect(base.steps).toBeLessThan(workload.size * 100);
		expect(doubled.steps).toBeLessThan(base.steps * 2.05);
	});

	test('境界と UTF-16 開始位置を一度だけ準備して保持する', () => {
		for (const value of ['a\r\nb', '😀,é', 'abc']) {
			let steps = 0;
			const cache = new GraphemeCache(() => steps++);
			const prepare = () => {
				const frame = cache.prepareSearch(value);
				let result = frame.next(); while (!result.done) result = frame.next();
				return result.value;
			};
			const first = prepare(), initialSteps = steps;
			for (let i = 0; i < 100; i++) expect(prepare()).toBe(first);
			expect(steps).toBe(initialSteps);
			const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)];
			const offsets = [...segments.map(part => part.index), value.length];
			for (let i = 0; i < offsets.length; i++) {
				expect(first.offsets ? first.offsets[i] : i).toBe(offsets[i]);
				expect(first.boundaries ? first.boundaries.get(offsets[i]!) : offsets[i]).toBe(i);
			}
		}
	});
});


describe('空の検索文字列は書記素境界に一致する', () => {
	test('indexOf の位置を丸め、includes・startsWith・endsWith は true を返す', async () => {
		const result = await execute(`const s="é\\r\\n😀"; let outRows=[]; for(const p of [-9,0,1.8,2,999,0/0,1/0,-1/0]) { outRows.push([s.indexOf("",p),s.includes("",p),s.startsWith("",p),s.endsWith("",p)]); } out(outRows); out([s.indexOf(""),s.includes(""),s.startsWith(""),s.endsWith("")]);`);
		expect(result.output).toEqual([
			[0,0,1,2,3,0,3,0].map(index => [index,true,true,true]),
			[0,true,true,true],
		]);
	});

	test('split は書記素列を limit まで返し、replace は先頭だけを置換する', async () => {
		const result = await execute(`const s="é\\r\\n😀"; out([s.split(""),s.split("",0),s.split("",1),s.split("",2),s.split("",99),s.replace("","-"),s.replaceAll("","-")]);`);
		expect(result.output).toEqual([[['é','\r\n','😀'],[],['é'],['é','\r\n'],['é','\r\n','😀'],'-é\r\n😀','-é-\r\n-😀-']]);
	});

	test('空検索の置換コールバックに境界の書記素位置を渡す', async () => {
		const result = await execute(`const s="é\\r\\n😀"; let seen=[]; out(s.replaceAll("",(match,index,input)=>{seen.push([match,index,input===s]);return "-";})); out(seen); let first=[]; out(s.replace("",(match,index,input)=>{first.push([match,index,input===s]);return "-";})); out(first);`);
		expect(result.output).toEqual(['-é-\r\n-😀-', [0,1,2,3].map(index => ['',index,true]), '-é\r\n😀', [['',0,true]]]);
	});

	test('空の入力は一つの境界を持ち、split の結果は空配列になる', async () => {
		const result = await execute(`out(["".indexOf("",99),"".includes(""),"".startsWith(""),"".endsWith(""),"".split(""),"".split("",0),"".replace("","-"),"".replaceAll("","-")]);`);
		expect(result.output).toEqual([[0,true,true,true,[],[],'-','-']]);
	});
});
