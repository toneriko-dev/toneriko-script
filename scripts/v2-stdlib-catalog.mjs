import { writeFile } from 'node:fs/promises';
import { catalog } from '../built/v2/stdlib/index.js';

await writeFile(new URL('../built/v2/stdlib/catalog.json', import.meta.url), `${JSON.stringify(catalog, null, 2)}\n`);
const imported = await import('toneriko-script/v2/stdlib/catalog.json', { with: { type: 'json' } });
if (JSON.stringify(imported.default) !== JSON.stringify(catalog)) throw new Error('Standard catalog package export mismatch');
