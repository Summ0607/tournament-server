const { normalizeGroup, normalizeGroups } = require('./groupContract');

function createGroupStore() {
  const groupsById = new Map();

  function rememberGroups(groups) {
    const normalized = normalizeGroups(groups);
    groupsById.clear();
    normalized.forEach((group) => {
      groupsById.set(group.groupId, group);
    });
    return normalized;
  }

  function loadGroups() {
    return Array.from(groupsById.values()).map((group, index) => normalizeGroup(group, index));
  }

  function loadGroup(groupId) {
    if (!groupId) return null;
    const group = groupsById.get(String(groupId));
    return group ? normalizeGroup(group, 0) : null;
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
