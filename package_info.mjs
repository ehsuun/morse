import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_PATH = resolve(HERE, 'package.json');

export function packageInfo(path = PACKAGE_PATH) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

export function packageVersion(path = PACKAGE_PATH) {
  return packageInfo(path).version;
}
