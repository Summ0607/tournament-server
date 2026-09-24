const { normalizeGroup, normalizeGroups } = require('./groupContract');

function createGroupStore() {
  const groupsById = new Map();

  function rememberGroups(groups) {
    groupsById.clear();
    groups.forEach((group) => {
      groupsById.set(group.groupId, group);
    });
    return groups;
  }

  function loadGroups() {
    return Array.from(groupsById.values());
  }

  function loadGroup(groupId) {
    if (!groupId) return null;
    return groupsById.get(String(groupId)) || null;
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
