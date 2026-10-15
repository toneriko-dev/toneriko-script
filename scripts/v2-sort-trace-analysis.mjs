import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';

const summaryPath = resolve(process.argv[2] ?? '.git/v2-sort-trace/summary.json');
const outputPath = resolve(process.argv[3] ?? `${dirname(summaryPath)}/attribution.json`);
function union(intervals, start, end) {
	const parts = intervals.map(x=>[Math.max(start,x.start),Math.min(end,x.end)]).filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0]);
	let total=0, until=start;
	for (const [left,right] of parts) { total+=Math.max(0,right-Math.max(left,until)); until=Math.max(until,right); }
	return total;
}
function completeEvents(events) {
	const complete=[], stacks=new Map();
	for (const event of events.sort((a,b)=>a.ts-b.ts)) {
		if (event.ph==='X') complete.push({...event,start:event.ts/1000,end:(event.ts+event.dur)/1000,cpuStart:event.tts/1000,cpuEnd:(event.tts+event.tdur)/1000});
		if (event.ph==='B') { const key=`${event.pid}/${event.tid}`; if(!stacks.has(key))stacks.set(key,[]);stacks.get(key).push(event); }
		if (event.ph==='E') { const begin=stacks.get(`${event.pid}/${event.tid}`)?.pop();if(begin)complete.push({...begin,start:begin.ts/1000,end:event.ts/1000,cpuStart:begin.tts/1000,cpuEnd:event.tts/1000}); }
	}
	return complete;
}
const report={source:summaryPath,limitations:['CPU buckets and non-running time are disjoint and sum to synchronous wall duration. GC wall time additionally includes waiting within GC and must not be added to non-running time.', 'Non-running time includes scheduler delay and waits for parallel GC workers. This trace cannot separate those two.', 'Other CPU includes interpreter, runtime, and trace instrumentation; CPU profiles are needed for finer attribution.', 'JIT CPU is limited to explicitly named Compile/Optimize/Deopt events; untraced compiler work remains in other CPU.'],trials:[]};
const summary=JSON.parse(await readFile(summaryPath,'utf8'));
for(const trial of summary.trials.filter(x=>x.phase==='measure'&&x.tracePath)) {
	let tracePath=trial.tracePath;
	let raw;
	try { raw=JSON.parse(await readFile(tracePath,'utf8')); }
	catch { tracePath=resolve(dirname(summaryPath),basename(tracePath));raw=JSON.parse(await readFile(tracePath,'utf8')); }
	const events=raw.traceEvents??raw,prefix=`sort-${trial.size}-${trial.run}`;
	const marks=new Map(events.filter(e=>e.name?.startsWith(`${prefix}:`)&&e.cat?.includes('user_timing')).map(e=>[e.name,e]));
	const boundary=marks.get(`${prefix}:start`);
	const complete=completeEvents(events.filter(e=>e.pid===boundary.pid&&e.tid===boundary.tid));
	const gc=complete.filter(e=>/(^|[.:_])(GC|GCScavenger|GCCompactor)|MinorGC|MajorGC|Scavenge|MarkCompact/i.test(e.name)&&!/Concurrent|Background/i.test(e.name));
	const jit=complete.filter(e=>/Compile|Optimize|Deopt/i.test(e.name)&&!/Concurrent|Background/i.test(e.name));
	const intervals=[];
	for(const [name,left] of marks) {
		const match=name.match(/:sync:(\d+):start$/);if(!match)continue;
		const right=marks.get(`${prefix}:sync:${match[1]}:end`);if(!right)throw new Error('Missing end marker');
		const start=left.ts/1000,end=right.ts/1000,durationMs=end-start;
		const cpuStart=left.tts/1000,cpuEnd=right.tts/1000,hasClock=Number.isFinite(cpuStart)&&Number.isFinite(cpuEnd);
		const overlappingGc=gc.filter(e=>e.end>start&&e.start<end),overlappingJit=jit.filter(e=>e.end>start&&e.start<end);
		const clocks=items=>items.filter(e=>Number.isFinite(e.cpuStart)&&Number.isFinite(e.cpuEnd)).map(e=>({start:e.cpuStart,end:e.cpuEnd}));
		const gcWallMs=union(overlappingGc,start,end),jitWallMs=union(overlappingJit,start,end);
		const gcCpuMs=hasClock?union(clocks(overlappingGc),cpuStart,cpuEnd):null;
		const gcAndJitCpuMs=hasClock?union(clocks([...overlappingGc,...overlappingJit]),cpuStart,cpuEnd):null;
		const jitCpuExcludingGcMs=hasClock?gcAndJitCpuMs-gcCpuMs:null;
		const threadCpuMs=hasClock?cpuEnd-cpuStart:null;
		const otherCpuMs=hasClock?threadCpuMs-gcAndJitCpuMs:null;
		const nonRunningMs=hasClock?durationMs-threadCpuMs:null;
		const missingClockGcWallMs=gcWallMs-union(overlappingGc.filter(e=>Number.isFinite(e.cpuStart)&&Number.isFinite(e.cpuEnd)),start,end);
		const missingClockJitWallMs=jitWallMs-union(overlappingJit.filter(e=>Number.isFinite(e.cpuStart)&&Number.isFinite(e.cpuEnd)),start,end);
		intervals.push({index:Number(match[1]),durationMs,gcWallMs,jitWallMs,threadCpuMs,gcCpuMs,jitCpuExcludingGcMs,otherCpuMs,nonRunningMs,missingClockGcWallMs,missingClockJitWallMs,otherCpuExceeds16ms:hasClock?otherCpuMs>16:null,gcEvents:[...new Set(overlappingGc.map(e=>e.name))],jitEvents:[...new Set(overlappingJit.map(e=>e.name))]});
	}
	const over16=intervals.filter(x=>x.durationMs>16);
	report.trials.push({size:trial.size,run:trial.run,tracePath,intervalCount:intervals.length,maxSynchronousMs:Math.max(0,...intervals.map(x=>x.durationMs)),maxOtherCpuMs:Math.max(0,...intervals.map(x=>x.otherCpuMs??0)),over16,otherCpuExceeds16ms:over16.filter(x=>x.otherCpuExceeds16ms).length});
}
await writeFile(outputPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({outputPath,trials:report.trials.map(x=>({size:x.size,run:x.run,over16:x.over16.length,maxOtherCpuMs:x.maxOtherCpuMs,otherCpuExceeds16ms:x.otherCpuExceeds16ms}))}));
