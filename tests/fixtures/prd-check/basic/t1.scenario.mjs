// Fixture scenario: fails on demand so the tests can check how a broken scenario is reported.
import assert from 'node:assert/strict';
import { it } from 'node:test';

it('[T-1] scenario', () => {
  assert.notEqual(process.env.FIXTURE_T1, 'fail', '第2步（取结果）：没取到');
});
