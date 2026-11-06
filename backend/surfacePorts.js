const SURFACE_PORTS = Object.freeze({
  pre: 3443,
  ringOps: 3444,
  monitoring: 3445,
  medical: 3446,
  adminProgress: 3447,
  post: 3453
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
