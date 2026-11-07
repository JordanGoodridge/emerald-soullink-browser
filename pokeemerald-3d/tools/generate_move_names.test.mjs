import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMoveNameTable,
  parseMoveIds,
  parseMoveNames,
} from './generate_move_names.mjs';

test('parses numeric move IDs', () => {
  const ids = parseMoveIds('#define MOVE_NONE 0\n#define MOVE_POUND 1\n#define MOVE_DOUBLE_SLAP 3');
  assert.equal(ids.get('MOVE_NONE'), 0);
  assert.equal(ids.get('MOVE_POUND'), 1);
  assert.equal(ids.get('MOVE_DOUBLE_SLAP'), 3);
});

test('parses localized move names and joins them by numeric ID', () => {
  const ids = parseMoveIds('#define MOVE_NONE 0\n#define MOVE_POUND 1\n#define MOVE_FIRE_PUNCH 7');
  const names = parseMoveNames(`
    [MOVE_NONE] = _("-"),
    [MOVE_POUND] = _("POUND"),
    [MOVE_FIRE_PUNCH] = _("FIRE PUNCH"),
  `);
  assert.deepEqual(buildMoveNameTable(ids, names), {
    0: '-',
    1: 'POUND',
    7: 'FIRE PUNCH',
  });
});

test('does not require duplicate aliases in the source text', () => {
  const ids = new Map([['MOVE_POUND', 1], ['MOVE_FIRE_PUNCH', 7]]);
  const names = new Map([['MOVE_POUND', 'POUND']]);
  assert.deepEqual(buildMoveNameTable(ids, names), { 1: 'POUND' });
});
