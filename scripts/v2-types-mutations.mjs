import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const runtime='src/v2/interpreter.ts', types='src/v2/runtime/type-checks.ts', plan='src/v2/runtime/type-plan.ts', checker='src/v2/checker/index.ts', parser='src/v2/parser/index.ts';
const runtimeTest='test/v2/runtime-types.ts', checkerTest='test/v2/checker.ts', parserTest='test/v2/parser.ts';
const mutations=[
	['initial',runtime,'if (declaration.init) this.checkBindingScalar(env, declaration.id.name, value, execution, declaration.id.loc.start);','void declaration.init;',runtimeTest,'初期値'],
	['assignment',runtime,'this.writeScalar(env, target.name, assigned, execution, pos);','this.writeChecked(env, target.name, assigned, pos);',runtimeTest,'単純代入'],
	['argument',runtime,'checkScalar(check, value, pattern.name, pattern.loc.start);','void check;',runtimeTest,'引数'],
	['return',runtime,'checkScalar(check, value, `${target.name ?? \'<anonymous>\'}()`, returnedAt);','void check;',runtimeTest,'戻り値'],
	["default-before-value", "src/v2/interpreter.ts", "yield this.checkType(projected.check, assigned, label, execution, pos, name => patternDiagnosticName(pattern.left, label, name));", "yield this.checkType(projected.check, value, label, execution, pos, name => patternDiagnosticName(pattern.left, label, name));", "test/v2/runtime-types.ts", "入れ子分割の既定値を適用して構造を検査"],
	['callback-argument',runtime,'if (checks[i]) { this.tick(current, param.loc.start); checkScalar(checks[i]!, value, param.name, param.loc.start); }','if (checks[i]) { this.tick(current, param.loc.start); }',runtimeTest,'callbackの引数'],
	['callback-return',runtime,'if (returned) { this.tick(current, returnedAt); checkScalar(returned, value, `${fn.name ?? \'<anonymous>\'}()`, returnedAt); }','if (returned) { this.tick(current, returnedAt); }',runtimeTest,'callbackの戻り値'],
	['union-and',types,'if (failure === null) return null;\n\t\t}\n\t\treturn { name, check, value };','if (failure !== null) return failure;\n\t\t}\n\t\treturn null;',runtimeTest,'原始型と合併型'],
	['array-depth-zero',types,'if (!matched) return { name: `${name}[${i}]`','if (Boolean(0) && !matched) return { name: `${name}[${i}]`',runtimeTest,'配列要素'],
	['array-depth-recursive',types,"const matched = check.element.kind === 'union' || check.element.kind === 'projection' ? yield* matchesShallow(check.element, item, tick) : matchesOuter(check.element, item);",'const matched = (yield* mismatch(check.element, item, name, properties, pos, tick)) === null;',runtimeTest,'配列は直下まで'],
	['required-property',types,'if (!property.optional) return','if (property.optional) return',runtimeTest,'必須プロパティ欠如'],
	['optional-null',types,'if (!matched) return { name: `${name}.${property.key}`','if (item !== null && !matched) return { name: `${name}.${property.key}`',runtimeTest,'optionalの明示null'],
	["projection", "src/v2/runtime/type-checks.ts", "const property = type.byKey.get(key);", "const property = type.byKey.get(key + \"__missing\");", "test/v2/runtime-types.ts", "分割後の再代入"],
	['optional-argument',plan,"const nullable = (check: TypeCheck): TypeCheck => ({ kind: 'union', types: [check, { kind: 'null' }] });","const nullable = (check: TypeCheck): TypeCheck => ({ kind: 'union', types: [check, { kind: 'number' }] });",runtimeTest,'optional引数はnullも受け入れる'],
	["literal-check", "src/v2/checker/index.ts", "emit('TYPE_ANNOTATION_MISMATCH', result.at,", "if (Boolean(0)) emit('TYPE_ANNOTATION_MISMATCH', result.at,", "test/v2/checker.ts", "不一致: let x: number = \"bad\";"],
	['const-write',checker,"if (binding && !binding.mutable) emit('CONST_ASSIGNMENT'","if (binding && binding.mutable) emit('CONST_ASSIGNMENT'",checkerTest,'再代入: const x = 1; x = 2;'],
	['undeclared-suggestion',checker,'if (candidates[0]) emit(','if (candidates[0] && Boolean(0)) emit(',checkerTest,'未宣言と近い名前'],
	['arity-maximum',checker,"if (count < minimum || count > maximum) emit('ARGUMENT_COUNT'","if (count < minimum || count > maximum + 1) emit('ARGUMENT_COUNT'",checkerTest,'引数不足・過剰: range(1, 2, 3, 4);'],
	['arity-optional',checker,'definition.args.filter(arg => !arg.optional && !arg.rest).length','definition.args.filter(arg => !arg.rest).length',checkerTest,'確定できない呼出しは断定しない: range(1, 2);'],
	['unknown-spread',checker,'count += arg.argument.elements.length;\n\t\t\telse return;','count += arg.argument.elements.length;\n\t\t\telse count += 0;',checkerTest,'確定できない呼出しは断定しない: range(...unknown);'],
	['fallthrough-warning',checker,"emit('CASE_FALLTHROUGH', item, {}, 'warning')","emit('CASE_FALLTHROUGH', item, {}, 'error')",checkerTest,'複数診断の位置・順序・日英・警告'],
	['fallthrough-break', 'src/v2/checker/control-flow.ts',"case 'BreakStatement': return new Set([`break:${node.label?.name ?? ''}`]);","case 'BreakStatement': return new Set(['normal']);",checkerTest,'次へ進まない: break;'],
	['void-position',parser,"if (node.name === 'void' && !returns) this.fail('VOID_TYPE_POSITION', node)","if (node.name === 'void' && returns) this.fail('VOID_TYPE_POSITION', node)",parserTest,'void の値位置を拒否: let x: void;'],
	['arrow-return-parentheses',parser,"if (this.at('=>') && typeAnnotation.type === 'ObjectTypeAnnotation') this.fail('PARENTHESIZED_ARROW_RETURN_TYPE', start);","if (this.at('=>') && typeAnnotation.type === 'ObjectTypeAnnotation') void start;",parserTest,'括弧ひとつのオブジェクト戻り値型を拒否'],
	['metadata-skip-typed',plan,'if (parsedTypeAnnotations(program) === false) return true;','if (parsedTypeAnnotations(program) === true) return true;',runtimeTest,'初期値'],
	['foreign-shared-ast',runtime,'const target = simple === undefined ? this.detachedFunction(fn) : fn;','const target = fn;',runtimeTest,'同じASTでも別Interpreterの注釈を取り込まない: 引数と戻り値'],
	['foreign-callback',runtime,'if (!returned && !this.simpleParameters.has(fn)) return Interpreter.prototype.callback.call(this, this.detachedFunction(fn), args, receiver, execution, pos);','if (Boolean(0) && !returned && !this.simpleParameters.has(fn)) return Interpreter.prototype.callback.call(this, this.detachedFunction(fn), args, receiver, execution, pos);',runtimeTest,'同じASTでも別Interpreterの注釈を取り込まない: 戻り注釈のないmap'],
	["array-length-projection", "src/v2/type-projection.ts", "return adapter.keyword(operation.key === 'length' ? 'number' : 'any', type);", "return adapter.keyword(operation.key === 'length' ? 'any' : 'number', type);", "test/v2/runtime-types.ts", "配列object分割lengthの文字列を拒否"],
	["missing-binding-initializer", "src/v2/interpreter.ts", "if (check && (!initialize || !checkedValue || plan?.explicit)) {\n\t\t\t\tif (isComposite(check)) yield this.checkType(check, value, pattern.name, execution, pos);", "if (check && !initialize) {\n\t\t\t\tif (isComposite(check)) yield this.checkType(check, value, pattern.name, execution, pos);", "test/v2/runtime-types.ts", "不足配列要素の束縛を検査"],
	["static-computed-rest", "src/v2/checker/scopes.ts", "const excluded = new Set(pattern.properties.flatMap(item => item.type === 'RestElement' ? [] : [propertyName(item.key)!]));", "const excluded = new Set(pattern.properties.flatMap(item => item.type === 'RestElement' || item.computed ? [] : [propertyName(item.key)!]));", "test/v2/checker.ts", "静的な計算キーを rest の型から除外する"],
	["missing-diagnostic-wording", "src/v2/messages.ts", "params['actual'] !== 'missing') return translation;", "(params['actual'] !== 'missing' || Boolean(1))) return translation;", "test/v2/type-diagnostics.ts", "欠如プロパティの診断は日英とも値nullと区別する"],
	["typeof-unbound", "src/v2/checker/index.ts", "if (node.operator === 'typeof' && node.argument.type === 'Identifier') break;", "if (Boolean(0) && node.operator === 'typeof' && node.argument.type === 'Identifier') break;", "test/v2/checker.ts", "typeof の直接の未宣言識別子を許可する"],
	["fallthrough-truthy", "src/v2/checker/control-flow.ts", "if (node?.type === 'Literal') return Boolean(node.value);", "if (node?.type === 'Literal') return node.value === true;", "test/v2/checker.ts", "truthy リテラルと省略条件のループは fallthrough しない"],
	["rest-duplicate-check", "src/v2/interpreter.ts", "if (check && (!initialize || !checkedValue || plan?.explicit)) {", "if (check) {", "test/v2/runtime-types.ts", "restコピーと型検査のステップ上限を保つ: array rest 100000要素"],
	["partial-pattern-name", "src/v2/checker/index.ts", "name = patternName(pattern);", "void pattern;", "test/v2/checker.ts", "部分パターンの診断名を実行時と揃える: let [[a], b]: number[][] = [1, [2]];"],
	["array-lookup-quadratic", "src/v2/checker/index.ts", "if (firstSpread < 0 || index < firstSpread)", "if (!value.elements.slice(0, index + 1).some(part => part?.type === 'SpreadElement'))", "test/v2/checker.ts", "幅を倍にした数値キーの分割宣言の要素読取りは線形に増える（注釈あり）"],
	["rest-copy-proof-transfer", "src/v2/interpreter.ts", "\n\t\t\t\t\tyield this.bind(property.argument, rest, env, execution, initialize, target);", "\n\t\t\t\t\tyield this.bindTyped(property.argument, rest, env, execution, initialize, target, plan.check);", "test/v2/rest-types.ts", "ホストErrorの非列挙propertyがコピーにないことを検出する"],
	["rest-copy-mutation-check", "src/v2/interpreter.ts", "if (copiedCheck) checkCopiedElement(copiedCheck.element, next.value, label, index, pos, diagnosticName, copyStep);", "if (Boolean(0) && copiedCheck) checkCopiedElement(copiedCheck!.element, next.value, label, index, pos, diagnosticName, copyStep);", "test/v2/rest-types.ts", "親検査済みprefixの変異をコピー時に拒否する"],
	["nested-rest-diagnostic", "src/v2/interpreter.ts", "key -= restIndex;", "key = 0;", "test/v2/runtime-types.ts", "分割と入れ子restの診断名が実行前と一致する: let [a,...[x,...y]]:number[]=[1,2,\"x\"];"],
	["projection-null-branch", "src/v2/type-projection.ts", "if (kind === 'null') return undefined;", "if (kind === 'null') return adapter.keyword('any', type);", "test/v2/checker.ts", "到達可能な枝の型を検査: function f({a:{x}}:{a:{x:number}|null}){x=\"bad\";}"],
	["projection-string-rest", "src/v2/type-projection.ts", "if (kind === 'string') return operation.rest ? adapter.array(type, type) : type;", "if (kind === 'string') return type;", "test/v2/checker.ts", "射影の正しい値を受理: let [a,...r]:string=\"abc\";a=\"x\";r=[\"x\"];"],
	["projection-any-priority", "src/v2/type-projection.ts", "if (kind === 'any') return type;", "if (kind === 'any') return undefined;", "test/v2/checker.ts", "射影の正しい値を受理: function f([x,...r]:any|number[]){x=\"ok\";r=1;}"],
	["parent-whole-initial-check", "src/v2/interpreter.ts", "if (plan?.explicit) {", "if (Boolean(0) && plan?.explicit) {", "test/v2/rest-types.ts", "明示注釈は既定値の副作用より先に全体検査する"],
	["rest-element-union-projection", "src/v2/type-projection.ts", "if (operation?.kind === 'array' && operation.rest) return adapter.array(union(types.map(type => adapter.element(type))), types[0]!);", "if (Boolean(0) && operation?.kind === 'array' && operation.rest) return adapter.array(union(types.map(type => adapter.element(type))), types[0]!);", "test/v2/rest-types.ts", "非明示の入れ子array unionは各束縛へ独立して射影する"],
	["object-iterator-projection", "src/v2/type-projection.ts", "if (kind === 'object') return adapter.keyword('any', type);", "if (kind === 'object') return undefined;", "test/v2/rest-types.ts", "構造型のイテレータを分割できる: next構造型/restあり"],
	["union-copy-check", "src/v2/interpreter.ts", "if (copiedCheck) checkCopiedElement(copiedCheck.element, next.value, label, index, pos, diagnosticName, copyStep);", "if (copiedCheck && copiedCheck.element.kind !== 'union') checkCopiedElement(copiedCheck.element, next.value, label, index, pos, diagnosticName, copyStep);", "test/v2/rest-types.ts", "array unionのどの枝にも合わない実コピー値を拒否する"],
	["union-copy-double-check", "src/v2/interpreter.ts", "yield this.bindTyped(part, rest, env, execution, initialize, target, copiedCheck);", "yield this.bindTyped(part, rest, env, execution, initialize, target, undefined);", "test/v2/rest-types.ts", "union restの実照合枝をステップに含める: 要素unionの先頭string混在"],
	["union-copy-budget", "src/v2/interpreter.ts", "if (copiedCheck) checkCopiedElement(copiedCheck.element, next.value, label, index, pos, diagnosticName, copyStep);", "if (copiedCheck) checkCopiedElement(copiedCheck.element, next.value, label, index, pos, diagnosticName, () => { void copyStep; });", "test/v2/rest-types.ts", "restコピーの広い合併は2つ目以降の照合枝を課金する: 10 枝"],
	["union-first-branch-free", "src/v2/runtime/type-checks.ts", "const pause = state.first ? false : tick();", "const pause = tick();", "test/v2/rest-types.ts", "restコピーの入れ子合併は成功した枝で短絡する: 1"],
	["object-rest-projection-cache", "src/v2/runtime/type-plan.ts", "if (cached) return cached;", "if (cached && Boolean(0)) return cached;", "test/v2/rest-types.ts", "object内のrest射影は型と経路ごとに一度だけ展開する: loop"],
	["dynamic-projection-budget", "src/v2/interpreter.ts", "this.typePlan.projectDynamic(property.value as A.Pattern, plan.check, validated, () => this.tick(execution, pos))", "this.typePlan.projectDynamic(property.value as A.Pattern, plan.check, validated, () => {})", "test/v2/rest-types.ts", "異なる動的キーの広い射影準備は実行予算に含める"],
	["dynamic-projection-cache-retention", "src/v2/runtime/type-plan.ts", "yield* build(pattern, projectType(source, key));", "this.project(pattern, source, key);\n\t\tyield* build(pattern, projectType(source, key));", "test/v2/rest-types.ts", "動的キー射影を静的キャッシュへ保持しない: 2000 回、長さ 0"],
	["dynamic-nested-projection-regeneration", "src/v2/interpreter.ts", "} else if (!plan.transient) {", "} else if (true) {", "test/v2/rest-types.ts", "動的射影内の入れ子objectは準備済みの束縛計画を再利用する"],
	["dynamic-untyped-subtree-budget", "src/v2/runtime/type-plan.ts", "if (!check) return;", "if (false) return;", "test/v2/rest-types.ts", "型が未確定の動的キー部分木は走査せず深さに比例して計上する"],
	["dynamic-pattern-build-budget", "src/v2/runtime/type-plan.ts", "if (step()) yield;\n\t\t\tconst annotation", "const annotation", "test/v2/rest-types.ts", "動的射影のパターン生成も64ステップごとに譲る: array"],
].map(([name,file,before,after,testFile,testName])=>({name,file,before,after,testFile,testName}));
const selected=process.env.V2_TYPES_MUTATIONS ? mutations.filter(item=>process.env.V2_TYPES_MUTATIONS.split(',').includes(item.name)) : mutations;
assert.ok(selected.length,'対象の変異がありません');
const directory=mkdtempSync(join(process.cwd(),'.git','v2-types-mutations-'));
const originals=new Map(selected.map(item=>[item.file,readFileSync(item.file,'utf8')]));
const report={directory,expected:selected.length,detected:0,survived:0,invalid:0,excluded:0,records:[],restored:false};
const qualifiedNames=new Map();
const escapeRegex=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function command(name,args) {
	const result=spawnSync('bun',args,{encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
	writeFileSync(join(directory,`${name}.log`),`${result.stdout ?? ''}${result.stderr ?? ''}\nstatus=${result.status}; signal=${result.signal}; error=${result.error ?? ''}\n`);
	return {status:result.status,signal:result.signal,error:result.error ? String(result.error) : undefined};
}
function typecheck(name) { return command(name,['run','typecheck']); }
function tests(name,testFile,testName) {
	const output=join(directory,`${name}.json`);
	const args=['run','test',testFile,'--reporter=json',`--outputFile=${output}`];
	if(testName) {
		const candidates=qualifiedNames.get(testFile)?.filter(item=>item.title===testName) ?? [];
		assert.equal(candidates.length,1,`${testName}: 対象のテストが一意ではありません`);
		args.push('-t','^'+escapeRegex(candidates[0].fullName)+'$');
	}
	const result=command(name,args);
	try {
		const data=JSON.parse(readFileSync(output,'utf8'));
		const assertions=data.testResults.flatMap(suite=>suite.assertionResults);
		if(!testName)qualifiedNames.set(testFile,assertions.map(item=>({title:item.title,fullName:[...item.ancestorTitles,item.title].join(' > ')})));
		const executed=assertions.filter(item=>item.status==='passed'||item.status==='failed');
		return {...result,executed:executed.length,failed:executed.filter(item=>item.status==='failed').map(item=>({name:item.fullName,messages:item.failureMessages}))};
	} catch(error) {return {...result,executed:0,failed:[],reportError:String(error)};}
}
try {
	for(const item of selected)assert.equal(originals.get(item.file).split(item.before).length-1,1,`${item.name}: 置換箇所が一意ではありません`);
	const baselineTypecheck=typecheck('baseline-typecheck');
	report.baselineTypecheck=baselineTypecheck;
	assert.equal(baselineTypecheck.status,0,'正常版の型検査が失敗しました');
	report.baseline=[];
	for(const testFile of new Set(selected.map(item=>item.testFile))) {
		const result=tests(`baseline-${report.baseline.length}`,testFile);
		report.baseline.push({testFile,...result});
		assert.ok(result.status===0 && result.executed>0,'正常版の意味検査が失敗しました');
	}
	for(const [index,item] of selected.entries()) {
		const row={name:item.name,file:item.file,testName:item.testName};
		try {
			writeFileSync(item.file,originals.get(item.file).replace(item.before,item.after));
			row.typecheck=typecheck(`mutant-${index}-typecheck`);
			if(row.typecheck.status!==0) {row.outcome='invalid-typecheck';report.invalid++;}
			else {
				row.test=tests(`mutant-${index}`,item.testFile,item.testName);
				// 起動・変換失敗ではなく、指定した意味検査の実行済み assertion だけを検出に数えます。
				if(row.test.executed===1 && row.test.status===1 && row.test.failed.length===1 && row.test.failed[0].name.endsWith(item.testName)) {row.outcome='detected';report.detected++;}
				else if(row.test.executed===1 && row.test.status===0) {row.outcome='survived';report.survived++;}
				else {row.outcome='invalid-test';report.invalid++;}
			}
		} catch(error) {row.outcome='invalid-run';row.error=String(error);report.invalid++;}
		finally {writeFileSync(item.file,originals.get(item.file));}
		row.restoredTest=tests(`restored-${index}`,item.testFile,item.testName);
		report.records.push(row);
		console.error(JSON.stringify({name:row.name,outcome:row.outcome,restored:row.restoredTest.status===0}));
		assert.ok(row.restoredTest.status===0 && row.restoredTest.executed===1,`${item.name}: 復元後の意味検査が失敗しました`);
	}
} catch(error) {report.error=String(error);}
finally {
	for(const [file,original] of originals)writeFileSync(file,original);
	report.restored=[...originals].every(([file,original])=>readFileSync(file,'utf8')===original);
	report.finalTypecheck=typecheck('restored-typecheck');
	report.valid=report.detected===report.expected && report.invalid===0 && report.survived===0 && report.restored && report.finalTypecheck.status===0 && !report.error;
	writeFileSync(join(directory,'summary.json'),JSON.stringify(report,null,2)+'\n');
	console.log(JSON.stringify(report,null,2));
	if(!report.valid)process.exitCode=1;
}
