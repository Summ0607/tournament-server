(function () {
  const state = {
    competitors: [],
    groups: [],
    unassigned: [],
    reviewCompetitors: []
  };

  let dragCtx = null;

  const RANKS = [
    'TTLD',
    'G10', 'G9', 'G8', 'G7', 'G6',
    'G5', 'G4', 'G3', 'G2', 'G1',
    'CDB', 'D1', 'D2', 'D3'
  ];

  const BLACK_BELT_RANKS = new Set(['CDB', 'D1', 'D2', 'D3']);
  const RANK_BANDS = [
    { key: 'ttld', label: 'TTLD', minIdx: 0, maxIdx: 0 },
    { key: 'gup-10-9', label: 'G10-G9', minIdx: 1, maxIdx: 2 },
    { key: 'gup-8-7', label: 'G8-G7', minIdx: 3, maxIdx: 4 },
    { key: 'gup-6-5', label: 'G6-G5', minIdx: 5, maxIdx: 6 },
    { key: 'gup-4-1', label: 'G4-G1', minIdx: 7, maxIdx: 10 },
    { key: 'cdb', label: 'CDB', minIdx: 11, maxIdx: 11 },
    { key: 'bb', label: 'D1-D3', minIdx: 12, maxIdx: 14 }
  ];
  const MIN_GROUP_SIZE = 4;
  const CORRECTABLE_RANKS = [
    'TTLD',
    'G10', 'G9', 'G8', 'G7', 'G6',
    'G5', 'G4', 'G3', 'G2', 'G1',
    'CDB', 'D1', 'D2', 'D3'
  ];

  function genId() {
    return Math.random().toString(36).substr(2, 9);
  }

  function capitalizeWords(str) {
    return String(str).replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function parseDobAge(dob) {
    const value = String(dob || '').trim();
    if (!value) return NaN;

    const parts = value.split(/[\/\-]/).map((part) => parseInt(part, 10));
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
      return NaN;
    }

    const birthDate = new Date(parts[2], parts[0] - 1, parts[1]);
    if (Number.isNaN(birthDate.getTime())) return NaN;

    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age -= 1;
    }
    return age;
  }

  function normalizeRank(value) {
    const raw = String(value || '').trim();
    const upper = raw.toUpperCase();

    if (!upper) return '';
    if (upper === 'TTLD' || upper === 'CDB') return upper;
    if (/^G(10|[1-9])$/.test(upper)) return upper;
    if (/^D[1-3]$/.test(upper)) return upper;

    const gupMatch = upper.match(/^(\d+)(ST|ND|RD|TH)\s+GUP$/);
    if (gupMatch) {
      const n = Number.parseInt(gupMatch[1], 10);
      if (Number.isFinite(n) && n >= 1 && n <= 10) {
        return `G${11 - n}`;
      }
    }

    if (upper === 'CHO DAN') return 'D1';
    if (upper === 'E DAN') return 'D2';
    if (upper === 'SAM DAN') return 'D3';

    return raw;
  }

  function normalizeGender(value) {
    const v = String(value || '').trim().toLowerCase();
    if (!v) return 'Unknown';
    if (v.startsWith('m')) return 'Male';
    if (v.startsWith('f')) return 'Female';
    return capitalizeWords(String(value || '').trim());
  }

  function parseOptionalInt(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  function normalizeCompetitor(row) {
    const firstName = String(row.firstName || '').trim();
    const lastName = String(row.lastName || '').trim();
    const dob = String(row.dob || '').trim();
    const age = parseDobAge(dob);
    const specialNeedsValue = String(row.specialNeeds || '').trim().toLowerCase();

    return {
      ...row,
      id: row.id != null ? String(row.id) : genId(),
      firstName,
      lastName,
      fullName: [firstName, lastName].filter(Boolean).join(' ').trim() || 'Unknown',
      dob,
      dobIso: dob,
      associationNumber: String(row.associationNumber || '').trim(),
      gender: normalizeGender(row.gender),
      genderCode: String(row.gender || '').trim(),
      rank: normalizeRank(row.rank),
      rankCode: normalizeRank(row.rank),
      age: Number.isFinite(age) ? age : 0,
      studio: String(row.studio || '').trim(),
      school: String(row.school || row.studio || '').trim(),
      height: Number.parseInt(row.height, 10) || 0,
      specialNeeds: specialNeedsValue === 'yes' ? 'Yes' : 'No',
      specialNeedsFlag: specialNeedsValue === 'yes',
      weaponsEligible: row.weaponsEligible != null ? row.weaponsEligible : 0,
      weaponsDivision: row.weaponsDivision || 'unassigned',
      hyungsDivision: row.hyungsDivision || 'unassigned',
      sparringDivision: row.sparringDivision || 'unassigned',
      ringAssignment: row.ringAssignment || 'unassigned',
      groupDivisionId: row.groupDivisionId || '',
      groupDivisionName: row.groupDivisionName || '',
      groupDivisionNumber: parseOptionalInt(row.groupDivisionNumber),
      competitionDivisionNumber: parseOptionalInt(row.competitionDivisionNumber),
      reviewReason: String(row.reviewReason || '').trim(),
      reviewNote: String(row.reviewNote || '').trim()
    };
  }

  function reviewRankOptionsMarkup(selectedRank) {
    const selected = String(selectedRank || '').trim().toUpperCase();
    return ['<option value="">Select corrected rank…</option>']
      .concat(CORRECTABLE_RANKS.map((rank) => {
        const chosen = rank === selected ? ' selected' : '';
        return `<option value="${esc(rank)}"${chosen}>${esc(rank)}</option>`;
      }))
      .join('');
  }

  function updateReviewSectionVisibility() {
    const section = document.getElementById('reviewSection');
    if (!section) return;
    if (state.groups.length || state.reviewCompetitors.length) {
      section.classList.remove('hidden');
    } else {
      section.classList.add('hidden');
    }
  }

  function normalizeGroup(group, index) {
    const competitors = Array.isArray(group.competitors) ? group.competitors.map(normalizeCompetitor) : [];
    const normalized = {
      id: String(group.id || group.groupId || `group-${index + 1}`),
      groupId: String(group.groupId || group.id || `group-${index + 1}`),
      name: String(group.name || group.groupId || group.id || `Group ${index + 1}`),
      groupDivisionNumber: parseOptionalInt(group.groupDivisionNumber),
      competitors
    };
    syncGroupDisplayMetadata(normalized);
    return normalized;
  }

  function groupGender(comps) {
    if (!comps.length) return 'Unknown';
    const genders = [...new Set(comps.map((c) => c.gender || 'Unknown'))];
    return genders.length === 1 ? genders[0] : 'Mixed';
  }

  function rankIdx(rank) {
    return RANKS.indexOf(rank);
  }

  function isBlackBelt(rank) {
    return BLACK_BELT_RANKS.has(rank);
  }

  function isAdult(age) {
    return age >= 18;
  }

  function rankBandFor(rank) {
    const idx = rankIdx(rank);
    if (idx < 0) return null;
    return RANK_BANDS.find((b) => idx >= b.minIdx && idx <= b.maxIdx) || null;
  }

  function groupRankBand(comps) {
    if (!comps.length) return 'Unknown Band';
    const bands = [...new Set(comps.map((c) => {
      const band = rankBandFor(c.rank);
      return band ? band.label : 'Unknown Band';
    }))];
    return bands.length === 1 ? bands[0] : 'Mixed Bands';
  }

  function groupAgeRange(comps) {
    if (!comps.length) return 'No ages';
    const ages = comps.map((c) => c.age);
    const lo = Math.min.apply(null, ages);
    const hi = Math.max.apply(null, ages);
    return lo === hi ? `Age ${lo}` : `Ages ${lo}-${hi}`;
  }

  function groupRankRange(comps) {
    if (!comps.length) return 'No ranks';
    const idxs = comps.map((c) => rankIdx(c.rank)).filter((i) => i >= 0);
    if (!idxs.length) return 'Unknown Rank';
    const lo = Math.min.apply(null, idxs);
    const hi = Math.max.apply(null, idxs);
    return lo === hi ? RANKS[lo] : `${RANKS[lo]} - ${RANKS[hi]}`;
  }

  function autoName(group) {
    if (!group.competitors.length) return 'Empty Group';
    const gender = group.gender || groupGender(group.competitors);
    return `${gender} ${groupRankRange(group.competitors)} · ${groupAgeRange(group.competitors)}`;
  }

  function syncGroupDisplayMetadata(group) {
    if (!group) return;
    if (!group.competitors.length) {
      group.gender = 'Unknown';
      group.rankBand = 'Unknown Band';
      group.isAdult = false;
      group.name = group.name || 'Empty Group';
      return;
    }
    group.gender = groupGender(group.competitors);
    group.rankBand = groupRankBand(group.competitors);
    group.isAdult = group.competitors.some((c) => isAdult(c.age));
    group.name = autoName(group);
  }

  function recommendedMaxSize(totalCompetitors) {
    if (totalCompetitors <= 120) return 6;
    if (totalCompetitors <= 250) return 7;
    return 13;
  }

  function applyRecommendedSizeSettings(totalCompetitors) {
    const maxSize = recommendedMaxSize(totalCompetitors);
    document.getElementById('minSize').value = String(MIN_GROUP_SIZE);
    document.getElementById('maxSize').value = String(maxSize);
    const sizeNote = document.getElementById('sizeNote');
    sizeNote.style.display = 'block';
    sizeNote.innerHTML = `ℹ️ Recommended group size for <strong>${totalCompetitors}</strong> competitors: <strong>${MIN_GROUP_SIZE} to ${maxSize}</strong>.`;
  }

  function renderStats() {
    const minSize = Math.max(MIN_GROUP_SIZE, parseInt(document.getElementById('minSize').value || MIN_GROUP_SIZE, 10));
    const total = state.groups.reduce((sum, group) => sum + group.competitors.length, 0) + state.unassigned.length + state.reviewCompetitors.length;
    const nGroups = state.groups.length;
    const nWarn = state.groups.filter((group) => group.competitors.length < minSize).length;
    const nAdults = state.groups.filter((group) => group.isAdult).reduce((sum, group) => sum + group.competitors.length, 0);
    const nJuniors = total - nAdults - state.unassigned.length - state.reviewCompetitors.length;

    document.getElementById('statsBar').innerHTML = `
      <div class="stat"><span class="stat-value">${total}</span><span class="stat-label">Competitors</span></div>
      <div class="stat"><span class="stat-value">${nGroups}</span><span class="stat-label">Groups</span></div>
      <div class="stat"><span class="stat-value">${nAdults}</span><span class="stat-label">Adults</span></div>
      <div class="stat"><span class="stat-value">${nJuniors}</span><span class="stat-label">Juniors</span></div>
      ${state.reviewCompetitors.length ? `<div class="stat stat-warn"><span class="stat-value">⚑ ${state.reviewCompetitors.length}</span><span class="stat-label">Flagged</span></div>` : ''}
      ${nWarn ? `<div class="stat stat-warn"><span class="stat-value">⚠ ${nWarn}</span><span class="stat-label">Undersized</span></div>` : ''}
    `;
  }

  function rankBadge(rank) {
    if (rankIdx(rank) === -1) return `<span class="rank-badge rank-unk">? ${esc(rank)}</span>`;
    const cls = isBlackBelt(rank) ? 'rank-badge rank-black' : 'rank-badge rank-gup';
    return `<span class="${cls}">${esc(rank)}</span>`;
  }

  function genderBadge(gender) {
    const value = String(gender || '').trim().toUpperCase();
    if (value.startsWith('M')) return '<span class="gender-badge gender-m">M</span>';
    if (value.startsWith('F')) return '<span class="gender-badge gender-f">F</span>';
    return `<span class="gender-badge gender-unk">${esc(value || '?')}</span>`;
  }

  function competitorRow(c, groupId) {
    return `
      <div class="competitor-row"
           draggable="true"
           ondragstart="startCompetitorDrag(event, '${c.id}', '${groupId}')"
           ondragend="endCompetitorDrag(event)">
        <div class="competitor-info">
          <div class="competitor-name">${esc(c.fullName)}</div>
          <div class="competitor-sub">${genderBadge(c.gender)}${rankBadge(c.rank)}<span>Age ${c.age}</span></div>
        </div>
        <div class="competitor-actions">
          <button class="btn btn-danger btn-sm" onclick="unassign('${c.id}','${groupId}')">✕</button>
        </div>
      </div>
    `;
  }

  function renderUnassigned() {
    const sec = document.getElementById('unassignedSection');
    const list = document.getElementById('unassignedList');
    if (!state.unassigned.length) {
      sec.classList.add('hidden');
      return;
    }
    sec.classList.remove('hidden');
    list.innerHTML = state.unassigned.map((c) => `
      <div class="competitor-row pool-row"
           draggable="true"
           ondragstart="startCompetitorDrag(event, '${c.id}', null)"
           ondragend="endCompetitorDrag(event)">
        <div class="competitor-info">
          <div class="competitor-name">${esc(c.fullName)}</div>
          <div class="competitor-sub">${genderBadge(c.gender)}${rankBadge(c.rank)}<span>Age ${c.age}</span></div>
        </div>
      </div>
    `).join('');
  }

  function renderReviewRoster() {
    const section = document.getElementById('reviewRosterSection');
    const list = document.getElementById('reviewRosterList');
    const count = document.getElementById('reviewRosterCount');
    if (!section || !list || !count) return;

    if (!state.reviewCompetitors.length) {
      section.classList.add('hidden');
      list.innerHTML = '';
      count.textContent = '0 flagged entries';
      return;
    }

    section.classList.remove('hidden');
    count.textContent = `${state.reviewCompetitors.length} flagged entr${state.reviewCompetitors.length === 1 ? 'y' : 'ies'}`;
    list.innerHTML = state.reviewCompetitors.map((competitor) => {
      const noteValue = String(competitor.reviewNote || '').trim();
      return `
        <div class="review-row" data-competitor-id="${esc(competitor.id)}">
          <div class="review-row-main">
            <div class="review-row-title">
              <strong>${esc(competitor.fullName || 'Unknown')}</strong>
              <span class="review-chip review-chip-alert">${esc(competitor.reviewReason || 'review required')}</span>
            </div>
            <div class="review-row-meta">
              <span><strong>Studio:</strong> ${esc(competitor.studio || 'Unknown')}</span>
              <span><strong>Rank:</strong> ${esc(competitor.rank || '') || 'Blank'}</span>
              <span><strong>Age:</strong> ${esc(String(competitor.age || 0))}</span>
            </div>
            <div class="review-row-note">
              <label for="review-note-${esc(competitor.id)}">Note</label>
              <input id="review-note-${esc(competitor.id)}" type="text" value="${esc(noteValue)}" placeholder="Optional note for head table staff">
            </div>
          </div>
          <div class="review-row-actions">
            <label for="review-rank-${esc(competitor.id)}">Corrected rank</label>
            <select id="review-rank-${esc(competitor.id)}">
              ${reviewRankOptionsMarkup(competitor.rank)}
            </select>
            <button class="btn btn-gold btn-sm" onclick="applyReviewCorrection('${esc(competitor.id)}')">Apply & Requeue</button>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderGroups() {
    const minSize = Math.max(MIN_GROUP_SIZE, parseInt(document.getElementById('minSize').value || MIN_GROUP_SIZE, 10));
    const grid = document.getElementById('groupsGrid');
    grid.innerHTML = state.groups.map((g, idx) => {
      const count = g.competitors.length;
      const warn = count < minSize;
      return `
        <div class="group-card ${warn ? 'warn-border' : 'ok-border'}"
             id="gc-${g.id}"
             ondragover="allowGroupDrop(event, '${g.id}')"
             ondragenter="markGroupDropTarget(event, '${g.id}')"
             ondragleave="unmarkGroupDropTarget(event, '${g.id}')"
             ondrop="dropIntoGroup(event, '${g.id}')">
          <div class="group-header ${g.isAdult ? 'adult' : ''}">
            <input class="group-name-input" value="${esc(g.name)}" readonly title="Auto-generated from current competitors">
            <div class="group-meta">
              <span>${count} competitor${count !== 1 ? 's' : ''}</span>
              <span>${groupRankRange(g.competitors)}</span>
              <span>${groupAgeRange(g.competitors)}</span>
            </div>
          </div>
          ${warn ? `<div class="group-warn-strip">⚠️ Only ${count} competitor${count !== 1 ? 's' : ''} — minimum is ${minSize}</div>` : ''}
          <div class="competitor-list">${g.competitors.map((c) => competitorRow(c, g.id)).join('')}</div>
          <div class="group-footer"><span style="font-size:12px;color:#999;">Group ${idx + 1}</span></div>
        </div>
      `;
    }).join('');
  }

  function renderReview() {
    state.groups.forEach(syncGroupDisplayMetadata);
    renderStats();
    renderUnassigned();
    renderGroups();
    renderReviewRoster();
    updateReviewSectionVisibility();
  }

  function applyReviewCorrection(compId) {
    const reviewCompetitor = state.reviewCompetitors.find((candidate) => candidate.id === compId);
    if (!reviewCompetitor) return;

    const rankInput = document.getElementById(`review-rank-${compId}`);
    const noteInput = document.getElementById(`review-note-${compId}`);
    const correctedRank = String(rankInput && rankInput.value || '').trim().toUpperCase();
    if (!correctedRank) {
      window.alert('Choose a corrected rank before re-queuing this competitor.');
      return;
    }

    const competitorIndex = state.competitors.findIndex((candidate) => candidate.id === compId);
    const correctedNote = String(noteInput && noteInput.value || '').trim();
    const updated = {
      ...(competitorIndex >= 0 ? state.competitors[competitorIndex] : reviewCompetitor),
      rank: correctedRank,
      rankCode: correctedRank,
      reviewReason: '',
      reviewNote: correctedNote
    };

    if (competitorIndex >= 0) {
      state.competitors[competitorIndex] = updated;
    } else {
      state.competitors.push(updated);
    }

    state.reviewCompetitors = state.reviewCompetitors.filter((candidate) => candidate.id !== compId);
    window.alert(`${updated.fullName || 'Competitor'} updated to ${correctedRank} and returned to the main roster.`);
    renderReview();
  }

  function canAcceptMove(group, competitor) {
    if (!group || !competitor) return false;
    const isTtld = String(competitor.rank || '').trim() === 'TTLD';
    if (isTtld) {
      return group.competitors.length === 0 || group.competitors.every((c) => String(c.rank || '').trim() === 'TTLD');
    }
    return !group.competitors.length || !group.competitors.every((c) => String(c.rank || '').trim() === 'TTLD');
  }

  function promptToDeleteEmptyGroup(group) {
    if (!group || group.competitors.length !== 0) return;
    if (!window.confirm(`"${group.name}" is now empty. Delete this group?`)) return;
    state.groups = state.groups.filter((candidate) => candidate.id !== group.id);
  }

  function moveCompetitorBetweenGroups(compId, fromGroupId, targetGroupId) {
    if (!targetGroupId || fromGroupId === targetGroupId) return false;
    const sourceGroup = fromGroupId ? state.groups.find((g) => g.id === fromGroupId) : null;
    const sourceList = sourceGroup ? sourceGroup.competitors : state.unassigned;
    const sourceIndex = sourceList.findIndex((c) => c.id === compId);
    if (sourceIndex === -1) return false;
    const competitor = sourceList[sourceIndex];
    const targetGroup = state.groups.find((g) => g.id === targetGroupId);
    if (!targetGroup || !canAcceptMove(targetGroup, competitor)) return false;

    sourceList.splice(sourceIndex, 1);
    targetGroup.competitors.push(competitor);
    promptToDeleteEmptyGroup(sourceGroup);
    renderReview();
    return true;
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Request failed (${response.status}): ${text || response.statusText}`);
    }
    return response.json();
  }

  async function loadSavedGroups() {
    const data = await fetchJson('/api/groups');
    state.groups = Array.isArray(data.groups) ? data.groups.map(normalizeGroup) : [];
    state.unassigned = [];
    state.reviewCompetitors = [];
    renderReview();
  }

  async function loadCompetitorsFromServer() {
    try {
      const result = await fetchJson('/api/competitors');
      const rawCompetitors = Array.isArray(result) ? result : (result && Array.isArray(result.competitors) ? result.competitors : []);
      state.competitors = rawCompetitors.map(normalizeCompetitor);
      state.groups = [];
      state.unassigned = [];
      state.reviewCompetitors = [];
      updateReviewSectionVisibility();
      document.getElementById('autoGroupBtn').disabled = state.competitors.length === 0;
      if (state.competitors.length) {
        applyRecommendedSizeSettings(state.competitors.length);
      }
      console.log(`Loaded ${state.competitors.length} competitors from server.`);
    } catch (error) {
      document.getElementById('autoGroupBtn').disabled = true;
      window.alert(`Unable to load competitors from the server.\n${error.message}`);
    }
  }

  async function runAutoGroup() {
    if (!state.competitors.length) return;

    try {
      const payload = {
        minGroupSize: Number(document.getElementById('minSize').value || 4),
        maxGroupSize: Number(document.getElementById('maxSize').value || recommendedMaxSize(state.competitors.length)),
        ageSpanUnder14: Number(document.getElementById('ageSpanUnder14').value || 3),
        ageSpan14To37: Number(document.getElementById('ageSpan14To37').value || 4),
        ageSpan38Plus: Number(document.getElementById('ageSpan38Plus').value || 35),
        competitors: state.competitors
      };

      const built = await fetchJson('/api/divisions/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const builtGroups = Array.isArray(built.groups) ? built.groups.map(normalizeGroup) : [];

      if (!builtGroups.length) {
        state.groups = [];
        state.unassigned = [];
        renderReview();
        window.alert('Auto-group returned no standard groups. Review flagged entries and retry.');
        return;
      }

      state.groups = builtGroups;
      state.unassigned = [];
      state.reviewCompetitors = Array.isArray(built.reviewCompetitors) ? built.reviewCompetitors.map(normalizeCompetitor) : [];
      renderReview();
    } catch (error) {
      console.error('Auto-group error:', error);
      window.alert(`Auto-group failed: ${error.message}`);
    }
  }

  async function saveGroupsToServer() {
    return fetchJson('/api/divisions/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups: state.groups })
    });
  }

  async function buildAndSaveDivisions() {
    try {
      const payload = {
        minGroupSize: Number(document.getElementById('minSize').value || 4),
        maxGroupSize: Number(document.getElementById('maxSize').value || 6),
        ageSpanUnder14: Number(document.getElementById('ageSpanUnder14').value || 3),
        ageSpan14To37: Number(document.getElementById('ageSpan14To37').value || 4),
        ageSpan38Plus: Number(document.getElementById('ageSpan38Plus').value || 35),
        competitors: state.competitors,
        groups: state.groups
      };

      const built = await fetchJson('/api/divisions/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const builtGroups = Array.isArray(built.groups) ? built.groups.map(normalizeGroup) : [];
      state.reviewCompetitors = Array.isArray(built.reviewCompetitors) ? built.reviewCompetitors.map(normalizeCompetitor) : [];
      if (!builtGroups.length) {
        state.groups = [];
        state.unassigned = [];
        renderReview();
        window.alert('Build returned no standard groups. Review flagged entries and retry.');
        return;
      }

      const saved = await fetchJson('/api/divisions/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groups: builtGroups })
      });

      state.groups = Array.isArray(saved.groups) ? saved.groups.map(normalizeGroup) : builtGroups;
      renderReview();
      displayGroups(state.groups);
      window.alert(`Divisions built and saved successfully (${state.groups.length} groups).`);
    } catch (error) {
      console.error('Build & save error:', error);
      window.alert(`Build & save failed: ${error.message}`);
    }
  }

  function displayGroups(groups) {
    const container = document.getElementById('groupsContainer');
    if (!container) return;
    container.innerHTML = '';

    (Array.isArray(groups) ? groups : []).forEach((group, index) => {
      const groupDiv = document.createElement('div');
      groupDiv.className = 'group-block';

      const header = document.createElement('h3');
      const divisionLabel = Number.isFinite(Number(group.groupDivisionNumber))
        ? ` (Division ${Number(group.groupDivisionNumber)})`
        : '';
      header.textContent = `${group.name || `Group ${index + 1}`}${divisionLabel}`;
      groupDiv.appendChild(header);

      const list = document.createElement('ul');
      (Array.isArray(group.competitors) ? group.competitors : []).forEach((comp) => {
        const li = document.createElement('li');
        const compDivision = Number.isFinite(Number(comp.competitionDivisionNumber))
          ? ` — #${Number(comp.competitionDivisionNumber)}`
          : '';
        li.textContent = `${comp.fullName || `${comp.firstName || ''} ${comp.lastName || ''}`.trim() || 'Unknown'}${compDivision} — ${comp.age} — ${comp.gender || ''} — ${comp.rank || ''}`;
        list.appendChild(li);
      });
      groupDiv.appendChild(list);
      container.appendChild(groupDiv);
    });
  }

  async function loadStatus() {
    const data = await fetchJson('/api/rings');
    const output = (data.rings || []).map((ring) => `${ring.ringLabel} — ${ring.phase}`).join('\n');
    document.getElementById('statusOutput').textContent = output;
    document.getElementById('statusPanel').classList.remove('hidden');
    document.getElementById('statusTimestamp').textContent = `Updated: ${new Date().toLocaleTimeString()}`;
  }

  function clearStatus() {
    document.getElementById('statusOutput').textContent = '';
    document.getElementById('statusPanel').classList.add('hidden');
  }

  function addNewGroup() {
    state.groups.push(normalizeGroup({ id: genId(), name: 'New Group', competitors: [] }, state.groups.length));
    renderReview();
  }

  function unassign(compId, groupId) {
    const g = state.groups.find((group) => group.id === groupId);
    if (!g) return;
    const idx = g.competitors.findIndex((c) => c.id === compId);
    if (idx === -1) return;
    state.unassigned.push.apply(state.unassigned, g.competitors.splice(idx, 1));
    promptToDeleteEmptyGroup(g);
    renderReview();
  }

  function startCompetitorDrag(event, compId, fromGroupId) {
    dragCtx = { compId, fromGroupId };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', JSON.stringify(dragCtx));
  }

  function endCompetitorDrag() {
    dragCtx = null;
    document.querySelectorAll('.group-card.drop-target').forEach((el) => el.classList.remove('drop-target'));
  }

  function allowGroupDrop(event, groupId) {
    if (!dragCtx || dragCtx.fromGroupId === groupId) return;
    const target = state.groups.find((group) => group.id === groupId);
    const source = dragCtx.fromGroupId ? state.groups.find((group) => group.id === dragCtx.fromGroupId) : null;
    const sourceList = source ? source.competitors : state.unassigned;
    const competitor = sourceList.find((c) => c.id === dragCtx.compId);
    if (!target || !competitor || !canAcceptMove(target, competitor)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }

  function markGroupDropTarget(event, groupId) {
    if (!dragCtx || dragCtx.fromGroupId === groupId) return;
    const card = document.getElementById(`gc-${groupId}`);
    if (card) card.classList.add('drop-target');
  }

  function unmarkGroupDropTarget(event, groupId) {
    const card = document.getElementById(`gc-${groupId}`);
    if (card) card.classList.remove('drop-target');
  }

  function dropIntoGroup(event, targetGroupId) {
    event.preventDefault();
    const card = document.getElementById(`gc-${targetGroupId}`);
    if (card) card.classList.remove('drop-target');

    let payload = dragCtx;
    if (!payload && event.dataTransfer) {
      try {
        payload = JSON.parse(event.dataTransfer.getData('text/plain') || 'null');
      } catch (error) {
        payload = null;
      }
    }
    if (!payload) return;
    moveCompetitorBetweenGroups(payload.compId, payload.fromGroupId, targetGroupId);
    dragCtx = null;
  }

  function exportJSON() {
    const payload = {
      exportedAt: new Date().toISOString(),
      totalCompetitors: state.groups.reduce((sum, group) => sum + group.competitors.length, 0),
      totalGroups: state.groups.length,
      groups: state.groups
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tournament-groups-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    saveGroupsToServer();
  }

  window.loadCompetitorsFromServer = loadCompetitorsFromServer;
  window.runAutoGroup = runAutoGroup;
  window.buildAndSaveDivisions = buildAndSaveDivisions;
  window.loadStatus = loadStatus;
  window.clearStatus = clearStatus;
  window.addNewGroup = addNewGroup;
  window.applyReviewCorrection = applyReviewCorrection;
  window.unassign = unassign;
  window.startCompetitorDrag = startCompetitorDrag;
  window.endCompetitorDrag = endCompetitorDrag;
  window.allowGroupDrop = allowGroupDrop;
  window.markGroupDropTarget = markGroupDropTarget;
  window.unmarkGroupDropTarget = unmarkGroupDropTarget;
  window.dropIntoGroup = dropIntoGroup;
  window.exportJSON = exportJSON;

  window.addEventListener('DOMContentLoaded', () => {
    loadSavedGroups().catch((error) => {
      console.error('Failed to load saved groups.', error);
    });
  });
}());
