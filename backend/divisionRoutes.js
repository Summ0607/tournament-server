const express = require('express');
const { normalizeGroups } = require('./groupContract');
const { assignDivisionNumbers, appendDivisionTrace, summarizeGroupDivisionNumbers } = require('./groupDivisionAssignments');

function createDivisionRouter(deps) {
  const router = express.Router();
  const { competitorStore, groupStore, buildGroups } = deps;

  router.get('/groups', async (req, res) => {
    const groups = groupStore.loadGroups();
    res.json({ groups });
  });

  router.get('/groups/:groupId', (req, res) => {
    const group = groupStore.loadGroup(req.params.groupId);
    if (!group) {
      return res.status(404).json({
        error: 'Group not found',
        groupId: req.params.groupId,
        availableAt: `/api/groups/${req.params.groupId}`
      });
    }
    return res.json(group);
  });

  router.post('/divisions/build', async (req, res) => {
    try {
      const payload = req.body || {};
      const explicitGroups = payload.groups || [];
      if (explicitGroups.length) {
        const assignedGroups = assignDivisionNumbers(explicitGroups, payload.startingDivisionNumber ?? 20);
        appendDivisionTrace('division-build', {
          source: 'explicit',
          groupCount: assignedGroups.length,
          groups: summarizeGroupDivisionNumbers(assignedGroups)
        });
        return res.json({ groups: assignedGroups });
      }

      const activeCompetitorStore = typeof competitorStore === 'function'
        ? competitorStore()
        : competitorStore;

      const competitors = Array.isArray(payload.competitors)
        ? payload.competitors
        : await activeCompetitorStore.loadCompetitors();
      const groups = buildGroups(competitors, payload);
      appendDivisionTrace('division-build', {
        source: 'generated',
        groupCount: groups.length,
        groups: summarizeGroupDivisionNumbers(groups)
      });
      return res.json({ groups });
    } catch (err) {
      console.error('BUILD ERROR:', err);
      return res.status(500).json({ error: 'Failed to build divisions' });
    }
  });

  router.post('/divisions/save', async (req, res) => {
    try {
      if (!Array.isArray(req.body.groups)) {
        return res.status(400).json({ error: 'Invalid groups payload' });
      }

      const groups = assignDivisionNumbers(
        req.body.groups,
        req.body.startingDivisionNumber ?? 20
      );

      const activeCompetitorStore = typeof competitorStore === 'function'
        ? competitorStore()
        : competitorStore;

      const persisted = await activeCompetitorStore.saveDivisionAssignments(groups);
      const savedGroups = groupStore.saveGroups(persisted.groups);
      appendDivisionTrace('division-save', {
        groupCount: savedGroups.length,
        updatedCompetitors: persisted.updatedCompetitors,
        groups: summarizeGroupDivisionNumbers(savedGroups)
      });
      return res.json({ success: true, saved: savedGroups.length, updatedCompetitors: persisted.updatedCompetitors, groups: savedGroups });
    } catch (err) {
      console.error('SAVE ERROR:', err);
      return res.status(500).json({ error: 'Failed to save divisions' });
    }
  });

  return router;
}

module.exports = {
  createDivisionRouter
};
