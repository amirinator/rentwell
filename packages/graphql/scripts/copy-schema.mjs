// Copies the SDL next to the compiled output so the API can read it at runtime
// from a single location whether it runs from source or from dist.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, '..', 'schema');
const to = join(here, '..', 'dist', 'schema');

mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`copied SDL to ${to}`);
