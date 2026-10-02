const { normalizeGroup } = require('./groupContract');

function groupAnchor(group) {
  const divisionNumber = Number.parseInt(group && group.groupDivisionNumber, 10);
  if (Number.isFinite(divisionNumber)) {
    return String(divisionNumber);
  }
  return String(group && (group.groupId || group.id) ? (group.groupId || group.id) : '').trim();
}

function createGroupStore() {
  const groupsById = new Map();

  function rememberGroups(groups) {
    groupsById.clear();
    groups.forEach((group) => {
      const normalized = normalizeGroup(group);
      const anchor = groupAnchor(normalized);
      if (anchor) {
        groupsById.set(anchor, normalized);
      }
    });
    return groups;
  }

  function loadGroups() {
    return Array.from(groupsById.values());
  }

  function loadGroup(groupId) {
    if (!groupId) return null;
    const trimmed = String(groupId).trim();
    const numeric = Number.parseInt(trimmed, 10);
    if (Number.isFinite(numeric) && groupsById.has(String(numeric))) {
      return groupsById.get(String(numeric)) || null;
    }
    const byLegacyId = Array.from(groupsById.values()).find((group) => {
      return String(group && (group.groupId || group.id) ? (group.groupId || group.id) : '').trim() === trimmed;
    });
    return byLegacyId || null;
  }

  function groupExists(groupId) {
    return !!loadGroup(groupId);
  }

  function clearGroups() {
    groupsById.clear();
  }

  return {
    saveGroups: rememberGroups,
    loadGroups,
    loadGroup,
    groupExists,
    clearGroups
  };
}

module.exports = {
  createGroupStore
};
