# Toneriko Script 2 の設計案

Toneriko Script を作り直す案です。構文を JavaScript(と型注釈)の小さな部分集合にし、他の言語で書きやすいとされる機能を標準ライブラリで足し、型注釈と実行時の検査で安全性を持たせます。言語も道具も軽く保ちます。AiScript の構文との互換は持ちません。パーサー・インタプリタ・標準ライブラリは `src/v2/` に実装しています。型注釈の実行時検査と実行前検査も実装しています。Misskey の関数は次の段階で扱います。

文中の「今」は 1.3.0 の振る舞いで、例は 1.3.0 で実行して確かめています。

## なぜ JavaScript の部分集合か

- **書く人の多くが JavaScript を知っている:** 本家の issue、記事、公開スクリプトで確かめられた書き手は、JavaScript の経験者と言語の開発に関わる人でした。プログラミング未経験だと自分で書いている体験談は見つかっていません。
- **知っていることがそのまま使える:** Python 経験者に R を教えた研究では、両者の対応を説明すると成績が上がりました。一方で、同じ形に違う意味がある所では、知っている意味で誤って読みました(Shrestha ら 2018)。形も意味も JavaScript と同じにすれば、この誤りが起きません。
- **困っていた点が消える:** 本家に寄せられた不満のうち、次のものは JavaScript の書き方にすると無くなります。
  - 空白と改行の規則(6 人)
  - 文字列の扱い(6 人)
  - `Core:` と `.` のどちらに関数があるか(4 人)
  - `for` の範囲(4 人)
  - オブジェクトの書き方(4 人)

本物の JavaScript を WebAssembly の箱(QuickJS など)で動かす案は採りません。次の 3 つが理由です。

- **`await` を書かせることになる:** MakeCode は、初めて書く人に `await` を求めないために、待つ処理を普通の呼び出しに見せています。今の Toneriko Script も同じで、この良さを残します。
- **作り直しが要る:** 実行時間の上限(5 秒)とホストへの譲り方を、作り直すことになります。
- **大きさが増える:** バンドルが数百 KB 増えます。

TypeScript の検査器をブラウザで動かす案も採りません。TypeScript 6.0.3 の `typescript.js` は圧縮前で 8.8 MB あり、型の書き方も多く、言語と道具が重くなるためです。

## 方針

1. **JavaScript として書いたコードは、JavaScript と同じ結果になるか、エラーになる。** 違う結果を黙って返すのは、下の「意図した違い」に書いた所だけです。
2. **軽く保つ。** 構文も標準ライブラリも、小さなスクリプトで使うものに絞ります。入れるか迷ったものは入れず、使えないと分かるエラーを出します。
3. **書きやすさは関数とメソッドで足す。** 他の言語から借りる機能は標準ライブラリに入れ、独自の構文は足しません。
4. **安全性は、少ない種類の型注釈と実行時の検査で持つ。**
5. **使えない書き方には、使える書き方を案内する。** JavaScript の機能のうち入れないものと、AiScript の書き方には、エラーで代わりを示します。

## 書き方の例

Misskey の Play の雛形(ローカルタイムライン)です。今は 43 行あります。

```ts
function fetchTimeline() {
	Ui.render([Ui.text({ text: "読み込み中..." })])

	const notes = Mk.api("notes/local-timeline", {})
	const els = notes.map(note => Ui.container({
		bgColor: "#444",
		fgColor: "#fff",
		padding: 10,
		rounded: true,
		children: [
			Ui.mfm({ text: note.user.name ?? note.user.username, bold: true }),
			Ui.mfm({ text: note.text ?? "(リノートもしくはメディア・投票のみのノート)" }),
		],
	}))

	Ui.render([
		Ui.text({ text: "ローカル タイムライン" }),
		Ui.button({ text: "更新", onClick: () => fetchTimeline() }),
		Ui.container({ children: els }),
	])
}

fetchTimeline()
```

`Mk.api` はサーバーの応答を待ちますが、`await` は要りません。

## 構文

### 使えるもの

| 分類 | 書き方 |
|---|---|
| 宣言 | `const`、`let`(ブロック単位、宣言より前で使うとエラー) |
| 関数 | `function` 宣言(先に呼べる)、アロー関数、既定値、残り引数 `...xs`、分割代入 |
| 制御 | `if`/`else`、`for (;;)`、`for … of`、`while`、`do … while`、`break`/`continue` とラベル、`switch`、`try`/`catch`/`finally`、`throw`、`return` |
| 演算子 | `+ - * / % **`、`=== !== < <= > >=`、`&& \|\| ??`、`!`、`?.`、`? :`、`typeof`、`in`、`delete`、`= += -= *= /= %= **= ??=`、文としての `++`/`--` |
| リテラル | 数(`1_000`、`0x`、指数)、文字列(JavaScript のエスケープ)、テンプレート `` `${x}` ``、配列、オブジェクト(省略形 `{ x }`、計算するキー `[k]: v`、スプレッド) |
| 型注釈 | 変数、引数、戻り値に書ける。型は下の「型注釈」の節の 6 種類だけ |
| `new` | `new Error(message)` だけ |
| コメント | `//`、`/* */` |
| プラグインの情報 | `export const meta = { name: "…", version: "…" }`(値はリテラルだけ) |

`async` と `await` は書いても構文エラーにせず、無いのと同じに扱います。JavaScript から貼ったコードがそのまま動くようにするためです。

### 使えないもの

使うと構文エラーになり、代わりを案内します。

| 書き方 | 入れない理由 | 案内 |
|---|---|---|
| `class`、`this`、`new`(`Error` 以外) | 小さなスクリプトでは使われず、`this` の束縛の規則が複雑 | オブジェクトと関数で書く |
| `Map`、`Set`、`Date` のオブジェクト | 軽く保つため | オブジェクト、`arr.unique()`、`Date.now()` と `Date.format` |
| `var` | 関数単位の範囲と巻き上げで読み違える | `let`、`const` |
| `==`、`!=`(`null` との比較以外) | 型を変換して比べる | `===`、`!==`。`x == null` は使える(`undefined` が無いので `=== null` と同じ) |
| 式の中の代入(`if (x = 1)`、`a = b = 1`) | 比較と取り違える | 代入は文で書く |
| カンマ演算子 | 読み違いが多い(Torres ら 2023 で正答 28/70 → 65/70) | 文に分ける |
| 式の中の `++`(`a[i++]`) | 前置と後置で値が変わる | `i += 1` を別の文に |
| ビット演算 `& \| ^ ~ << >> >>>` | 小さなスクリプトでほぼ使わない。AiScript の `^`(累乗)と取り違える | 累乗は `**`。乱数は `Math.seededRandom` |
| `for … in` | キーの順の規則が複雑 | `for (const k of Object.keys(o))` |
| 正規表現 | 利用者の入力しだいで処理が終わらなくなる | `includes`、`split`、`replaceAll` など |
| `eval`、`Function`、`with`、ジェネレーター、`Symbol`、`BigInt`、getter と setter、`arguments`、`debugger`、`import` | 小さなスクリプトに要らない | |
| `Promise`、`.then()` | 待つ処理は自動で待つ | 並行に動かすなら `arr.mapConcurrent` |
| `undefined` | 値が無いことは `null` だけで表す | `null` |
| 型の書き方のうち 6 種類以外(`type`、`interface`、`enum`、型引数 `<T>`、`as`、`!`、`Record` など) | 軽く保つため。`as` と `!` は検査をすり抜ける | 6 種類で書くか、型注釈を省く |

### 改行とセミコロン

セミコロンは省けます。JavaScript の自動セミコロン挿入で、思わぬ読み方になる所はエラーにします。

- **前の文の続きと読まれる行:** 文の後の行が `(`、`[`、`` ` ``、`+`、`-`、`/` で始まり、JavaScript なら前の行の続きと読まれる所は、エラーにします。1 行にまとめるか、前の行の終わりに `;` を書くよう案内します。
- **`return` の後の改行:** `return` の直後で改行すると、JavaScript は値を返さないので、エラーにします。
- **研究の裏付け:** 自動セミコロン挿入の思わぬ読み方を避けたコードでは、出力を予測できた人が 32/70 から 68/70 に増えました(Torres ら 2023)。

## 意図した違い

JavaScript として書いたコードが、違う結果になる所と、構文の受理に上限がある所は次の 7 つです。

| 違い | JavaScript | Toneriko Script | 理由 |
|---|---|---|---|
| 待つ処理 | `Mk.api()` や `async` 関数は Promise を返し、`await` が要る | 最後まで待って値を返す。`async` 関数の呼び出しも Promise を返さない | 初めて書く人に `await` を求めない |
| 文字列の単位 | UTF-16 の単位で数える(`"👍🏽".length` は 4) | 見た目の 1 文字(書記素)で数える(1)。空の検索文字列は書記素の境界に一致する。書記素の途中の一致で検索結果が JavaScript と異なる場合はエラー | 絵文字の多いノートを扱うので、見た目の文字数が要る |
| 値が無いこと | `undefined` と `null`。既定値は `undefined` のときに使う | `null` だけ。無いプロパティ、省いた引数、値を返さない関数は `null`。引数と分割代入の既定値は、値が無いときと `null` のときに使う | 2 つを使い分ける場面が小さなスクリプトに無い |
| 配列の範囲外 | `arr[10]` は `undefined` | エラー。`arr.at(10)` は `null` | 添字の誤りに気付けるようにする |
| 実行の上限 | 無い | 5 秒待たずに動き続けるか、既定の 50 万ステップを超えるとエラー | 無限ループで画面を止めない |
| オブジェクトの原型 | `{}` にも `toString` などがある | 無い。書いたキーだけがある。スクリプトのエラーも原型を持たず、`name` と `message` の既定値だけを返す。`e.toString`・`e.constructor` は `null`。ホスト由来も含め、エラーの `stack` とエンジンの位置のキー（`fileName`・`lineNumber`・`columnNumber`・`sourceURL`・`line`・`column`・`originalLine`・`originalColumn`）は `null` | 利用者の文字列をキーにする辞書として使うため |
| 構文の入れ子 | エンジンのスタックの上限まで読む | 括弧、配列、オブジェクト、関数、ブロック、分割代入のパターンなどは 256 段まで。左結合の演算やメンバーの連鎖は数えない。単項演算と右結合の演算は、括弧をまたぐ構文木の各経路で合わせて 1,024 段まで。演算子の優先順位を混ぜても 256 段の入れ子を読める | ブラウザのスタックを溢れさせないため |

文字列の単位の違いは、次の操作に関わります: `length`、`s[i]`、`at`、`slice`、`substring`、`indexOf`、`includes`、`startsWith`、`endsWith`、`split`、`replace`、`replaceAll` と置換関数へ渡す位置、`for … of`、`padStart` と `padEnd` の長さ。

次の 3 つは、JavaScript と同じ結果を黙って返すと誤りに気付けないので、エラーにします。

- **数を含む配列の `sort()`:** 比べる関数を省くと、JavaScript は文字列として並べます(`[10, 9, 1].sort()` は `[1, 10, 9]`)。比べる関数を渡すか `sortBy` を使うよう案内します。文字列だけの配列は、JavaScript と同じく省けます。
- **文字列と配列・オブジェクト・`null` の `+`:** JavaScript では `"a" + null` が `"anull"`、`"a" + {}` が `"a[object Object]"` になります。文字列と数・真偽値の `+` は、JavaScript と同じくつなぎます。
- **暗黙の型変換:** `"5" * 2` や `1 + null` はエラーです(JavaScript は 10 と 1)。

テンプレートの `${}` も、文字列を `+` でつなぐときと同じ規則です。文字列・数・真偽値をつなぎ、`null`・配列・オブジェクト・関数はエラーにします。エラーでは `JSON.stringify(x)` か `x ?? ""` を使うよう案内します。

## ホストから渡す値

守る相手はスクリプトです。スクリプトから作れる値を使って、ホストの内部情報（`stack`、エンジンの位置情報、原型の getter）に届かないことを保証します。

ホストが渡す値は、JSON で表せる値、クラスのインスタンス、この realm の `Error` と `DOMException`、`Promise` を前提にします。別 realm の値、`Proxy`、原型を付け替えた値、エラーを偽装した値は、ホストの責任で渡さないようにします。

ホストは、スクリプトから受け取った値と、スクリプトに渡した値を、後から書き換えないことを約束します。accessor の追加、原型の変更、配列の穴の作成なども含みます。ホストによる `Array.prototype` の変更も前提の外です。

型注釈の検査を保証するのは、同じ `Interpreter` で作られたスクリプト関数だけです。別の `Interpreter` から渡された関数を呼ぶ場合、その関数の注釈も、閉包が捕捉した束縛の注釈も検査の保証対象外です。捕捉した `let x: number` への書込みも検査されない場合があります。同じ構文木を共有している場合も、受け取った関数の引数・本体を型計画から切り離して評価します。

`Interpreter.call` と `HostContext.call` の引数配列は、呼び出しごとに使用前に一度、各添字を検査して密な配列へコピーします。穴は SPARSE_ARRAY、accessor は ACCESSOR_PROPERTY として拒否し、getter は呼びません。

前提の外の値では、見えないはずのキーが見えたり、エラーになったりすることがあります。


### 実行の上限

既定の上限は Play・プラグイン共通で 500,000 ステップです。`maxSteps` を指定すると上書きでき、省略と `undefined` は既定値を使います。実行ごと、タイマーのコールバックごとに予算を作り、内部の関数呼出し・標準関数・型検査は同じ予算を消費します。

Linux x86_64、AMD EPYC-Milan の 6 vCPU、Bun 1.4.3 で、1.3.0 と v2 を各条件 5 回のウォームアップ後に 30 回ずつ計測しました。両版ともホストへの譲りは `setTimeout(0)`、判定間隔は 8 ms です。時間は p50 / p95（ms）です。

| 無限処理 | 1.3.0・10 万 | v2・40 万 | v2・50 万 | v2・100 万 |
|---|---:|---:|---:|---:|
| 加算ループ | 28.885 / 34.137 | 10.166 / 11.891 | 12.392 / 14.705 | 24.179 / 27.908 |
| 関数呼出しループ | 39.451 / 56.439 | 47.779 / 70.035 | 59.349 / 75.456 | 118.747 / 152.326 |

同じ停止時間にそろう単一の換算率はありません。50 万は、旧版の上限内に収まる代表処理の余裕と、関数呼出しを続ける無限処理の停止時間を両立させる値として選びます。100 万では後者の時間が大きく伸びます。全スクリプトの互換性を保証する測定ではありません。

有限処理では 33,330 回の加算ループが旧版 99,998 / v2 333,317 ステップ、fib(18) が旧版 96,154 / v2 117,058 ステップです。4 万回のブロック付きループは v2 400,017 ステップ（旧版では 120,008 で既に上限外）でした。v2 の 50 万では 4 万回ループと fib(18) がそれぞれ 30 / 30 回完走しました。注釈付きの処理では検査分もステップに含まれます。

## 型注釈

### 書ける型

| 型 | 例 |
|---|---|
| 基本 | `number`、`string`、`boolean`、`null`、`any` |
| 配列 | `number[]`、`(string \| null)[]` |
| オブジェクト | `{ id: string, count: number }` |
| 関数 | `Function`(関数であることだけ) |
| 合併 | `string \| null` |
| 戻り値なし | `void` |

```ts
function greet(name: string, times: number = 1): string {
	return `Hello, ${name}!`.repeat(times)
}
let picked: string | null = null
```

型注釈はどれも省けます。どれも TypeScript と同じ書き方なので、TypeScript を知っている人は覚え直さずに済みます。

`void` は戻り値の型にだけ書けます。括弧と合併型の中でも戻り値位置なら使えますが、変数・引数・配列要素・オブジェクトのプロパティの型には使えません。値なしの戻り値は `null` として検査します。アロー関数の `(p): ({x:number}) => p` は TypeScript と同じく拒否し、`(p): {x:number} => p` を案内します。

### 調べること

- **実行時:**
  - 調べる場所: 型注釈の付いた変数の初期値と代入、引数(既定値を入れた後)、戻り値
  - 調べる深さ: 配列とオブジェクトは直下の要素まで。全部の段を調べると、大きな配列を代入するたびに中身をすべてたどるため
  - 例: `x は number と書かれていますが、string の値 "text" が入りました (3 行目)`
- **実行前:**
  - 型の違うリテラルを入れたとき(`let x: number = "text"`)
  - `const` への再代入
  - 宣言されていない変数(似た名前を「もしかして」で出す)
  - 標準の関数とホストの関数に渡す引数の数
  - 中身のある `case` が `break` や `return` なしに次の `case` へ進むとき(警告)

実行時の検査は次の規則に従います。

- 初期値のない `let x: number;` は宣言だけでは拒否せず、後の代入を検査します。
- 引数の既定値は左から適用し、その値を検査します。省略可能な引数は、省略と `null` の同一視に従って `null` を許可します。
- オブジェクトの省略可能なプロパティは、キーの欠如を許可します。存在する `null` は型に `null` が含まれる場合だけ許可します。余分なプロパティは許可します。
- オブジェクト型は配列・関数を除くオブジェクトに対応します。空の `{}` も同じです。TypeScript の `{}` が nullish 以外の基本値まで受け入れる点とは異なります。ここでは実行時のオブジェクトの形を表す型として扱います。
- 配列は各要素、オブジェクトは宣言された各プロパティの外側の型まで検査します。例えば `{items: number[]}` に `{items: ["x"]}` を渡しても、その配列の中には進みません。`{items: 1}` は拒否します。括弧と合併型は検査の深さを消費しません。
- 分割代入では、明示された構造型から取り出した束縛へ型を対応付けます。元の値を浅く検査し、取り出した値も既定値を適用した後に束縛の型で検査します。足りない要素の null もこの時点で検査します。対応付けた型は、その束縛への後の代入にも使います。文字列・数のリテラルの計算キーは rest の型から除き、動的な計算キーがある場合は rest に型を対応付けません。配列型のオブジェクト分割では、添字には要素型、length には number、それ以外には any を対応付けます。値から型を推論する処理は行いません。
- 分割の各束縛の型は独立に対応付け、束縛どうしが同じ合併型の枝にそろうことは保証しません。配列パターンでは合併型の各枝から要素型を取り出して合わせ、rest にはその要素型の配列を対応付けます。例えば `number[] | string[]` の要素は `number | string`、rest は `(number | string)[]` になり、後の rest への混在配列の代入も許可します。`string` は書記素単位で反復し、要素は `string`、rest は `string[]` です。オブジェクト型はイテレータにも適合し得るため、配列パターンへの射影結果を `any` とします。`null`・`Function`・`boolean`・`number` の枝は配列パターンへの対応付けから除きます。`any` の枝があれば結果は `any`、残る枝がなければ型を対応付けません。オブジェクトパターンでも `null` の枝を除きます。元の値の注釈は分割や既定値の評価より前に検査し、その後、取り出した値を各束縛の射影型で検査します。取得した値から合併型の候補を絞り込む処理は行いません。実行前検査と実行時検査は同じ射影規則を使います。
- 戻り値は `finally` を含めて最終的に返す値を検査します。値なしの `return` と本体末尾は `null` です。
- 型注釈は値への代入・引数・戻り値の境界で検査します。プロパティや配列要素の後からの変更を常時監視せず、次の注釈付き境界で再検査します。
- ホスト値は通常のプロパティアクセスと同じ検査を通します。型検査や診断の文字列化のために getter を呼んだり、原型の情報を公開したりしません。

`parse` が返す構文木は変更せず使います。型注釈の有無をパーサーが記録し、注釈のない構文木は準備時に走査し直しません。編集する場合は `structuredClone` で別の構文木にしてから変更します。外部で作った構文木は線形に走査して準備します。

実行計画は `Interpreter.prepareProgram(program)` で事前に作れます。`exec` も同じ準備を必ず行い、同じ構文木の準備は繰り返しません。準備の費用と実行時間は分けて計測します。注釈を一度も使わないインスタンスは既存の評価処理を使い、反復中に型の有無を調べる分岐を追加しません。型付き束縛を持つインスタンスでは、その後の注釈なしの関数や `exec` からの代入も検査します。

配列の rest のコピーでは、取得した実値の要素型を同期的に検査してから格納します。直下要素の取得と定数時間の外形検査は同じステップに含めます。合併型との照合では、最初の枝の照合を直下要素の取得のステップに含め、2 つ目以降に実際に調べた枝ごとに 1 ステップを追加します。読み取りから検査、格納まではホストへ譲りません。コピー用の射影型の準備は同期的に行い、追加のステップは計上しません。

上記の配列 rest の定数時間の外形検査とコピー用の射影型の準備を除き、型検査にも実行ステップを計上します。配列・オブジェクトの要素、合併型の枝、分割束縛の型の展開にも計上します。直下要素の合併型の照合は、最初の枝を要素の 1 ステップに含め、2 つ目以降に実際に調べた枝ごとに 1 ステップを追加します。入れ子の合併型も葉の照合順で数え、合併型の括弧によって計上数は変えません。通常の評価では 64 項以内ごとにホストへ譲る判定を行います。型の有効化より前から実行中の同期区間に残る書込みも、型付き束縛の検査を通します。この既存同期区間では途中で待てませんが、書き込む側の実行予算と時間上限は共有します。

実行前の検査は、型の推論はしません。変数をたどって型を決めると、検査器が TypeScript と同じくらい大きくなるためです。`null` かもしれない値への誤った操作は、実行時に `null` のプロパティを読もうとした所でエラーになり、`?.` と `??` を案内します。


### 実行前検査の API

`check(program, { globals?, hostCatalog? })` は `src/v2/checker/index.ts` から公開し、実行せず `Diagnostic[]` をソース順に返します。`globals` はホストが提供する名前の配列、`hostCatalog` は `CatalogEntry[]` です。診断には `code`、`params`、`pos`、`loc`、`hint`、`severity` があり、検査器は開始・終了位置を付けます。`formatDiagnostic(diagnostic, 'ja' | 'en')` で位置付きの表示文を作れます。

```ts
const { program, warnings } = parse(source);
const diagnostics = [...warnings, ...check(program, {
    globals: Object.keys(host), hostCatalog,
})];
if (!diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
    await new Interpreter(host).exec(program);
}
```

`exec` は実行前検査を自動で呼びません。呼び出し側が診断を表示して実行を止めるか選びます。警告だけでは停止しません。実行時の型検査は `check` を呼んだかによらず働きます。

ホスト定義は標準の `catalog.json` と同じ形で書けます。5 段目の Mk/Ui/Play/Plugin もこの形を使います。

```json
[{
  "name": "Mk.api",
  "receiver": "global",
  "args": [
    { "name": "endpoint", "type": "string" },
    { "name": "params", "type": "any", "optional": true }
  ],
  "returns": "any",
  "description": { "ja": "Misskey API を呼び出します。", "en": "Calls the Misskey API." }
}]
```

必須引数の数を下限、全引数の数を上限とし、`rest` があれば上限なしです。`kind: "constant"` の項目は呼出し検査の対象外です。標準関数の定義は `src/v2/stdlib/` の catalog と実装の共通定義から読み、`Function.length` は使いません。ホストが同名の名前空間を渡した場合は標準の名前空間全体を置き換えます。

引数数を断定するのは、直接の関数名・名前空間、リテラルの受け手、明示された `string`・`number` 型の受け手です。配列変数のメソッドは書換え可能なため断定しません。関数別名と未知の spread からは推論せず、平坦な配列リテラルの spread だけを数えます。名前空間の書換えや外への受渡しがある場合も、その名前空間の断定を控えます。字句スコープによる同名の宣言を優先します。

リテラルの検査は注釈付きの初期値・単純代入・分割束縛の既定値を対象にし、演算結果の型は推論しません。中身のある case から次の case へ進み得る場合に警告します。`break`・`return`・`throw`、ループと `try/catch/finally` の制御を考慮します。

同じ範囲の二重宣言はパーサーが拒否します。let/const/function/引数の組合せを扱い、別ブロックの同名宣言は許可します。

| 診断コード | 種別 | 日本語の例 | 英語の例 |
|---|---|---|---|
| `TYPE_ANNOTATION_MISMATCH` | error | x は number と書かれていますが、string の値 "text" が入りました。 | x is annotated as number, but received the string value "text". |
| `CONST_ASSIGNMENT` | error | x は再代入できません。 | Cannot reassign x. |
| `UNBOUND_IDENTIFIER` | error | x は宣言されていません。 | x is not declared. |
| `UNBOUND_IDENTIFIER_SUGGESTION` | error | cout は宣言されていません。もしかして count ですか？ | cout is not declared. Did you mean count? |
| `ARGUMENT_COUNT` | error | range の引数は 2〜3 個ですが、1 個渡されています。 | range expects 2–3 arguments, but received 1. |
| `CASE_FALLTHROUGH` | warning | この case は次の case に進みます。 | This case falls through to the next case. |
| `VOID_TYPE_POSITION` | error | void は戻り値の型にだけ書けます。 | void is only allowed in return types. |
| `PARENTHESIZED_ARROW_RETURN_TYPE` | error | このアロー関数の戻り値型には括弧を付けられません。 | This arrow return type cannot be parenthesized. |
| `ARROW_OBJECT_BODY` | error | オブジェクトを返すなら x => ({ … }) と書きます。 | Use x => ({ … }) to return an object. |
| `DUPLICATE_DECLARATION` | error | 同じ範囲で x が二重に宣言されています。 | Duplicate declaration of x. |

表示には `(3 行目、5 列目)` / `(line 3, column 5)` の形で位置を付けます。案内は診断の `hint` でも取得できます。

### 型検査の性能

型注釈付きコードの性能は、計画の「原始型で数%〜2割程度」という目安に収まらないケースが残っています。変更前比の実行時間 p50 は Bun の既定引数で +21.8%、map で +20.6%、Node の既定引数で +26.8%、map で +28.2% でした。ループは Bun +18.5%／Node +19.8%、引数と戻り値付きの呼び出しは +9.4%／+11.1% です。注釈なしの 10,000 宣言では、Node の parse＋準備の p95 が +40.5% でした。この結果を含め、性能条件をすべて達成したとは判断していません。

Linux x86_64、AMD EPYC-Milan、6 vCPU で、Bun 1.4.3 と Node 24.19.0 の built 成果物を比較しました。変更前は `05fe359` です。各ケースを独立した 3 プロセスで実行し、各プロセスで各版 10 回ウォームアップ後に 30 対を交互実行しました。実行順を AB／BA と交互にし、import 順もプロセスごとに AB／BA／AB と変更しています。版・ケースごとの測定は 90 回です。

各ランタイムで 23 ケース、測定 4,140 回とウォームアップ 1,380 回の計 5,520 記録があり、出力照合はすべて成功しました。失敗 0、除外 0 です。全実行で `maxSteps=1,000,000,000`、`maxBusyTime=60,000 ms`、`yieldInterval=8 ms` を指定し、各版の `defaultYieldToHost` を同じ計測用関数で包みました。この性能比較はデフォルトの 50 万ステップでの上限検証とは別です。

各回、新しい構文木と Interpreter を作ります。構築・parse・`prepareProgram`・実行を別々に測り、既存の遅延コンパイルは実行時間に含めています。変更前に `prepareProgram` はないため準備時間は 0 とし、変更後は準備済みの `exec` を測定しました。parse＋準備は各回の合計時間から p50／p95 を計算しています。結果の照合は計測区間の外で行いました。

以下の数値は p50 / p95、単位は ms です。`plain` は注釈なし、`typed` は対応する明示注釈付きコードです。変更前も同じ注釈付きソースを解析しますが、型注釈を実行時に検査しません。loop は 40,000 回、call・default・object は 20,000 回、map は 10,000 要素です。array の数字は要素数、prepare の数字は宣言数を表します。 性能比較の loop は本体が単文の加算ループで、上限の校正に使ったブロック付きループとは別です。

| ケース | 計測範囲 | Bun 変更前 | Bun 変更後 | Node 変更前 | Node 変更後 |
|---|---|---:|---:|---:|---:|
| loop/plain | 実行 | 11.3208 / 16.4404 | 11.4960 / 18.0576 | 11.1944 / 13.6799 | 11.3415 / 14.4953 |
| loop/typed | 実行 | 11.5677 / 15.3359 | 13.7114 / 17.1674 | 11.0009 / 12.3801 | 13.1795 / 14.2360 |
| call/plain | 実行 | 43.4948 / 54.9162 | 43.9413 / 53.9662 | 56.0777 / 62.0284 | 55.9027 / 65.7165 |
| call/typed | 実行 | 40.5909 / 47.5523 | 44.4059 / 53.9139 | 56.4338 / 61.4293 | 62.7026 / 67.8582 |
| default/plain | 実行 | 42.8913 / 52.9724 | 43.0503 / 50.3763 | 62.2131 / 66.8066 | 62.5489 / 72.2833 |
| default/typed | 実行 | 45.1414 / 53.5236 | 54.9658 / 64.3085 | 61.6717 / 65.0422 | 78.2099 / 86.0261 |
| map/plain | 実行 | 8.1202 / 9.8376 | 8.0692 / 9.4736 | 7.3949 / 11.6860 | 7.2836 / 11.0446 |
| map/typed | 実行 | 7.8587 / 10.0628 | 9.4791 / 11.2752 | 7.2414 / 11.8984 | 9.2871 / 12.5761 |
| object/plain | 実行 | 57.4536 / 73.9494 | 57.5620 / 72.1160 | 77.8698 / 85.6951 | 78.1007 / 88.1841 |
| object/typed | 実行 | 58.6477 / 70.1152 | 88.6071 / 101.7023 | 79.3648 / 85.3507 | 117.6260 / 130.2682 |
| array0/plain | 実行 | 0.0610 / 0.1138 | 0.0653 / 0.1328 | 0.0538 / 0.0802 | 0.0557 / 0.0833 |
| array0/typed | 実行 | 0.0677 / 0.1105 | 0.0858 / 0.1776 | 0.0534 / 0.0817 | 0.0740 / 0.1114 |
| array10/plain | 実行 | 0.0616 / 0.1356 | 0.0677 / 0.1524 | 0.0545 / 0.0946 | 0.0580 / 0.0998 |
| array10/typed | 実行 | 0.0694 / 0.1720 | 0.1028 / 0.2542 | 0.0531 / 0.0906 | 0.0909 / 0.1571 |
| array1000/plain | 実行 | 0.0650 / 0.1686 | 0.0641 / 0.1556 | 0.0534 / 0.0817 | 0.0562 / 0.0848 |
| array1000/typed | 実行 | 0.0625 / 0.2845 | 0.3464 / 0.6807 | 0.0559 / 0.1021 | 0.3705 / 0.5996 |
| array100000/plain | 実行 | 0.0769 / 0.1633 | 0.0768 / 0.1222 | 0.0695 / 0.0987 | 0.0725 / 0.1141 |
| array100000/typed | 実行 | 0.1184 / 0.2138 | 40.5672 / 46.4748 | 0.0933 / 0.1530 | 30.8986 / 36.4452 |
| fib/plain | 実行 | 17.1302 / 21.4394 | 17.0556 / 22.8830 | 21.8173 / 25.8456 | 21.6455 / 28.5795 |
| closure/plain | 実行 | 23.2115 / 28.2846 | 23.4917 / 33.0020 | 33.7007 / 42.0892 | 33.8804 / 39.9070 |
| prepare100/plain | parse＋準備 | 0.4240 / 0.7086 | 0.4532 / 0.7411 | 0.3362 / 0.6556 | 0.3469 / 0.6638 |
| prepare1000/plain | parse＋準備 | 3.9225 / 6.5229 | 3.9409 / 5.9413 | 3.2817 / 7.0799 | 3.4269 / 8.1425 |
| prepare10000/plain | parse＋準備 | 42.1790 / 49.0273 | 43.0670 / 53.0548 | 41.1783 / 48.6203 | 41.4635 / 68.3312 |

準備時間だけの記録は次のとおりです。宣言数 3 条件は注釈なし、loop／call は注釈付きプログラムの初回準備です。パーサーが注釈なしと記録した構文木では再走査を省くため、宣言数が増えても型の準備で全体を歩きません。parse＋準備全体には解析・割り当て・GC が含まれるので、準備単独の値から全体の速度維持を結論付けません。

| ケース | Bun 準備 p50 / p95 | Node 準備 p50 / p95 |
|---|---:|---:|
| prepare100/plain | 0.0017 / 0.0069 | 0.0023 / 0.0099 |
| prepare1000/plain | 0.0041 / 0.0167 | 0.0053 / 0.0160 |
| prepare10000/plain | 0.0088 / 0.0397 | 0.0154 / 0.0354 |
| loop/typed | 0.0325 / 0.0858 | 0.0143 / 0.0273 |
| call/typed | 0.0418 / 0.0799 | 0.0185 / 0.0288 |

記録にはステップ数、評価フレーム数、ホストへ譲った回数、譲るまでの最長同期区間、RSS も含めています。`maxSynchronousMs` は exec 開始または復帰から次の譲りまたは終了までで、譲って待つ時間を含めません。RSS は before／after を同じプロセスで読み込んだ状態の値なので、版ごとの専有メモリとはみなせません。

CPU プロファイルは最終版の Bun／Node の loop・call・default・map・prepare の計 10 本を採取しました。各プロファイルはウォームアップ 20 回＋200 回で、220 回の出力検証が成功しています。次の割合は `samples` を `timeDeltas` で重み付けした self 時間の割合です。インライン処理は親関数へ帰属する場合があり、0.00% は処理がないことを意味しません。この割合を正式比較の wall 時間の増加率に直接換算することもできません。

| プロファイル | 主な self 時間の割合 |
|---|---|
| Bun loop | `typedIteration` 21.66%、`checkScalar` 6.29%、`checkBindingScalar` 3.13%、`installType` 0.00% |
| Bun call | `writeChecked` 0.67%、`checkScalar` 0.89%、`prepare` 2.35% |
| Bun default | `bindTyped` 3.04%、`writeChecked` 4.00%、`registerPattern` 0.41%、`installType` 0.32%、`checkScalar` 1.22% |
| Bun map | `registerPattern` 0.67%、`callbackTyped` 1.83%、`writeChecked` 0.15%、`checkScalar` 6.91% |
| Bun prepare | `prepare` 0.00%、`prepareProgram` 0.00% |
| Node loop | `typedIteration` 8.20%、`checkScalar` 0.00%、`checkBindingScalar` 0.07%、`installType` 0.00%、GC 3.31% |
| Node call | `writeChecked` 0.87%、`checkScalar` 0.00%、`prepare` 0.66%、GC 3.08% |
| Node default | `bindTyped` 5.51%、`writeChecked` 0.97%、`registerPattern` 2.18%、`installType` 0.30%、`checkScalar` 0.09% |
| Node map | `registerPattern` 3.81%、`callbackTyped` 5.14%、`writeChecked` 1.14%、`checkScalar` 0.00% |
| Node prepare | `prepare` 0.01%、`prepareProgram` 0.00%、GC 3.11% |

既定引数は AssignmentPattern を汎用の `bindTyped` で処理し、親と子のパターンで型情報の参照・登録を行います。`writeChecked` では検査済み束縛を保存・復元します。原始型の比較自体は直接の `typeof` 判定と安全のための予算加算ですが、既定値の適用と束縛の処理にも上記の self 時間が残っています。ただし、それぞれが wall 時間の増加を何 ms 生んだかは、このプロファイルだけでは分かりません。

Node の型付き map は正式比較で譲り回数の p50 が 0 回から 1 回になり、実行時間の p50 は 7.2414 ms から 9.2871 ms になりました。Bun でも 0 回から 1 回です。8 ms の譲り境界をまたいでいるため、Node の差 2.0457 ms を `typeof` 比較だけの費用とは断定できません。

最適化前の実装を採取した pre プロファイルでは、Node loop の `installType` が 22.47%、GC が 23.34% でした。最終版では 0.00%／3.31% です。Bun loop は `installType` 19.64%、`iteration` 19.61%、`cloneObject` 4.19% から、最終版の `typedIteration` 21.66% に処理の所在が変わりました。周回環境のコピーは従来から必要な処理なので、`typedIteration` 全体を今回の追加費用とは扱いません。

Node prepare の pre プロファイルは `prepare` 7.53%／GC 24.18%、最終版は 0.01%／3.11% でした。これは最適化前後の単独採取結果であり、変更前 `05fe359` との AB／BA 比較とは異なります。準備の self 時間が減ったことだけで、正式比較の parse＋準備の p95 増加 +40.5% が解消したとは結論付けません。

推測と未確認事項：上記の差を JIT・GC・OS スケジューリングのどれに帰属させるかは、この時間計測だけでは分かりません。注釈なしの反復中に型判定を加えていないことと、実行時間が全ケースで低下しないことは別に扱います。p50 が低下していなくても p95 の増加を無視せず、追加比較でも差の向きがそろうかを確認します。配列・オブジェクトの注釈は直下の要素数に応じて仕事が増えるため、原始型の 2 割という目安を適用していません。この比較にはブラウザの描画・入力応答、Misskey の実ホスト、旧版の全スクリプトの上限互換性は含まれません。


計測には `scripts/v2-types-benchmark.mjs`、ブラウザーには `scripts/v2-types-browser.mjs`、プロファイルには `scripts/v2-types-profile.mjs` を使います。前二つはビルド済みの変更前・変更後のディレクトリを引数で受け取ります。プロファイルは `bun --cpu-prof` または `node --cpu-prof` で別に採取します。

注釈なしの追加比較では、before／after の引数を逆にし、import 順も逆にしました。loop・call・map・10,000 宣言の 4 条件を同じ 3 プロセス×10 回ウォームアップ＋30 対で測り、各ランタイム 960 記録、失敗・除外 0 でした。次の表では変更前・変更後を元の意味に戻して表示します。単位は ms、各欄は p50 / p95 です。

| 追加比較（注釈なし） | Bun 変更前 | Bun 変更後 | Node 変更前 | Node 変更後 |
|---|---:|---:|---:|---:|
| loop/plain | 11.3620 / 14.1951 | 11.1382 / 14.5759 | 11.4507 / 13.9558 | 11.0523 / 12.9449 |
| call/plain | 40.1441 / 48.6409 | 39.6911 / 49.9978 | 55.6134 / 67.0835 | 55.3521 / 64.9615 |
| map/plain | 7.8509 / 10.2182 | 7.6553 / 10.1689 | 7.2056 / 10.9744 | 7.2544 / 10.9775 |
| prepare10000/plain | 41.8743 / 50.6934 | 41.5253 / 48.7477 | 40.2194 / 66.2748 | 38.9993 / 48.6342 |

Node の 10,000 宣言の p95 は追加比較では 66.275 ms → 48.634 ms となり、正式比較の +40.5% は再現しませんでした。注釈なしの主要実行ケースでも、プロセスごとの中央値の差は両方向に振れています。正式比較を良い数値の追加比較で置き換えず、両方を残します。

ブラウザーは Playwright 1.63.0 の headless Chromium 153.0.8010.12、Firefox 155.0、WebKit 26.6 で、各 3 プロセス×10 回ウォームアップ＋30 対、7 ケースを実行しました。版・ブラウザー・ケースごとに測定 90 回、合計 5,040 記録で出力照合が成功し、失敗・除外は 0 です。実行上限と譲りの設定は Bun／Node と同じです。Firefox と WebKit では記録の時間が整数 ms になっており、短いケースの比率はその影響を受けます。

| ブラウザー | ケース | 変更前 p50 / p95 | 変更後 p50 / p95 |
|---|---|---:|---:|
| chromium | loop/plain | 12.400 / 14.200 | 12.300 / 14.700 |
| chromium | loop/typed | 12.100 / 13.900 | 15.700 / 23.700 |
| chromium | map/plain | 5.700 / 8.200 | 6.000 / 8.700 |
| chromium | map/typed | 5.700 / 8.800 | 7.500 / 10.500 |
| chromium | prepare100/plain | 0.400 / 0.600 | 0.400 / 0.600 |
| chromium | prepare1000/plain | 3.000 / 4.200 | 2.800 / 4.300 |
| chromium | prepare10000/plain | 31.600 / 42.700 | 32.000 / 40.200 |
| firefox | loop/plain | 30.000 / 36.000 | 30.000 / 39.000 |
| firefox | loop/typed | 30.000 / 35.000 | 30.000 / 36.000 |
| firefox | map/plain | 14.000 / 19.000 | 14.000 / 16.000 |
| firefox | map/typed | 14.000 / 18.000 | 17.000 / 20.000 |
| firefox | prepare100/plain | 1.000 / 1.000 | 0.000 / 1.000 |
| firefox | prepare1000/plain | 5.000 / 12.000 | 5.000 / 12.000 |
| firefox | prepare10000/plain | 84.000 / 98.000 | 84.000 / 102.000 |
| webkit | loop/plain | 11.000 / 14.000 | 11.000 / 13.000 |
| webkit | loop/typed | 13.000 / 14.000 | 17.000 / 19.000 |
| webkit | map/plain | 8.000 / 10.000 | 9.000 / 12.000 |
| webkit | map/typed | 9.000 / 14.000 | 11.000 / 14.000 |
| webkit | prepare100/plain | 0.000 / 1.000 | 1.000 / 1.000 |
| webkit | prepare1000/plain | 4.000 / 6.000 | 4.000 / 5.000 |
| webkit | prepare10000/plain | 41.000 / 46.000 | 41.000 / 47.000 |

Chromium・WebKit の型付きループや各ブラウザーの型付き map には、原始型の +20% 目標を超えるケースもあります。ブラウザー内の CPU プロファイルは採っていないため、Bun／Node の self 割合をそのまま当てはめません。

ブラウザーも読み込み順を逆にし、loop/plain・loop/typed・map/plain の 3 ケースを各 3 プロセス×10 回ウォームアップ＋30 対で確認しました。計 2,160 記録で出力照合が成功し、失敗・除外は 0 です。

| 逆順比較 | ケース | 変更前 p50 / p95 | 変更後 p50 / p95 |
|---|---|---:|---:|
| chromium | loop/plain | 12.000 / 14.300 | 12.000 / 14.800 |
| chromium | loop/typed | 11.700 / 14.000 | 15.400 / 23.000 |
| chromium | map/plain | 5.600 / 7.200 | 5.700 / 8.400 |
| firefox | loop/plain | 30.000 / 35.000 | 30.000 / 34.000 |
| firefox | loop/typed | 30.000 / 35.000 | 30.000 / 34.000 |
| firefox | map/plain | 14.000 / 22.000 | 14.000 / 20.000 |
| webkit | loop/plain | 11.000 / 14.000 | 11.000 / 17.000 |
| webkit | loop/typed | 12.000 / 16.000 | 17.000 / 22.000 |
| webkit | map/plain | 8.000 / 11.000 | 9.000 / 11.000 |

WebKit の注釈なし map は、両比較の集計 p50 が 8 → 9 ms でした。一方、逆順比較の各プロセスの中央値は 9 → 8、8 → 10、9 → 9 ms で、差の向きがそろいません。集計値の差を消さずに記録し、この条件で速度低下がないと断定することも避けます。

機能の確認は時間計測と分けています。差分テストは seed 1・17・2027・65537・123456789 で各 100、計 500 プログラムを生成し、TypeScript の意味検査、注釈を除いた JavaScript、注釈あり／なしの v2 の結果を照合しました。意図した言語差がある全 TypeScript プログラムの互換性を主張するテストではありません。

`scripts/v2-types-mutations.mjs` の最終実行では、33 変異がすべて型検査を通った後、対象の意味検査 1 件で検出されました。復元後も 33 件が成功し、生存・無効・除外は 0 です。初期値・代入・引数・戻り値、浅い検査、分割束縛、既定値、標準関数の引数数、未宣言の候補、fallthrough、void、アロー戻り値型、注釈有無の準備、別 Interpreter の共有 AST と callback を対象にしています。typeof の未宣言識別子、静的計算キーの rest、配列の length、不足した分割束縛、欠如プロパティの診断文、真のリテラルのループも対象です。途中の計測器ではテスト名の選択が重複する試行と、Vitest の区切り文字を誤って選択数が 0 になる試行が各 1 件あり、無効として残した後に選択方法を直して全件を再実行しました。

## 標準ライブラリ

関数の名前、所属、引数の名前と型、戻り値の型、日本語と英語の 1 行説明、実装は `src/v2/stdlib/` の単一定義に置きます。実行表と一覧 JSON は同じ定義から作り、一覧は `toneriko-script/v2/stdlib/catalog.json` で公開します。型は「型注釈」の 6 種類を使い、省略可能・可変長は別の項目で表します。引数の実行時検査は標準関数の責任とし、型注釈の検査とは分けます。定数も単一定義から実行表と一覧を作り、一覧では kind を constant、args を空配列、returns を値の型にします。

標準関数は評価フレームを使い、利用者の関数呼び出しと実行予算・中止状態・書記素キャッシュを共有します。反復処理の途中でチェックポイントを通し、ホストへの譲りと実行上限の確認を行います。

標準関数から呼ぶ短い関数は、引数の準備を含めて最大 32 ステップの同期評価に収まる場合、評価フレームを作らずに実行します。ステップ数・エラー位置・呼び出し深さは通常の呼び出しと同じです。引数の環境は呼び出しごとに作り、閉包や引数への代入を共有しません。中断する処理や長い本体は評価フレームで順に待ちます。

### JavaScript の標準から入れるもの

JavaScript と同じ名前、同じ引数、同じ結果にします(文字列は書記素の単位)。

| 分類 | 入れるもの |
|---|---|
| 値 | `NaN`、`Infinity`、`Math`(全部)、`JSON.parse`/`stringify`、`Number()`、`String()`、`parseInt`、`parseFloat`、`Number.isInteger`、`Array.isArray`、`Array.from`、`Object.keys`/`values`/`entries`/`fromEntries`/`groupBy`、`structuredClone`、`encodeURIComponent`、`decodeURIComponent` |
| 配列 | `length`、`push pop shift unshift slice splice concat join indexOf includes find findIndex filter map flatMap flat reduce some every forEach sort reverse toSorted toReversed at fill entries` |
| 文字列 | `length`、`slice substring at indexOf includes startsWith endsWith padStart padEnd trim toUpperCase toLowerCase split replace replaceAll repeat` |
| 数 | `toFixed`、`toString(radix)` |
| 時間 | `Date.now()`、`setTimeout`、`setInterval`、`clearTimeout`、`clearInterval` |
| 出力 | `console.log`(今の `<:` と `print`) |
| エラー | `new Error(message)`、`error.message` |

`replace` は JavaScript と同じく最初の 1 つだけを置き換えます。今の `replace` は全部を置き換えるので、`replaceAll` を使うよう書き換えが要ります。`str.to_num()` の誤り(`"3.14"` を 3 にする)は、`Number()` と `parseFloat` を JavaScript と同じにすることで無くなります。

### 他の言語の書きやすさから足すもの

利用者が自作していた補助関数(公開されている Play とプラグイン、14 アカウント 33 本)と、本家の要望を根拠にしています。JavaScript に無い名前なので、JavaScript として書いたコードとはぶつかりません。

| 足すもの | 元にした言語 | 自作していた人/本 |
|---|---|---|
| `Date.format(t, "YYYY-MM-DD HH:mm", offset?)`、`Date.parts(t, offset?)`(年月日・時分秒・曜日) | Python `strftime` | 4/4 |
| `arr.shuffle(rng?)`、`arr.sample(rng?)`、`arr.sampleBy(weight, rng?)` | Python `random`、Ruby `sample` | 3/5、重みは 2/2 |
| `arr.sortBy(key)` | Python `sorted(key=)`、Kotlin `sortedBy` | 2/3 |
| `arr.unique()`、`arr.uniqueBy(key)` | Kotlin `distinct`、lodash `uniq` | 2/3 |
| `arr.sum()`、`arr.minBy(key)`、`arr.maxBy(key)` | Python `sum`、Kotlin `minBy` | 2/2、1/1 |
| `arr.countBy(key)` | Kotlin `eachCount`、lodash | 1/2 |
| `arr.mapConcurrent(f, limit?)` | | (並行の節) |
| `deepEqual(a, b)` | Node `isDeepStrictEqual` | 2/2 |
| `range(start, end, step?)`(終わりを含まない) | Python `range` | (今の `Core:range`) |
| `sleep(ms)` | Python `time.sleep`、Kotlin `delay` | (今の `Core:sleep`) |
| `Math.randomInt(min, max)`、`Math.seededRandom(seed)` | Python `randint`、`Random(seed)` | (今の `Math:rnd`、`Math:gen_rng`) |
| `Math.clamp(x, min, max)` | Kotlin `coerceIn` | (比較のみ) |
| `str.dedent()` | Python `textwrap.dedent` | (本家 #637) |

- `key` は値を返す関数です。値は数か文字列です。配列を返すと、前の要素から順に比べます(`u => [u.age, u.name]`)。
- `rng` は `Math.seededRandom(seed)` が返す関数です。同じ種なら同じ結果になります(日替わりのおみくじなど)。
- `sortBy` と `shuffle` は、`sort` と同じく元の配列を並べ替えます。
- グループ分けは JavaScript の `Object.groupBy` を、深いコピーは `structuredClone` を使います。

### 乱数と数値関数

`Math` の公開名は Node 24.19.0 の一覧で固定し、`f16round` と 8 個の定数も含めます。ホストに追加された名前は自動で公開しません。名前空間のメンバーは列挙せず、Math の定数への代入・削除はエラーです。NaN と Infinity はグローバルの定数として公開します。数のメソッドは `toFixed` と `toString(radix)` です。URI の変換失敗は `URIError`、数値の範囲外は `RangeError` とし、診断コードと日英の説明を付けます。

`Math.seededRandom(seed)` は xoshiro128** を使い、版や実行環境が変わっても同じ種の列を変えません。種は有限の数か文字列です。数は型 byte 0 と little-endian binary64、文字列は型 byte 1 と little-endian UTF-16 コード単位です。文字列は正規化せず、数の -0 も区別します。文字列の符号化とハッシュは UTF-16 符号単位ごとに 1 ステップを計上し、64 単位ごとにホストへ譲る判定を行います。

初期状態の 4 ワードは、番号 byte 0〜3 をそれぞれ種の byte 列の先頭に付け、FNV-1a（初期値 0x811c9dc5、素数 0x01000193、32 bit 桁あふれ）で作ります。全ワードが 0 の場合は先頭を 1 にします。xoshiro128** の rotate は出力側 7、状態側 11、shift は 9、出力乗数は 5 と 9 です。乱数一つは連続した出力 a,b から `((a >>> 5) * 2^26 + (b >>> 6)) / 2^53` として作り、範囲は [0,1) です。9 種の先頭 32 個と 4096 個の列の SHA-256 をテストで固定します。

`Math.randomInt(min,max)` は両端を含む安全整数を返し、逆順や安全に扱えない幅はエラーです。`Math.clamp(x,min,max)` は範囲に収め、逆順はエラーです。明示的な Number/String の変換は基本値を受け、配列・オブジェクト・関数はエラーにします。

### 文字列の操作

`substring` は書記素単位で、負数を 0 に丸め、start と end が逆なら入れ替えます。検索・接頭辞・接尾辞・区切り文字・置換は、UTF-16 では一致しても書記素の境界では一致せず結果が異なる場合に `STRING_GRAPHEME_MATCH` エラーにします。`includes` は後方に境界での一致があれば true を返します。`indexOf` と `replace` は最初の UTF-16 の一致が途中ならエラーです。`split` は limit に達したら検索を終え、limit=0 では検索しません。結果が決まった後の一致は調べません。CRLF は `replaceAll("\r\n", "\n")` でそろえ、結合文字は基底文字と合わせた書記素全体を指定するよう案内します。位置を取る引数と置換関数へ渡す位置も書記素数です。空の検索文字列は各書記素の境界に一致します。影響する操作は `split("")`、`replaceAll("", replacement)`、`indexOf("", position)` と位置を持つ置換コールバックです。`replace("", replacement)` は位置 0 だけを置換し、`includes("")`・`startsWith("")`・`endsWith("")` は true で JavaScript と同じです。空入力の `split("")` は空配列です。`replace` は最初の一件、`replaceAll` は全件を置き換え、JavaScript の置換記号を扱います。

書記素の準備は実行内のキャッシュを共有し、CRLF のない ASCII は直接添字を使います。文字列の反復子は開始時の分割結果を保持し、反復中にキャッシュから消えても全文を分割し直しません。for…of、Array.from、Object.groupBy、Object.keys/values/entries はこの形で読みます。書記素境界の表と書記素位置から UTF-16 位置への対応は文字列ごとに一度準備して GraphemeCache に保持します。検索は元の文字列と UTF-16 の KMP を使い、開始位置から結果が決まるまでの長さと検索文字列の長さに対して線形に処理し、処理の途中で評価器へ制御を返します。連結境界によって書記素が結合した場合は、padding の指定長と結果の書記素数が異なることがあります。単一の巨大書記素の Intl.Segmenter 内部は中断できません。

`dedent` は空白だけの行を共通字下げの計算から除き、残る行の共通の行頭空白・タブ列を取り除きます。タブを空白へ展開しません。

### 配列と反復子

配列のメソッドは JavaScript の引数・戻り値・元配列の変更を基準にします。コールバックは値・添字・元配列を受け、順に完了を待ちます。`this` は使えないため、非 null の `thisArg` はエラーです。関数が配列を変更する場合の長さの取り方も各 JavaScript メソッドに合わせ、穴を作る結果はエラーです。

`Array.from` は配列、書記素単位の文字列、内部反復子、`{ length: n }` と添字のプロパティを持つスクリプトの普通のオブジェクトを受けます。ホストの Set/Map や反復可能なクラス、ホストから渡された配列状オブジェクトは NOT_ITERABLE エラーにします。第 2 引数の関数には値と添字を渡して順に待ちます。存在しない要素は null になります。

`entries()` は配列の現在の長さを参照する内部反復子を返します。`next()` の結果は原型なしの `{ value, done }`、value は `[添字, 要素]` です。完了後の value は null です。`for…of`、スプレッド、`Array.from` でも使えます。配列の分割代入はパターンの要素数だけ反復子を進め、残余要素があるときだけ最後まで読みます。Symbol と利用者が作るジェネレーターは公開しません。

スクリプトの配列の shift/unshift は JavaScript の配列操作で移動し、要素数に比例するステップを計上しません。ホストの配列はプロパティ検査を通して扱います。

### 並べ替えと配列の補助関数

`sort` と `sortBy` は安定なマージソートで元の配列を変更して返します。`toSorted` は新しい配列を返します。比較関数の呼び出しは順に待ち、比較結果の NaN は同値として扱います。比較関数を省いた場合は文字列だけを許し、UTF-16 の辞書順で比べます。文字列以外を含む場合は比較関数か sortBy を案内するエラーです。コピーと書き戻し、長い共通接頭辞の比較にも処理を譲る地点を設けます。

`sortBy` は元の添字順にキーを一度ずつ取得します。キーは数・文字列・それらの配列で、配列は辞書式に比較します。同じ位置で型が混在する場合と NaN はエラーです。`uniqueBy`、`minBy`、`maxBy` も同じキーの規則です。配列キーは添字の own data property を読み、原型の値や getter は使いません。

`unique` は SameValueZero（NaN は同値、±0 は同値、オブジェクトは参照の同一性）で最初の要素を残す新配列を返します。`sum` は数を左から加算し、空配列は 0 です。`minBy` と `maxBy` は同値なら最初の要素を返し、空配列は null です。`countBy` は数・文字列・真偽値のキーを文字列化して原型なしの辞書に集計します。配列キーは辞書のキーへ無損失に変換できないのでエラーです。

`shuffle` は Fisher–Yates で元の配列を並べ替えます。`sample` と `sampleBy` は要素を一つ返し、空配列は null です。sampleBy は重みを順に一度ずつ取り、有限の非負数を受けます。非空配列で全重みが 0 ならエラーです。rng の出力は有限の [0,1) に限ります。

### JSON と辞書、複製

標準関数が作る辞書は原型を持ちません。`__proto__` はどの深さでも禁止し、JSON.parse、Object.fromEntries、Object.groupBy、structuredClone でも診断コードと日英の説明を付けて拒否します。入力を黙って削除・変更しません。JSON.stringify でそのキーを除いて作り直すか、送信元へキーの変更を依頼するよう案内します。

JSON.parse は reviver を子から順に呼びます。基本値には原文の source を第 3 引数で渡します。null を返した場合は JSON の null とし、削除指示にはしません。JSON.stringify は replacer・space・toJSON を扱い、関数は辞書のプロパティなら省略、配列内なら null、最上位なら null を返します。循環は TypeError です。利用者の関数は逐次呼び、元のキー順や数の表現は JavaScript に合わせます。replacer 配列は開始時の長さで添字を読み、Symbol.iterator や原型の添字 getter は呼びません。

structuredClone は共有参照と循環を保存し、関数は DataCloneError です。未対応の型と transfer 指定はエラーです。deepEqual は基本値を Object.is 相当で比べ、配列の順序・辞書の own key と内容を比較します。循環を扱い、関数は参照の同一性で比べます。エラーは通常の辞書と区別し、name と message に加えて、own cause の有無と値も比較します。cause は非列挙でも対象とし、入れ子と循環を扱います。ホストのクラスのインスタンスは原型が同じときだけ等しくなりえます。

Object.groupBy のキーには数・文字列・真偽値を受け、真偽値は "true" / "false" にします。countBy も同じ文字列化を行います。

Error の生成も標準関数の単一定義に含めます。new Error だけが new で呼べ、既存の例外値の原型・非公開プロパティの規則を守ります。

### 時刻とホストとの接続

Date.format と Date.parts の時刻は Unix epoch からのミリ秒、offset は UTC より東を正とする分です。省略時はホストの dateOffsetMinutes、それも無ければその時刻 t の実行環境の `-new Date(t).getTimezoneOffset()` を使います。明示した offset は固定の時差です。Date.parts は原型なしの year/month/day/hour/minute/second/millisecond/weekday を返します。月は 1〜12、曜日は日曜 0〜土曜 6 です。

Date.format の記号は YYYY/MM/DD/HH/mm/ss/SSS/d/ddd/dddd/Z/ZZ です。ddd/dddd は固定英語曜日、Z/ZZ は +09:00/+0900 の形、[文字列] はリテラルです。未知の英字記号と閉じていないリテラル、無効な時刻は RangeError です。

console.log は値を文字列化せず、可変長引数を readonly Value[] としてホストの onConsoleLog へ一度渡します。オブジェクトは参照を渡し、スナップショットにはしません。未指定ならホストの console.log に渡します。

setTimeout/setInterval は本体の exec() が解決した後も動きます。数値 ID で管理し、両方の clear 関数で解除できます。clearTimeout/clearInterval の引数省略と null は何もせず null を返します。interval は前回の関数が待機中でも次を開始できます。コールバックごとに新しいステップ予算を使い、その中で呼ぶ配列メソッドは同じ予算を共有します。連続稼働時間はインタプリタ全体で共有します。未捕捉例外は onUnhandledError、未指定ならホストの console.error に通知します。実行上限超過と abort() はタイマーをすべて解除し、実行中と待機中のスクリプトを停止します。ホスト側の外部処理を取り消す場合は AbortSignal に従う必要があります。

sleep は有限の非負ミリ秒を待ちます。range は start/end/step に安全整数を受け、step の省略値は 1、0 はエラー、終端は含みません。方向が合わなければ空配列です。

mapConcurrent の既定 limit は 4 で、正の安全整数を受けます。開始順と結果の順序は添字順です。最初の失敗を観測すると新規の開始を止め、開始済みの処理を待って最初のエラーを返します。開始済みの副作用は取り消しません。全ワーカーが親の実行予算を共有します。

### 関数を呼ぶ順

配列のメソッドは、すべて関数を 1 つずつ順に呼びます。今は `map`、`flat_map`、`sort` だけが並行に呼ぶので、関数の中で待つと終わる順が入れ替わります(`[1, 2, 3]` の `map` で `[2, 3, 1]`)。並行に呼びたいときは `arr.mapConcurrent(f, limit?)` を使います。`limit` は同時に動かす数の上限で、`Mk.api` をまとめて呼ぶときに、同時に送る数を抑えられます。

順に呼ぶことで、利用者の関数を呼ぶ巨大な `map` や `sort` の中でも、ホストに処理を譲れるようになります。今は並行に呼んだ関数の処理が続くので、譲ってもブラウザが空きません(100 万件の `sort` で約 3 秒止まる)。

### 関数の一覧

toneriko-script は、標準の関数とメソッドの一覧(名前、引数、戻り値の型、1 行の説明)を JSON で書き出します。Misskey も、渡す関数の一覧を同じ形で持ちます。エディタは、この一覧で補完と引数の説明を出します。型の推論はしないので、`.` の後には、名前空間(`Mk.`、`Math.` など)ならその関数を、それ以外なら配列と文字列のメソッドを、打った文字で絞って出します。

## Misskey が渡す関数

`:` の名前空間を、オブジェクトのプロパティに置き換えます。

| 今 | 2 |
|---|---|
| `Mk:api`、`Mk:dialog`、`Mk:confirm`、`Mk:toast`、`Mk:save`、`Mk:load`、`Mk:remove`、`Mk:url`、`Mk:nyaize` | `Mk.api` など(同じ名前) |
| `USER_ID`、`USER_NAME`、`USER_USERNAME` | `Mk.me.id`、`Mk.me.name`、`Mk.me.username` |
| `SERVER_URL`、`LOCALE`、`CUSTOM_EMOJIS` | `Mk.server.url`、`Mk.locale`、`Mk.customEmojis` |
| `Ui:render`、`Ui:get`、`Ui:root` | `Ui.render`、`Ui.get`、`Ui.root` |
| `Ui:C:button` などの部品 | `Ui.button` など(`C` を省く) |
| `THIS_ID`、`THIS_URL`(Play) | `Play.id`、`Play.url` |
| `Plugin:register:note_action` など | `Plugin.registerNoteAction` など |
| `Plugin:config` | `Plugin.config` |
| `### { name: … }`(プラグインの情報) | `export const meta = { name: … }` |

サーバーへの要求が失敗したとき、今の `Mk:api` はエラーの値を返します。2 では例外を投げ、`try`/`catch` で受けます。

## AiScript の書き方への案内

AiScript の書き方で書いたときは、構文エラーで 2 の書き方を案内します。

| AiScript | 案内 |
|---|---|
| 1 行目の `/// @ 1.x.x` | AiScript の構文のスクリプトです。Toneriko Script 2 では動かないので、書き直しが要ります |
| `<: x` | `console.log(x)` |
| `@f(x) { … }`、`@(x) { … }` | `function f(x) { … }`、`(x) => { … }` |
| `Core:sleep(1)`、`Mk:api(…)` | `sleep(1)`、`Mk.api(…)` |
| `each let x, arr` | `for (const x of arr)` |
| `for let i, 10` | `for (let i = 0; i < 10; i++)` |
| `eval { … }` | 関数にまとめる |
| `match x { case … }` | `switch` |
| `if a b else c`(式として) | `a ? b : c` |
| `x ^ 2` | `x ** 2` |

AiScript の `let` は再代入できない変数なので、そのまま動きます(2 では `const` にあたる書き方ですが、`let` でも誤りにはなりません)。

## 実装

- **パーサー:** 部分集合を読むパーサーを自前で書きます。既存のパーサー(acorn など)を使わないのは、使えない書き方を見分けて案内を出す必要があり、エラーの文を自分で決めたいためです。
- **パーサーの差分テスト:** 受け付けたプログラムは、TypeScript のパーサー(`ts.createSourceFile`)でも同じ構文木になることを確かめます。プログラムは fast-check で作ったものと、集めたスクリプトを使います。TypeScript はテストでだけ使い、配る成果物には入れません。
- **実行の差分テスト:** 「意図した違い」に当たらないプログラム(ASCII の文字列だけ、待つ処理なし)は、Node で実行した結果と同じになることを確かめます。方針 1 を、テストで守るためです。
- **インタプリタ:** 今のインタプリタの仕組み(ノードごとに待てる評価、時間で譲る、5 秒の上限)を引き継ぎ、新しい構文木に合わせて書き直します。

## 進める順番

1. **パーサーと構文の検査:** 使える書き方と使えない書き方、案内のエラー、改行の規則、型注釈。TypeScript のパーサーとの差分テスト
2. **インタプリタ:** JavaScript と同じ意味(真偽の判定、`===`、`+`、オブジェクトのキーの順、クロージャ、巻き上げ、宣言前の使用、例外、`switch`、ラベル)と意図した違い。Node との差分テスト
3. **標準ライブラリ:** JavaScript から入れるものと足すもの、関数の一覧の JSON
4. **型注釈と実行前の検査**
5. **Misskey:** 渡す関数の改名と一覧、Play の雛形とテストの書き直し、エディタの補完、AiScript の構文のエラー表示
6. **リリース:** toneriko-script 2.0.0 を出し、Misskey の依存を上げる

## 決めていないこと

- **`Map` と `Set`:** 軽く保つために入れていません。任意の値をキーにしたい要望(本家 #225)はあるので、使われ方を見て決めます。

## 根拠にした調べもの

- 本家 AiScript の issue と PR(1,000 件)、Misskey の issue(196 件)、Zenn・Qiita・note・個人ブログでの利用者の声
- 公開されている Play とプラグインのソース(GitHub の 35 リポジトリ、Qiita の関数集)と、本家の issue 363 件と PR 320 件の採否
- 構文の使いやすさの研究(Stefik & Siebert 2013、Altadmri & Brown 2015、Shrestha ら 2018、Torres ら 2023、Santos & Becker 2024 など)と、組み込み言語の評判(Luau、GDScript、Lua、Apps Script、MakeCode など)
- 汎用の言語の設計資料(PEP、Swift Evolution、Rust の RFC、TC39 の提案)と開発者調査(Stack Overflow 2025、State of JS 2024、Go の開発者調査)

人数は、集めた資料の中で同じ点に触れた別々の人の数で、利用者全体での割合ではありません。

### 配列の先頭操作とホスト境界

`shift` と `unshift` はモジュール読み込み時に保存した Array.prototype の関数を使います。受け手の同名プロパティは再参照しません。`unshift` は引数を末尾側から最大 4096 個ずつ挿入し、追加する要素ごとにステップを数えます。

スクリプトが作った配列は accessor と穴を持たないため、常に高速な経路を使います。ホストの配列は先頭操作で初めて使うときに原型が Array.prototype であること、各添字が own data property であること、値が対応する型であることを検査します。accessor は呼ばず ACCESSOR_PROPERTY、穴は SPARSE_ARRAY として拒否します。Array の派生クラスなど異なる原型の配列は、高速な経路を使わず PropertyAccess で添字を読み書きします。密で変更可能な配列は WeakSet に記録し、ホストの約束に基づいて以後の再検査を省きます。変更できない属性を持つ配列は PropertyAccess を通す既存の経路で扱います。ホスト呼び出し、console.log、待機や譲渡による検査結果の失効はありません。
