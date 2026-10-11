const assert = require('node:assert/strict');
const { test } = require('node:test');
const { SURFACE_PORTS, resolveSurfaceName, resolveSurfacePort } = require('../backend/surfacePorts');

test('surface ports resolve by name and default to pre', () => {
  assert.equal(resolveSurfaceName(), 'pre');
  assert.equal(resolveSurfacePort(), 3000);
  assert.equal(resolveSurfaceName('ringOps'), 'ringOps');
  assert.equal(resolveSurfacePort('ringOps'), 3001);
  assert.equal(resolveSurfacePort('MONITORING'), 3002);
  assert.deepEqual(SURFACE_PORTS, {
    pre: 3000,
    ringOps: 3001,
    monitoring: 3002,
    medical: 3003,
    post: 3010
  });
});

test('surface port resolution rejects unknown names', () => {
  assert.throws(() => resolveSurfaceName('unknown'), /Unknown tournament surface/);
  assert.throws(() => resolveSurfacePort('unknown'), /Unknown tournament surface/);
});
