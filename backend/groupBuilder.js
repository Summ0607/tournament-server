const { assignDivisionNumbers, rebalanceGroupsToSoftMax, absorbLoneCdbIntoBlackBelts } = require('./groupDivisionAssignments');

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

function normalizeDemographicGender(value) {
  const gender = String(value || '').trim();
  if (!gender) return 'Unknown';
  if (gender === 'Male' || gender === 'Female' || gender === 'Unknown') return gender;
  const lower = gender.toLowerCase();
  if (lower.startsWith('m')) return 'Male';
  if (lower.startsWith('f')) return 'Female';
  return 'Unknown';
}

function isTtldRank(rank) {
  return String(rank || '').trim().toUpperCase() === 'TTLD';
}

// Canonical Dan ranks above the competing range (D4+) are valid but not eligible to compete.
function isNonCompetingDanRank(rank) {
  const match = /^D(\d{1,2})$/.exec(String(rank || '').trim().toUpperCase());
  return Boolean(match) && Number(match[1]) >= 4;
}

function reviewReasonFor(competitor) {
  const rank = String(competitor && competitor.rank != null ? competitor.rank : '').trim();
  if (!rank) return 'missing rank';
  if (isTtldRank(rank) || rankBandKey(rank) !== 'unknown') return '';
  if (isNonCompetingDanRank(rank)) return 'rank not eligible to compete';
  return 'unrecognized rank';
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

function demographicRankTierFor(rank) {
  const value = String(rank || '').trim().toUpperCase();
  if (!value) return 'unassigned';
  if (value === 'TTLD') return 'TTLD';
  if (value === 'G10' || value === 'G9' || value === 'G8' || value === 'G7' || value === 'G6' || value === 'G5') {
    return 'G10-G5';
  }
  if (value === 'G4' || value === 'G3' || value === 'G2' || value === 'G1' || value === 'CDB') {
    return 'G4-CDB';
  }
  if (/^D\d+$/.test(value)) return 'D1-D3_D4';
  return 'unassigned';
}

function demographicAgeBracketFor(competitor) {
  const age = normalizeAge(competitor);
  if (!Number.isFinite(age)) return 'unassigned';
  if (!Number.isInteger(age)) return 'unassigned';
  if (age < 4 || age > 99) return 'unassigned';
  return String(age);
}

function demographicMacroAgeBracketForAge(age) {
  if (!Number.isFinite(age)) return 'unassigned';
  if (age >= 4 && age <= 9) return '6-9';
  if (age >= 10 && age <= 13) return '10-13';
  if (age >= 14 && age <= 17) return '14-17';
  if (age >= 18 && age <= 35) return '18-35';
  if (age >= 36) return '36+';
  return 'unassigned';
}

function demographicMacroAgeBracketFor(competitor) {
  return demographicMacroAgeBracketForAge(normalizeAge(competitor));
}

function createAgeBracketBucket() {
  return {
    headcount: 0,
    competitors: []
  };
}

const DEMOGRAPHIC_GENDER_ORDER = ['Male', 'Female', 'Unknown'];
const DEMOGRAPHIC_RANK_TIER_ORDER = ['TTLD', 'G10-G5', 'G4-CDB', 'D1-D3_D4', 'unassigned'];
const DEMOGRAPHIC_AGE_BRACKET_ORDER = Array.from({ length: 96 }, (_, index) => String(index + 4)).concat('unassigned');
const DEMOGRAPHIC_MACRO_AGE_BRACKET_ORDER = ['6-9', '10-13', '14-17', '18-35', '36+', 'unassigned'];
const DEMOGRAPHIC_TARGET_GROUP_SIZE = 8;
const DEMOGRAPHIC_SOFT_MIN_GROUP_SIZE = 6;
const DEMOGRAPHIC_SOFT_MAX_GROUP_SIZE = 10;
const DEMOGRAPHIC_HARD_MAX_GROUP_SIZE = 11;
const DEMOGRAPHIC_MIN_GROUP_SIZE = 4;
const DEMOGRAPHIC_LOOKAHEAD_WINDOW = 3;

function createRankTierBucket() {
  const ageBrackets = {};
  for (const ageBracket of DEMOGRAPHIC_AGE_BRACKET_ORDER) {
    ageBrackets[ageBracket] = createAgeBracketBucket();
  }

  return {
    headcount: 0,
    ageBrackets,
    unassigned: createAgeBracketBucket()
  };
}

function createGenderBucket() {
  return {
    headcount: 0,
    rankTiers: {
      TTLD: createRankTierBucket(),
      'G10-G5': createRankTierBucket(),
      'G4-CDB': createRankTierBucket(),
      'D1-D3_D4': createRankTierBucket(),
      unassigned: createRankTierBucket()
    },
    unassigned: createRankTierBucket()
  };
}

function buildDemographicBuckets(competitors) {
  const source = Array.isArray(competitors) ? competitors : [];
  const buckets = {
    headcount: 0,
    genders: {
      Male: createGenderBucket(),
      Female: createGenderBucket(),
      Unknown: createGenderBucket()
    },
    unassigned: {
      headcount: 0,
      competitors: []
    }
  };

  for (const competitor of source) {
    if (!competitor || typeof competitor !== 'object') continue;

    const genderKey = normalizeDemographicGender(competitor.gender);
    const rankTierKey = demographicRankTierFor(competitor.rank);
    const ageBracketKey = demographicAgeBracketFor(competitor);
    const genderBucket = buckets.genders[genderKey] || buckets.genders.Unknown;
    const tierBucket = genderBucket.rankTiers[rankTierKey] || genderBucket.rankTiers.unassigned;
    const ageBucket = tierBucket.ageBrackets[ageBracketKey] || tierBucket.ageBrackets.unassigned;

    buckets.headcount += 1;
    genderBucket.headcount += 1;
    tierBucket.headcount += 1;
    ageBucket.headcount += 1;
    ageBucket.competitors.push(competitor);
  }

  return buckets;
}

function demographicRankTierOrderIndex(value) {
  return DEMOGRAPHIC_RANK_TIER_ORDER.indexOf(value);
}

function demographicAgeBracketOrderIndex(value) {
  return DEMOGRAPHIC_AGE_BRACKET_ORDER.indexOf(value);
}

function demographicRankDistance(leftTier, rightTier) {
  const leftIndex = demographicRankTierOrderIndex(leftTier);
  const rightIndex = demographicRankTierOrderIndex(rightTier);
  if (leftIndex < 0 || rightIndex < 0) return Number.POSITIVE_INFINITY;
  return Math.abs(leftIndex - rightIndex);
}

function demographicAgeDistance(leftBracket, rightBracket) {
  const leftIndex = demographicAgeBracketOrderIndex(leftBracket);
  const rightIndex = demographicAgeBracketOrderIndex(rightBracket);
  if (leftIndex < 0 || rightIndex < 0) return Number.POSITIVE_INFINITY;
  return Math.abs(leftIndex - rightIndex);
}

function demographicCellCompatible(leftCell, rightCell) {
  if (!leftCell || !rightCell) return false;
  if (leftCell.gender !== rightCell.gender) return false;
  if (leftCell.rankTier !== rightCell.rankTier) return false;
  return demographicAgeDistance(leftCell.ageBracket, rightCell.ageBracket) <= 1;
}

function demographicWindowCompatible(clusterCells, windowCells) {
  if (!Array.isArray(clusterCells) || !Array.isArray(windowCells) || !windowCells.length) return false;

  const sequence = [...clusterCells.slice(-1), ...windowCells];
  for (let i = 1; i < sequence.length; i += 1) {
    if (!demographicCellCompatible(sequence[i - 1], sequence[i])) {
      return false;
    }
  }

  return true;
}

function demographicBucketHeadcount(bucket) {
  if (!bucket) return 0;
  if (Array.isArray(bucket.competitors)) return bucket.competitors.length;
  if (Number.isFinite(Number(bucket.headcount))) return Number(bucket.headcount);
  return 0;
}

function demographicCollectCellsFromGenderBucket(gender, genderBucket) {
  const cells = [];
  const rankTiers = genderBucket && genderBucket.rankTiers ? genderBucket.rankTiers : {};

  for (const rankTier of DEMOGRAPHIC_RANK_TIER_ORDER) {
    const rankBucket = rankTiers[rankTier];
    const ageBrackets = rankBucket && rankBucket.ageBrackets ? rankBucket.ageBrackets : {};

    for (const ageBracket of DEMOGRAPHIC_AGE_BRACKET_ORDER) {
      const ageBucket = ageBrackets[ageBracket];
      const competitors = Array.isArray(ageBucket && ageBucket.competitors) ? sortCompetitorsByAgeAndName(ageBucket.competitors) : [];
      if (!competitors.length) continue;

      cells.push({
        gender,
        rankTier,
        ageBracket,
        macroAgeBracket: ageBracket === 'unassigned' ? 'unassigned' : demographicMacroAgeBracketForAge(Number(ageBracket)),
        competitors,
        headcount: competitors.length
      });
    }
  }

  const genderUnassigned = genderBucket && genderBucket.unassigned ? genderBucket.unassigned : null;
  const unassignedCompetitors = Array.isArray(genderUnassigned && genderUnassigned.ageBrackets && genderUnassigned.ageBrackets.unassigned && genderUnassigned.ageBrackets.unassigned.competitors)
    ? sortCompetitorsByAgeAndName(genderUnassigned.ageBrackets.unassigned.competitors)
    : [];
  if (unassignedCompetitors.length) {
    cells.push({
      gender,
      rankTier: 'unassigned',
      ageBracket: 'unassigned',
      macroAgeBracket: 'unassigned',
      competitors: unassignedCompetitors,
      headcount: unassignedCompetitors.length
    });
  }

  return cells;
}

function demographicFlattenCells(demographicBuckets) {
  if (!demographicBuckets || typeof demographicBuckets !== 'object') return [];

  const cells = [];
  const genders = demographicBuckets.genders || {};

  for (const gender of DEMOGRAPHIC_GENDER_ORDER) {
    const genderBucket = genders[gender];
    cells.push(...demographicCollectCellsFromGenderBucket(gender, genderBucket));
  }

  const topLevelUnassigned = Array.isArray(demographicBuckets.unassigned && demographicBuckets.unassigned.competitors)
    ? sortCompetitorsByAgeAndName(demographicBuckets.unassigned.competitors)
    : [];
  if (topLevelUnassigned.length) {
    cells.push({
      gender: 'Unknown',
      rankTier: 'unassigned',
      ageBracket: 'unassigned',
      macroAgeBracket: 'unassigned',
      competitors: topLevelUnassigned,
      headcount: topLevelUnassigned.length,
      source: 'top-level-unassigned'
    });
  }

  return cells;
}

function demographicSplitOversizedCell(cell) {
  if (!cell || !Array.isArray(cell.competitors) || cell.competitors.length <= DEMOGRAPHIC_HARD_MAX_GROUP_SIZE) {
    return cell ? [cell] : [];
  }

  const chunks = splitEvenlyIntoGroups(cell.competitors, DEMOGRAPHIC_MIN_GROUP_SIZE, DEMOGRAPHIC_HARD_MAX_GROUP_SIZE);
  return chunks.map((competitors, index) => ({
    gender: cell.gender,
    rankTier: cell.rankTier,
    ageBracket: cell.ageBracket,
    macroAgeBracket: cell.macroAgeBracket || demographicMacroAgeBracketForAge(Number(cell.ageBracket)),
    competitors: sortCompetitorsByAgeAndName(competitors),
    headcount: competitors.length,
    splitFrom: {
      headcount: cell.headcount,
      chunkIndex: index + 1
    }
  }));
}

function demographicNormalizeCellsForClustering(cells) {
  const normalized = [];
  for (const cell of Array.isArray(cells) ? cells : []) {
    normalized.push(...demographicSplitOversizedCell(cell));
  }
  return normalized;
}

function demographicCellSameMacroSegment(leftCell, rightCell) {
  if (!leftCell || !rightCell) return false;
  return leftCell.gender === rightCell.gender &&
    leftCell.rankTier === rightCell.rankTier &&
    leftCell.macroAgeBracket === rightCell.macroAgeBracket;
}

function demographicCollectMacroSegments(cells) {
  const segments = [];
  let index = 0;

  while (index < cells.length) {
    const current = cells[index];
    const segment = [current];
    let cursor = index + 1;

    while (cursor < cells.length && demographicCellSameMacroSegment(current, cells[cursor])) {
      segment.push(cells[cursor]);
      cursor += 1;
    }

    segments.push(segment);
    index = cursor;
  }

  return segments;
}

function demographicFindExactWindow(currentCells, segment, cursor, remainingCap) {
  let bestWindow = null;
  const maxWindowSize = Math.min(DEMOGRAPHIC_LOOKAHEAD_WINDOW, segment.length - cursor, remainingCap);

  for (let windowSize = 1; windowSize <= maxWindowSize; windowSize += 1) {
    const windowCells = segment.slice(cursor, cursor + windowSize);
    if (!demographicWindowCompatible(currentCells, windowCells)) continue;

    const windowSizeTotal = windowCells.reduce((sum, cell) => sum + cell.headcount, 0);
    const mergedSize = currentCells.reduce((sum, cell) => sum + cell.headcount, 0) + windowSizeTotal;
    if (mergedSize > DEMOGRAPHIC_HARD_MAX_GROUP_SIZE) continue;

    let score = Math.abs(DEMOGRAPHIC_TARGET_GROUP_SIZE - mergedSize);
    if (mergedSize < DEMOGRAPHIC_SOFT_MIN_GROUP_SIZE) {
      score += (DEMOGRAPHIC_SOFT_MIN_GROUP_SIZE - mergedSize) * 2;
    } else if (mergedSize > DEMOGRAPHIC_SOFT_MAX_GROUP_SIZE) {
      score += (mergedSize - DEMOGRAPHIC_SOFT_MAX_GROUP_SIZE) * 1.5;
    }

    if (!bestWindow || score < bestWindow.score || (score === bestWindow.score && mergedSize > bestWindow.size)) {
      bestWindow = {
        score,
        size: mergedSize,
        windowSize,
        windowCells
      };
    }
  }

  return bestWindow;
}

function demographicFindMacroFallbackWindow(currentCells, segment, cursor, remainingCap) {
  let bestWindow = null;
  const currentSize = currentCells.reduce((sum, cell) => sum + cell.headcount, 0);
  const maxWindowSize = Math.min(segment.length - cursor, remainingCap);

  for (let windowSize = 1; windowSize <= maxWindowSize; windowSize += 1) {
    const windowCells = segment.slice(cursor, cursor + windowSize);
    const windowSizeTotal = windowCells.reduce((sum, cell) => sum + cell.headcount, 0);
    const mergedSize = currentSize + windowSizeTotal;
    if (mergedSize > DEMOGRAPHIC_HARD_MAX_GROUP_SIZE) break;

    let score = Math.abs(DEMOGRAPHIC_TARGET_GROUP_SIZE - mergedSize);
    if (mergedSize < DEMOGRAPHIC_SOFT_MIN_GROUP_SIZE) {
      score += (DEMOGRAPHIC_SOFT_MIN_GROUP_SIZE - mergedSize) * 3;
    } else if (mergedSize > DEMOGRAPHIC_SOFT_MAX_GROUP_SIZE) {
      score += (mergedSize - DEMOGRAPHIC_SOFT_MAX_GROUP_SIZE) * 1.5;
    }

    if (!bestWindow || score < bestWindow.score || (score === bestWindow.score && mergedSize > bestWindow.size)) {
      bestWindow = {
        score,
        size: mergedSize,
        windowSize,
        windowCells
      };
    }
  }

  return bestWindow;
}

function demographicBuildGroupFromSegment(segment, startIndex, groupNumber) {
  const currentCells = [segment[startIndex]];
  let currentSize = segment[startIndex].headcount;
  let cursor = startIndex + 1;

  while (cursor < segment.length) {
    if (currentSize >= DEMOGRAPHIC_HARD_MAX_GROUP_SIZE) {
      break;
    }

    const exactWindow = demographicFindExactWindow(currentCells, segment, cursor, DEMOGRAPHIC_HARD_MAX_GROUP_SIZE - currentSize);
    if (exactWindow) {
      currentCells.push(...exactWindow.windowCells);
      currentSize = exactWindow.size;
      cursor += exactWindow.windowSize;
      if (currentSize >= DEMOGRAPHIC_HARD_MAX_GROUP_SIZE) {
        break;
      }
      continue;
    }

    if (currentSize < DEMOGRAPHIC_SOFT_MAX_GROUP_SIZE) {
      const macroWindow = demographicFindMacroFallbackWindow(currentCells, segment, cursor, DEMOGRAPHIC_HARD_MAX_GROUP_SIZE - currentSize);
      if (macroWindow) {
        currentCells.push(...macroWindow.windowCells);
        currentSize = macroWindow.size;
        cursor += macroWindow.windowSize;
        if (currentSize >= DEMOGRAPHIC_HARD_MAX_GROUP_SIZE) {
          break;
        }
        continue;
      }
    }

    break;
  }

  return {
    group: demographicBuildGroupFromCells(currentCells, groupNumber),
    nextIndex: cursor
  };
}

function demographicDescribeTierSpan(cells) {
  const tiers = [...new Set(cells.map((cell) => cell.rankTier))];
  if (!tiers.length) return 'Mixed';
  if (tiers.length === 1) return tiers[0];
  return `${tiers[0]}-${tiers[tiers.length - 1]}`;
}

function demographicDescribeAgeSpan(cells) {
  const ages = [...new Set(cells.map((cell) => cell.ageBracket))];
  if (!ages.length) return 'Mixed';
  if (ages.length === 1) return ages[0];
  return `${ages[0]}-${ages[ages.length - 1]}`;
}

function demographicBuildGroupFromCells(cells, groupIndex) {
  const mergedCompetitors = [];
  for (const cell of cells) {
    mergedCompetitors.push(...cell.competitors);
  }
  const gender = cells[0] ? cells[0].gender : 'Unknown';
  const tierSpan = demographicDescribeTierSpan(cells);
  const ageSpan = demographicDescribeAgeSpan(cells);

  const group = {
    groupId: `group-${groupIndex}`,
    name: `${gender} ${tierSpan} ${ageSpan} Group ${groupIndex}`,
    competitors: sortCompetitorsByAgeAndName(mergedCompetitors),
    headcount: mergedCompetitors.length,
    gender,
    rankTier: tierSpan,
    ageBracket: ageSpan,
    macroAgeBracket: cells[0] ? cells[0].macroAgeBracket : 'unassigned',
    sourceBuckets: cells.map((cell) => ({
      gender: cell.gender,
      rankTier: cell.rankTier,
      ageBracket: cell.ageBracket,
      macroAgeBracket: cell.macroAgeBracket || 'unassigned',
      headcount: cell.headcount
    }))
  };

  if (mergedCompetitors.length < DEMOGRAPHIC_MIN_GROUP_SIZE) {
    group.warning = `Group size below minimum of ${DEMOGRAPHIC_MIN_GROUP_SIZE}`;
  }

  return group;
}

function clusterBucketsToGroups(demographicBuckets) {
  const cells = demographicNormalizeCellsForClustering(demographicFlattenCells(demographicBuckets));
  if (!cells.length) return [];

  const groups = [];
  let groupNumber = 1;

  const segments = demographicCollectMacroSegments(cells);
  for (const segment of segments) {
    let index = 0;
    while (index < segment.length) {
      const built = demographicBuildGroupFromSegment(segment, index, groupNumber);
      groups.push(built.group);
      groupNumber += 1;
      index = built.nextIndex;
    }
  }

  return groups;
}

function normalizeGroupsForContract(groups, params = {}) {
  const sourceGroups = Array.isArray(groups) ? groups : [];
  const minGroupSize = Number(params.minGroupSize ?? params.minSize ?? 4);
  const maxGroupSize = Number(params.maxGroupSize ?? params.maxSize ?? 6);

  return assignDivisionNumbers(
    sourceGroups.map((group, index) => {
      const value = group && typeof group === 'object' ? group : {};
      const competitors = Array.isArray(value.competitors) ? value.competitors : [];
      return {
        groupId: String(value.groupId || value.id || `group-${index + 1}`),
        name: String(value.name || value.groupId || value.id || `Group ${index + 1}`),
        competitors,
        minGroupSize: Number.isFinite(minGroupSize) ? minGroupSize : 4,
        maxGroupSize: Number.isFinite(maxGroupSize) ? maxGroupSize : 6,
        gender: value.gender || 'Unknown',
        rankTier: value.rankTier || '',
        ageBracket: value.ageBracket || ''
      };
    }),
    params.startingDivisionNumber ?? 20
  );
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
    return String(a.fullName || '').localeCompare(String(b.fullName || ''));
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

function buildDivisionsLegacy(competitors, params = {}) {
  const maxGroupSize = Number(params.maxGroupSize ?? params.maxSize ?? 6);
  const minGroupSize = Number(params.minGroupSize ?? params.minSize ?? 4);

  // If explicit groups were passed in, trust them as-is
  if (Array.isArray(params.groups) && params.groups.length) {
    return {
      groups: assignDivisionNumbers(
        rebalanceGroupsToSoftMax(params.groups, {
          maxGroupSize,
          minGroupSize
        }),
        params.startingDivisionNumber ?? 20
      ),
      reviewCompetitors: []
    };
  }

  const list = (Array.isArray(competitors) ? competitors : [])
    .filter((competitor) => competitor && typeof competitor === 'object');
  if (!list.length) return { groups: [], reviewCompetitors: [] };

  // Competitors are already normalized by CSV ingestion + GroupContract
  const normalized = list;

  const buckets = {
    Male: [],
    Female: [],
    Unknown: []
  };
  const ttldCompetitors = [];
  const reviewCompetitors = [];

  for (const competitor of normalized) {
    const reviewReason = reviewReasonFor(competitor);
    if (reviewReason) {
      reviewCompetitors.push({ ...competitor, reviewReason });
      continue;
    }
    if (isTtldRank(competitor.rank)) {
      ttldCompetitors.push(competitor);
      continue;
    }
    const key = competitor.gender === 'Male' || competitor.gender === 'Female' ? competitor.gender : 'Unknown';
    buckets[key].push(competitor);
  }

  if (reviewCompetitors.length) {
    console.warn(
      `[groupBuilder] ${reviewCompetitors.length} competitor(s) excluded from groups for review: ` +
      reviewCompetitors
        .map((competitor) => `${competitor.id ?? '?'} "${competitor.rank ?? ''}" (${competitor.reviewReason})`)
        .join('; ')
    );
  }

  const groups = [];
  const ttldGroups = buildTtldGroups(ttldCompetitors, maxGroupSize);
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

  return {
    groups: assignDivisionNumbers(groups, params.startingDivisionNumber ?? 20),
    reviewCompetitors
  };
}

function buildDivisions(competitors, options = {}) {
  // Default to true so the new two-pass engine is active by default
  const useNewEngine = options.useNewEngine !== undefined ? options.useNewEngine : true;
  const maxGroupSize = Number(options.maxGroupSize ?? options.maxSize ?? 11);
  const minGroupSize = Number(options.minGroupSize ?? options.minSize ?? 4);

  if (!useNewEngine) {
    return buildDivisionsLegacy(competitors, options).groups;
  }

  try {
    const demographicBuckets = buildDemographicBuckets(competitors);
    const clusteredGroups = clusterBucketsToGroups(demographicBuckets);

    // Pass through the rebalancer to absorb undersized tail groups (like that group of 3)
    const balancedGroups = rebalanceGroupsToSoftMax(clusteredGroups, {
      maxGroupSize,
      minGroupSize
    });

    // Run our custom CDB post-analysis absorption rule
    const finalizedGroups = absorbLoneCdbIntoBlackBelts(balancedGroups, maxGroupSize);

    return assignDivisionNumbers(finalizedGroups, options.startingDivisionNumber ?? 20);
  } catch (error) {
    console.error('New division engine failed, falling back to legacy builder:', error);
    return buildDivisionsLegacy(competitors, options).groups;
  }
}

function buildGroupsWithReview(competitors, params = {}) {
  if (Array.isArray(params.groups) && params.groups.length) {
    return buildDivisionsLegacy(competitors, params);
  }

  return {
    groups: buildDivisions(competitors, { ...params, useNewEngine: true }),
    reviewCompetitors: buildDivisionsLegacy(competitors, params).reviewCompetitors
  };
}

function buildGroups(competitors, params = {}) {
  return buildDivisions(competitors, { ...params, useNewEngine: true });
}

module.exports = {
  buildDemographicBuckets,
  clusterBucketsToGroups,
  buildDivisions,
  buildDivisionsLegacy,
  buildGroups,
  buildGroupsWithReview,
  assignDivisionNumbers
};
