const assert = require('node:assert/strict');
const { test } = require('node:test');
const { SURFACE_PORTS, resolveSurfaceName, resolveSurfacePort } = require('../backend/surfacePorts');

test('surface ports resolve by name and default to pre', () => {
  assert.equal(resolveSurfaceName(), 'pre');
  assert.equal(resolveSurfacePort(), 3443);
  assert.equal(resolveSurfaceName('ringOps'), 'ringOps');
  assert.equal(resolveSurfacePort('ringOps'), 3444);
  assert.equal(resolveSurfacePort('MONITORING'), 3445);
  assert.equal(resolveSurfacePort('adminProgress'), 3447);
  assert.deepEqual(SURFACE_PORTS, {
    pre: 3443,
    ringOps: 3444,
    monitoring: 3445,
    medical: 3446,
    adminProgress: 3447,
    post: 3453
  });
});

test('surface port resolution rejects unknown names', () => {
  assert.throws(() => resolveSurfaceName('unknown'), /Unknown tournament surface/);
  assert.throws(() => resolveSurfacePort('unknown'), /Unknown tournament surface/);
});
