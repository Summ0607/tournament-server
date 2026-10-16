const express = require('express');
const { normalizeGroups } = require('./groupContract');
const { assignDivisionNumbers, appendDivisionTrace, summarizeGroupDivisionNumbers } = require('./groupDivisionAssignments');

function createDivisionRouter(deps) {
  const router = express.Router();
  const { competitorStore, groupStore, buildGroups, buildGroupsWithReview } = deps;

  router.get('/groups', async (req, res) => {
    const eventName = String((req.query || {}).eventName || '').trim();
    const groups = groupStore.loadGroups(eventName);
    res.json({ groups });
  });

  router.get('/groups/:groupId', (req, res) => {
    const eventName = String((req.query || {}).eventName || '').trim();
    const group = groupStore.loadGroup(req.params.groupId, eventName);
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
      const eventName = String(payload.eventName || req.query.eventName || '').trim();
      const explicitGroups = payload.groups || [];
      if (explicitGroups.length) {
        const { groups: assignedGroups } = typeof buildGroupsWithReview === 'function'
          ? buildGroupsWithReview([], { ...payload, groups: explicitGroups })
          : { groups: assignDivisionNumbers(explicitGroups, payload.startingDivisionNumber ?? 20) };
        appendDivisionTrace('division-build', {
          source: 'explicit',
          groupCount: assignedGroups.length,
          groups: summarizeGroupDivisionNumbers(assignedGroups)
        });
        return res.json({ groups: assignedGroups });
      }

      const activeCompetitorStore = typeof competitorStore === 'function'
        ? competitorStore(eventName)
        : competitorStore;

      const competitors = Array.isArray(payload.competitors)
        ? payload.competitors
        : await activeCompetitorStore.loadCompetitors();
      const { groups, reviewCompetitors } = typeof buildGroupsWithReview === 'function'
        ? buildGroupsWithReview(competitors, payload)
        : { groups: buildGroups(competitors, payload), reviewCompetitors: [] };
      appendDivisionTrace('division-build', {
        source: 'generated',
        groupCount: groups.length,
        reviewCount: reviewCompetitors.length,
        groups: summarizeGroupDivisionNumbers(groups)
      });
      return res.json({ groups, reviewCompetitors });
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

      const eventName = String(req.body.eventName || req.query.eventName || '').trim();

      const groups = assignDivisionNumbers(
        req.body.groups,
        req.body.startingDivisionNumber ?? 20
      );

      const activeCompetitorStore = typeof competitorStore === 'function'
        ? competitorStore(eventName)
        : competitorStore;

      const persisted = await activeCompetitorStore.saveDivisionAssignments(groups, {
        maxGroupSize: req.body.maxGroupSize,
        minGroupSize: req.body.minGroupSize,
        startingDivisionNumber: req.body.startingDivisionNumber
      });
      const savedGroups = groupStore.saveGroups(persisted.groups, eventName);
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
