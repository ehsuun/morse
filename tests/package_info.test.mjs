import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageInfo, packageVersion } from '../package_info.mjs';

test('packageInfo reads package metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'morse-package-'));
  const path = join(dir, 'package.json');
  try {
    writeFileSync(path, '{"name":"morse","version":"1.2.3"}\n');
    assert.deepEqual(packageInfo(path), { name: 'morse', version: '1.2.3' });
    assert.equal(packageVersion(path), '1.2.3');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
