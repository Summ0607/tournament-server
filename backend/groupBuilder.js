const { assignDivisionNumbers } = require('./groupDivisionAssignments');

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

function isTtldRank(rank) {
  return String(rank || '').trim().toUpperCase() === 'TTLD';
}

function rankBandKey(rank) {
  const value = String(rank || '').trim().toUpperCase();
  if (value === 'TTLD') return 'ttld';
  if (value === 'G10' || value === 'G9' || value === 'G8' || value === 'G7' || value === 'G6') return 'g10-g6';
  if (value === 'G5' || value === 'G4' || value === 'G3') return 'g5-g3';
  if (value === 'G2' || value === 'G1' || value === 'CDB') return 'g2-cdb';
  if (value === 'D1' || value === 'D2' || value === 'D3') return 'd1-d3';
  return 'unknown';
}

function ageBucketFor(competitor) {
  const age = Number(competitor.age);
  if (!Number.isFinite(age)) return 'unknown';
  if (isTtldRank(competitor.rank)) return '4-6';
  if (age >= 6 && age <= 9) return '6-9';
  if (age >= 10 && age <= 13) return '10-13';
  if (age >= 14 && age <= 17) return '14-17';
  if (age >= 18 && age <= 35) return '18-35';
  if (age >= 36) return '36+';
  return age < 6 ? '4-6' : 'unknown';
}

function genderKey(value) {
  const gender = String(value || '').trim();
  if (!gender) return 'Unknown';
  if (gender === 'Male' || gender === 'Female' || gender === 'Unknown') return gender;
  return gender;
}

function sortCompetitorsByAgeAndName(list) {
  return [...list].sort((a, b) => {
    if (a.age !== b.age) return a.age - b.age;
    return a.fullName.localeCompare(b.fullName);
  });
}

function splitIntoGroups(list, maxGroupSize) {
  const groups = [];
  let index = 0;

  while (index < list.length) {
    groups.push(list.slice(index, index + maxGroupSize));
    index += maxGroupSize;
  }

  return groups;
}

function splitEvenlyIntoGroups(list, minGroupSize, maxGroupSize) {
  if (!list.length) return [];
  if (list.length <= maxGroupSize) return [list.slice()];

  const groupCount = Math.max(1, Math.ceil(list.length / maxGroupSize));
  const baseSize = Math.floor(list.length / groupCount);
  const remainder = list.length % groupCount;

  const sizes = [];
  for (let i = 0; i < groupCount; i += 1) {
    sizes.push(baseSize + (i < remainder ? 1 : 0));
  }

  if (sizes.some((size) => size < minGroupSize) && list.length >= minGroupSize) {
    return splitIntoGroups(list, maxGroupSize);
  }

  const groups = [];
  let cursor = 0;
  for (const size of sizes) {
    groups.push(list.slice(cursor, cursor + size));
    cursor += size;
  }
  return groups;
}

function buildTtldGroups(ttldCompetitors, maxGroupSize) {
  const sorted = sortCompetitorsByAgeAndName(ttldCompetitors);
  if (!sorted.length) return [];

  const male = sorted.filter((competitor) => genderKey(competitor.gender) === 'Male');
  const female = sorted.filter((competitor) => genderKey(competitor.gender) === 'Female');
  const unknown = sorted.filter((competitor) => genderKey(competitor.gender) !== 'Male' && genderKey(competitor.gender) !== 'Female');
  const canSplitByGender = male.length >= 4 && female.length >= 4;

  if (!canSplitByGender) {
    return [{
      name: 'TTLD Group 1',
      competitors: sorted,
      gender: 'TTLD'
    }];
  }

  const groups = [];
  const buckets = [
    { label: 'Male TTLD', competitors: male },
    { label: 'Female TTLD', competitors: female },
    { label: 'TTLD', competitors: unknown }
  ];

  for (const bucket of buckets) {
    const chunks = splitEvenlyIntoGroups(bucket.competitors, 4, maxGroupSize);
    for (const [index, chunk] of chunks.entries()) {
      groups.push({
        name: `${bucket.label} Group ${index + 1}`,
        competitors: chunk,
        gender: bucket.label
      });
    }
  }

  return groups;
}

function buildRankBandGroups(competitors, maxGroupSize, minGroupSize) {
  const genders = ['Male', 'Female', 'Unknown'];
  const rankOrder = ['g10-g6', 'g5-g3', 'g2-cdb', 'd1-d3'];
  const ageOrder = ['6-9', '10-13', '14-17', '18-35', '36+'];
  const groups = [];
  const bandLabel = {
    'g10-g6': 'G10-G6',
    'g5-g3': 'G5-G3',
    'g2-cdb': 'G2-CDB',
    'd1-d3': 'D1-D3'
  };

  for (const gender of genders) {
    const genderCompetitors = competitors.filter((competitor) => genderKey(competitor.gender) === gender);
    if (!genderCompetitors.length) continue;

    for (const band of rankOrder) {
      const bandCompetitors = genderCompetitors.filter((competitor) => rankBandKey(competitor.rank) === band);
      if (!bandCompetitors.length) continue;

      const orderedSegments = [];
      for (const ageBucket of ageOrder) {
        const segment = sortCompetitorsByAgeAndName(
          bandCompetitors.filter((competitor) => ageBucketFor(competitor) === ageBucket)
        );
        if (segment.length) {
          orderedSegments.push({ ageBucket, competitors: segment });
        }
      }

      const tail = bandCompetitors.filter((competitor) => !ageOrder.includes(ageBucketFor(competitor)));
      if (tail.length) {
        orderedSegments.push({ ageBucket: 'unknown', competitors: sortCompetitorsByAgeAndName(tail) });
      }

      let groupIndex = 1;
      for (let i = 0; i < orderedSegments.length; i += 1) {
        const segment = orderedSegments[i];
        let combined = [...segment.competitors];
        let j = i + 1;

        while (combined.length < minGroupSize && j < orderedSegments.length) {
          const candidate = orderedSegments[j];
          if (combined.length + candidate.competitors.length > maxGroupSize) {
            break;
          }
          combined = combined.concat(candidate.competitors);
          j += 1;
        }

        i = j - 1;

        const chunks = splitIntoGroups(combined, maxGroupSize);
        for (const chunk of chunks) {
          groups.push({
            name: `${gender} ${bandLabel[band]} Group ${groupIndex}`,
            competitors: chunk,
            gender,
            rankBand: band,
            ageBucket: segment.ageBucket
          });
          groupIndex += 1;
        }
      }
    }
  }

  return groups;
}

function buildGroups(competitors, params = {}) {
  // If explicit groups were passed in, trust them as-is
  if (Array.isArray(params.groups) && params.groups.length) {
    return assignDivisionNumbers(
      params.groups.map((group) => ({
        groupId: String(group.groupId),
        name: group.name,
        competitors: Array.isArray(group.competitors) ? group.competitors : []
      })),
      params.startingDivisionNumber ?? 20
    );
  }

  const list = Array.isArray(competitors) ? competitors : [];
  if (!list.length) return [];

  const maxGroupSize = Number(params.maxGroupSize ?? params.maxSize ?? 6);
  const minGroupSize = Number(params.minGroupSize ?? params.minSize ?? 4);

  // Competitors are already normalized by CSV ingestion + GroupContract
  const normalized = list;

  // ---------------------------------------------------------
  // From here down, KEEP your existing grouping logic exactly:
  // ---------------------------------------------------------

  // 1. TTLD extraction
  const ttld = normalized.filter(c => c.age < 7);

  // 2. Special needs extraction
  const specialNeeds = normalized.filter(c =>
    String(c.specialNeeds || '').trim().toUpperCase() === 'YES'
  );

  // 3. Remove TTLD + special needs from main list
  const remaining = normalized.filter(c =>
    c.age >= 7 &&
    String(c.specialNeeds || '').trim().toUpperCase() !== 'YES'
  );

  // 4. Build TTLD groups (your existing logic)
  const ttldGroups = buildTTLDGroups(ttld, params);


  // 5. Build special needs groups (your existing logic)
  const specialGroups = buildSpecialNeedsGroups(specialNeeds, params);

  // 6. Build standard groups (your existing logic)
  const standardGroups = buildStandardGroups(remaining, {
    maxGroupSize,
    minGroupSize
  });

  // 7. Combine all groups
  const allGroups = [
    ...ttldGroups,
    ...specialGroups,
    ...standardGroups
  ];

  // 8. Assign division numbers
  return assignDivisionNumbers(allGroups, params.startingDivisionNumber ?? 20);
}

  const buckets = {
    Male: [],
    Female: [],
    Unknown: []
  };

  for (const competitor of normalized) {
    const key = competitor.gender === 'Male' || competitor.gender === 'Female' ? competitor.gender : 'Unknown';
    if (isTtldRank(competitor.rank)) {
      buckets.Unknown.push(competitor);
      continue;
    }
    buckets[key].push(competitor);
  }

  const groups = [];
  const ttldGroups = buildTtldGroups(buckets.Unknown, maxGroupSize);
  let groupCounter = 1;

  for (const group of ttldGroups) {
    groups.push({
      groupId: `group-${groupCounter}`,
      name: group.name || `TTLD Group ${groupCounter}`,
      competitors: group.competitors,
      minGroupSize,
      maxGroupSize,
      gender: group.gender || 'TTLD'
    });
    groupCounter += 1;
  }

  const rankGroups = buildRankBandGroups(
    [...buckets.Male, ...buckets.Female, ...buckets.Unknown],
    maxGroupSize,
    minGroupSize
  );

  for (const group of rankGroups) {
    const groupId = `group-${groupCounter}`;
    groups.push({
      groupId,
      name: group.name,
      competitors: group.competitors,
      minGroupSize,
      maxGroupSize,
      gender: group.gender,
      rankBand: group.rankBand,
      ageBucket: group.ageBucket
    });
    groupCounter += 1;
  }

  return assignDivisionNumbers(groups, params.startingDivisionNumber ?? 20);
}

module.exports = { buildGroups, assignDivisionNumbers };
