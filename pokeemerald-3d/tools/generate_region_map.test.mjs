import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const game = fileURLToPath(new URL('..', import.meta.url));

test('region map generator emits all sections and the canonical grid', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'emerald-region-map-'));
  const output = join(temp, 'region-map.json');
  try {
    const result = spawnSync(process.execPath, [join(game, 'tools', 'generate_region_map.mjs'), `--output=${output}`], {
      cwd: game,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(data.sections.length, 213);
    assert.equal(data.sections.filter((section) => section.x !== null).length, 95);
    assert.equal(data.dimensions.columns, 28);
    assert.equal(data.dimensions.rows, 15);
    assert.equal(data.layout.length, 15);
    assert.ok(data.layout.every((row) => row.length === 28));
    assert.ok(data.sections.some((section) => section.key === 'MAPSEC_ROUTE_101'));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
