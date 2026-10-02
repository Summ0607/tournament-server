const fs = require('fs');
const path = require('path');

const TRACE_PATH = path.join(__dirname, 'group-division-trace.log');

function parseOptionalInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function rankUpper(competitor) {
  return String(competitor && competitor.rank ? competitor.rank : '').trim().toUpperCase();
}

function isWeaponsEligible(competitor) {
  if (competitor && (competitor.weaponsEligible === true || competitor.weaponsEligible === 1 || competitor.weaponsEligible === '1')) {
    return true;
  }
  const rank = rankUpper(competitor);
  return rank === 'G2' || rank === 'G1' || rank === 'CDB' || rank === 'D1' || rank === 'D2' || rank === 'D3';
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

function rebalanceGroupsToSoftMax(groups, options = {}) {
  const sourceGroups = Array.isArray(groups) ? groups : [];
  const maxGroupSize = Number.parseInt(options.maxGroupSize ?? options.maxSize ?? 11, 10) || 11;
  const minGroupSize = Number.parseInt(options.minGroupSize ?? options.minSize ?? 4, 10) || 4;
  const overflowTolerance = Number.parseInt(options.overflowTolerance ?? 2, 10) || 2;
  const softMaxGroupSize = Math.max(minGroupSize, maxGroupSize + overflowTolerance);

  let processedGroups = [];

  // Pass 1: Handle oversized groups first
  sourceGroups.forEach((group, index) => {
    const value = group && typeof group === 'object' ? group : {};
    const competitors = Array.isArray(value.competitors) ? value.competitors : [];

    if (competitors.length <= softMaxGroupSize) {
      processedGroups.push({
        ...value,
        groupId: String(value.groupId || value.id || `group-${index + 1}`),
        competitors
      });
      return;
    }

    const chunks = splitEvenlyIntoGroups(competitors, minGroupSize, softMaxGroupSize);
    chunks.forEach((chunk, chunkIndex) => {
      processedGroups.push({
        ...value,
        groupId: `${value.groupId || `group-${index + 1}`}-${chunkIndex + 1}`,
        competitors: chunk
      });
    });
  });

  // Pass 2: Absorb or re-slice undersized tail groups (< minGroupSize, e.g., 1-3)
  const rebalanced = [];
  for (let i = 0; i < processedGroups.length; i++) {
    const current = processedGroups[i];

    // If we have an undersized group and a previous group exists, check if we can merge or must re-slice
    if (current.competitors.length < minGroupSize && rebalanced.length > 0) {
      const prev = rebalanced[rebalanced.length - 1];
      const combinedCompetitors = [...prev.competitors, ...current.competitors];

      if (combinedCompetitors.length <= maxGroupSize) {
        // Simple merge into previous group
        prev.competitors = combinedCompetitors;
        prev.headcount = prev.competitors.length;
      } else {
        // Combined exceeds maxGroupSize (e.g., 11 + 3 = 14). Re-slice the whole pool evenly!
        const reslicedChunks = splitEvenlyIntoGroups(combinedCompetitors, minGroupSize, maxGroupSize);
        // Replace the previous group's competitors with the first re-sliced chunk
        prev.competitors = reslicedChunks[0];
        prev.headcount = prev.competitors.length;

        // Push any additional re-sliced chunks as new groups
        for (let c = 1; c < reslicedChunks.length; c++) {
          rebalanced.push({
            ...prev,
            groupId: `${prev.groupId}-sub-${c}`,
            competitors: reslicedChunks[c],
            headcount: reslicedChunks[c].length
          });
        }
      }
    } else {
      rebalanced.push(current);
    }
  }

  return rebalanced;
}

function absorbLoneCdbIntoBlackBelts(groups, maxGroupSize = 11) {
  return groups.reduce((acc, currentGroup, index, arr) => {
    const isCdbGroup = currentGroup.rankCategory === 'CDB' && currentGroup.competitors.length <= 3;

    if (isCdbGroup && acc.length > 0) {
      const prevGroup = acc[acc.length - 1];
      const isBlackBelt = ['D1', 'D2', 'D3', 'Black Belt'].includes(prevGroup.rankCategory);
      const isAgeCompatible = Math.abs(prevGroup.averageAge - currentGroup.averageAge) <= 3;
      const hasCapacity = (prevGroup.competitors.length + currentGroup.competitors.length) <= maxGroupSize;

      if (isBlackBelt && isAgeCompatible && hasCapacity) {
        prevGroup.competitors.push(...currentGroup.competitors);
        prevGroup.headcount = prevGroup.competitors.length;
        return acc;
      }
    }

    acc.push(currentGroup);
    return acc;
  }, []);
}

function appendDivisionTrace(event, payload) {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    ...payload
  };

  try {
    fs.appendFileSync(TRACE_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    console.error('Failed to write division trace:', error);
  }
}

function assignDivisionNumbers(groups, startingDivisionNumber = 20) {
  const sourceGroups = Array.isArray(groups) ? groups : [];
  let nextDivisionNumber = parseOptionalInt(startingDivisionNumber);
  if (nextDivisionNumber == null) nextDivisionNumber = 20;

  return sourceGroups.map((group) => {
    const value = group && typeof group === 'object' ? group : {};
    const competitors = Array.isArray(value.competitors) ? value.competitors : [];

    // Check if any competitor in this group is weapons-eligible
    const hasWeapons = competitors.some((c) => isWeaponsEligible(c));

    // The group division number starts at the next available sequence (or uses pre-set value)
    let groupDivisionNumber = parseOptionalInt(value.groupDivisionNumber);
    if (groupDivisionNumber == null) {
      groupDivisionNumber = nextDivisionNumber++;
    } else {
      // Ensure our tracker stays ahead of any pre-assigned group numbers
      nextDivisionNumber = Math.max(nextDivisionNumber, groupDivisionNumber + 1);
    }

    let weaponsDiv = null;
    let hyungsDiv;
    let sparringDiv;

    if (hasWeapons) {
      // Weapons is present: Weapons is first (matches groupDivisionNumber),
      // followed sequentially by Hyungs and Sparring.
      weaponsDiv = groupDivisionNumber;
      hyungsDiv = nextDivisionNumber++;
      sparringDiv = nextDivisionNumber++;
    } else {
      // Weapons is unassigned: Hyungs is first (matches groupDivisionNumber),
      // followed sequentially by Sparring.
      hyungsDiv = groupDivisionNumber;
      sparringDiv = nextDivisionNumber++;
    }

    const assignedCompetitors = competitors.map((competitor) => {
      const competitorValue = competitor && typeof competitor === 'object' ? competitor : {};
      const eligibleForWeapons = isWeaponsEligible(competitorValue);

      return {
        ...competitorValue,
        groupDivisionNumber,
        weaponsDivisionNumber: eligibleForWeapons ? weaponsDiv : null,
        hyungsDivisionNumber: hyungsDiv,
        sparringDivisionNumber: sparringDiv,
        competitionDivisionNumber: hyungsDiv
      };
    });

    return {
      ...value,
      groupDivisionNumber,
      competitors: assignedCompetitors
    };
  });
}

function summarizeGroupDivisionNumbers(groups) {
  return (Array.isArray(groups) ? groups : []).map((group) => ({
    groupId: group && group.groupId ? String(group.groupId) : '',
    groupDivisionNumber: parseOptionalInt(group && group.groupDivisionNumber),
    competitorCount: Array.isArray(group && group.competitors) ? group.competitors.length : 0,
    weaponsAssignedCount: Array.isArray(group && group.competitors)
      ? group.competitors.filter((competitor) => String(competitor && competitor.weaponsDivision ? competitor.weaponsDivision : '').trim().toLowerCase() !== 'unassigned').length
      : 0,
    hyungsAssignedCount: Array.isArray(group && group.competitors)
      ? group.competitors.filter((competitor) => String(competitor && competitor.hyungsDivision ? competitor.hyungsDivision : '').trim().toLowerCase() !== 'unassigned').length
      : 0,
    sparringAssignedCount: Array.isArray(group && group.competitors)
      ? group.competitors.filter((competitor) => String(competitor && competitor.sparringDivision ? competitor.sparringDivision : '').trim().toLowerCase() !== 'unassigned').length
      : 0,
    competitorDivisionNumbers: Array.isArray(group && group.competitors)
      ? group.competitors.map((competitor) => parseOptionalInt(competitor && competitor.competitionDivisionNumber)).filter((value) => value != null)
      : []
  }));
}

module.exports = {
  TRACE_PATH,
  appendDivisionTrace,
  assignDivisionNumbers,
  rebalanceGroupsToSoftMax,
  absorbLoneCdbIntoBlackBelts,
  summarizeGroupDivisionNumbers
};
