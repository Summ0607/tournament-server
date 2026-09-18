const fs = require('fs');
const path = require('path');
const { normalizeGroup, normalizeGroups } = require('./groupContract');

function createGroupStore(groupsDir) {
  function ensureGroupsDir() {
    fs.mkdirSync(groupsDir, { recursive: true });
  }

  function getGroupFilePath(groupId) {
    return path.join(groupsDir, `${groupId}.json`);
  }

  function saveGroups(groups) {
    const normalized = normalizeGroups(groups);
    ensureGroupsDir();

    const existing = fs.existsSync(groupsDir)
      ? fs.readdirSync(groupsDir).filter((fileName) => fileName.endsWith('.json'))
      : [];

    for (const fileName of existing) {
      fs.unlinkSync(path.join(groupsDir, fileName));
    }

    normalized.forEach((group) => {
      fs.writeFileSync(getGroupFilePath(group.groupId), JSON.stringify(group, null, 2));
    });

    return normalized;
  }

  function loadGroups() {
    if (!fs.existsSync(groupsDir)) return [];

    return fs.readdirSync(groupsDir)
      .filter((fileName) => fileName.endsWith('.json'))
      .sort()
      .map((fileName, index) => {
        const raw = JSON.parse(fs.readFileSync(path.join(groupsDir, fileName), 'utf8'));
        return normalizeGroup(raw, index);
      });
  }

  function loadGroup(groupId) {
    if (!groupId) return null;
    const filePath = getGroupFilePath(groupId);
    if (!fs.existsSync(filePath)) return null;
    return normalizeGroup(JSON.parse(fs.readFileSync(filePath, 'utf8')), 0);
  }

  function groupExists(groupId) {
    return !!loadGroup(groupId);
  }

  return {
    saveGroups,
    loadGroups,
    loadGroup,
    groupExists
  };
}

module.exports = {
  createGroupStore
};
