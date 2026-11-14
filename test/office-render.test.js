import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('real Word, PPT and Excel renderer preserves formulas and mobile-preview values', t => {
  const python = process.env.OFFICE_TEST_PYTHON || 'python3';
  const available = spawnSync(python, ['-c', 'import docx, pptx, openpyxl'], { encoding: 'utf8' });
  if (available.status !== 0 && !process.env.OFFICE_TEST_PYTHON) {
    t.skip('Install Python Office libraries or set OFFICE_TEST_PYTHON to run binary renderer tests'); return;
  }
  assert.equal(available.status, 0, available.stderr);
  const result = spawnSync(python, [fileURLToPath(new URL('./office-render.py', import.meta.url))], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
