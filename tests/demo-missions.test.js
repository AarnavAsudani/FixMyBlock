import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDemoMission } from '../services/demo-missions.js';

test('only the exact starter missions are removed; user plans survive', () => {
  const starter = { id: 'M-1042', neighborhood: 'Maplewood East', coverage: 2.4, altitude: 90, createdAt: 'Today, 9:12 AM' };
  assert.equal(isDemoMission(starter), true);
  assert.equal(isDemoMission({ ...starter, id: 'M-1046' }), false);
  assert.equal(isDemoMission({ ...starter, createdAt: 'Just now' }), false);
  assert.equal(isDemoMission({ ...starter, neighborhood: 'My area' }), false);
  assert.equal(isDemoMission({ ...starter, coverage: 5 }), false);
  assert.equal(isDemoMission({ id: 'custom', neighborhood: 'Riverside' }), false);
});
