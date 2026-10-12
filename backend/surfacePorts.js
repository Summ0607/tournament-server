const SURFACE_PORTS = Object.freeze({
  pre: 3000,
  ringOps: 3001,
  monitoring: 3002,
  medical: 3003,
  adminProgress: 3004,
  post: 3010
});

function resolveSurfaceName(surfaceName = 'pre') {
  const requestedName = String(surfaceName || '').trim();
  if (!requestedName) {
    return 'pre';
  }

  const canonicalName = Object.keys(SURFACE_PORTS).find((name) => name.toLowerCase() === requestedName.toLowerCase());
  if (canonicalName) {
    return canonicalName;
  }

  throw new Error(`Unknown tournament surface "${requestedName}". Expected one of: ${Object.keys(SURFACE_PORTS).join(', ')}`);
}

function resolveSurfacePort(surfaceName = 'pre') {
  return SURFACE_PORTS[resolveSurfaceName(surfaceName)];
}

module.exports = {
  SURFACE_PORTS,
  resolveSurfaceName,
  resolveSurfacePort
};
