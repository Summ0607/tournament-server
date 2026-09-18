function normalizeAge(competitor) {
  if (Number.isFinite(Number(competitor.age))) {
    return Number(competitor.age);
  }

  const dobValue = competitor.dob || competitor.dobIso || competitor.dateOfBirth;
  if (!dobValue) return 0;

  const dob = new Date(dobValue);
  if (Number.isNaN(dob.getTime())) return 0;

  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const monthDiff = now.getMonth() - dob.getMonth();
  const dayDiff = now.getDate() - dob.getDate();

  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) {
    age -= 1;
  }

  return age;
}

function buildGroups(competitors, params = {}) {
  if (Array.isArray(params.groups) && params.groups.length) {
    return params.groups.map((group, index) => ({
      groupId: group.groupId || group.id || `group-${index + 1}`,
      name: group.name || `Group ${index + 1}`,
      competitors: Array.isArray(group.competitors) ? group.competitors : []
    }));
  }

  const list = Array.isArray(competitors) ? competitors : [];
  if (!list.length) return [];

  const maxGroupSize = Number(params.maxGroupSize ?? params.maxSize ?? 6);
  const minGroupSize = Number(params.minGroupSize ?? params.minSize ?? 4);

  const normalized = list.map((competitor, index) => ({
    ...competitor,
    id: competitor.id ?? competitor.competitorId ?? `competitor-${index + 1}`,
    age: normalizeAge(competitor),
    firstName: competitor.firstName || '',
    lastName: competitor.lastName || '',
    fullName: [competitor.firstName, competitor.lastName].filter(Boolean).join(' ') || `Competitor ${index + 1}`,
    gender: String(competitor.gender || 'Unknown').trim() || 'Unknown'
  }));

  const buckets = {
    Male: [],
    Female: [],
    Unknown: []
  };

  for (const competitor of normalized) {
    const key = competitor.gender === 'Male' || competitor.gender === 'Female' ? competitor.gender : 'Unknown';
    buckets[key].push(competitor);
  }

  const groups = [];
  for (const gender of Object.keys(buckets)) {
    const bucket = buckets[gender].sort((a, b) => {
      if (a.age !== b.age) return a.age - b.age;
      return a.fullName.localeCompare(b.fullName);
    });

    for (let i = 0; i < bucket.length; i += maxGroupSize) {
      const chunk = bucket.slice(i, i + maxGroupSize);
      if (!chunk.length) continue;

      const groupId = `group-${groups.length + 1}`;
      groups.push({
        groupId,
        name: `${gender} Group ${groups.length + 1}`,
        competitors: chunk,
        minGroupSize,
        maxGroupSize,
        gender
      });
    }
  }

  return groups;
}

module.exports = { buildGroups };
