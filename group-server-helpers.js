function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  const safeFallback = Number.isInteger(fallback) ? fallback : 0;
  const safeMin = Number.isInteger(min) ? min : Number.MIN_SAFE_INTEGER;
  const safeMax = Number.isInteger(max) ? max : Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(parsed)) {
    return Math.max(safeMin, Math.min(safeMax, safeFallback));
  }
  return Math.max(safeMin, Math.min(safeMax, parsed));
}

function buildRingId(letter, number) {
  return `ring-${String(letter || '').trim().toLowerCase()}-${String(number || '').trim()}`;
}

function buildRingLabel(letter, number) {
  return `${letter}${number}`;
}

module.exports = {
  clampInt,
  buildRingId,
  buildRingLabel
};
