(function (root) {
  function create({ document, request, selectedEvent, confirm }) {
    const node = (id) => document.getElementById(id);
    const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fields = ['firstName', 'lastName', 'associationNumber', 'school', 'rank', 'certification', 'priority', 'reviewNotes'];
    const volunteerFields = ['age', 'parentName', 'contactNumber', 'primaryType', 'secondaryType'];
    const certLabel = (code) => (data && data.certificationLevels || []).find((level) => level.code === code)?.label || code || 'Unknown';
    const rankLabel = (code) => (data && data.judgeRanks || []).find((rank) => rank.code === code)?.label || code;
    const filterFields = ['name', 'associationNumber', 'school', 'rank', 'certification', 'priority', 'flaggedForReview', 'source'];
    const filters = Object.fromEntries(filterFields.map((key) => [key, '']));
    let data = null, schools = [], scope = '', token = 0, writing = false, editing = false, id = '', baseline = '', query = '', detailsId = '';
    const selected = new Set();
    const draft = () => ({ ...Object.fromEntries(fields.map((key) => [key,
      key === 'priority' ? Number(node('rj-priority').value) : node(`rj-${key}`).value
    ])), flaggedForReview: node('rj-flaggedForReview').checked });
    const volunteerDraft = () => ({ ...Object.fromEntries(volunteerFields.map((key) =>
      [key, key === 'age' ? Number(node('rj-age').value) : node(`rj-${key}`).value])),
      ageAsOf: data.volunteerDirectory.tournamentDate });
    const editorDraft = () => JSON.stringify({ judge: draft(), volunteer: node('rjVolunteerFields').hidden ? null : volunteerDraft() });
    const dirty = () => editing && editorDraft() !== baseline;
    const locked = () => !data || writing || data.configurationLocked || scope !== selectedEvent();
    const source = (row) => row.volunteerId ? 'Volunteer' : row.competitorId === null ? 'Manual' : 'Competitor';
    const matchesText = (value, filter) => String(value || '').toLowerCase().includes(filter.toLowerCase());
    const visible = () => data ? data.judges.filter((row) => {
      const sourceValue = source(row);
      return [row.name, row.associationNumber, row.school, row.rank, rankLabel(row.rank), certLabel(row.certification), row.reviewNotes]
        .some((value) => matchesText(value, query)) &&
        matchesText(row.name, filters.name) &&
        matchesText(row.associationNumber, filters.associationNumber) &&
        (!filters.school || row.school.toLowerCase() === filters.school.toLowerCase()) &&
        (!filters.rank || row.rank === filters.rank) &&
        (!filters.certification || row.certification === filters.certification) &&
        (!filters.priority || String(row.priority ?? 4) === filters.priority) &&
        (!filters.flaggedForReview || String(row.flaggedForReview) === filters.flaggedForReview) &&
        (!filters.source || sourceValue === filters.source);
    }) : [];
    function filterOptions(key) {
      const values = [...new Set((data?.judges || []).map((row) => {
        if (key === 'school') return row.school;
        if (key === 'rank') return row.rank;
        if (key === 'certification') return row.certification || 'UNKNOWN';
        if (key === 'priority') return row.priority ?? 4;
        if (key === 'source') return source(row);
        return '';
      }).filter((value) => value !== '' && value !== null && value !== undefined))]
        .sort((a, b) => key === 'priority' ? a - b : a.localeCompare(b));
      if (key === 'rank') return values.map((value) => [value, rankLabel(value)]);
      if (key === 'certification') return values.map((value) => [value, certLabel(value)]);
      return values.map((value) => [String(value), String(value)]);
    }
    function renderFilters() {
      for (const key of filterFields) {
        const filter = node(`rjFilter-${key}`);
        if (!filter) continue;
        if (['school', 'rank', 'certification', 'priority', 'source'].includes(key)) {
          const options = filterOptions(key);
          if (filters[key] && !options.some(([value]) => value === filters[key])) filters[key] = '';
          filter.innerHTML = '<option value="">All</option>' + options.map(([value, label]) =>
            `<option value="${esc(value)}"${filters[key] === value ? ' selected' : ''}>${esc(label)}</option>`).join('');
          filter.value = filters[key];
        } else if (key === 'flaggedForReview') {
          filter.innerHTML = '<option value="">All</option><option value="true">Flagged</option><option value="false">Not flagged</option>';
          filter.value = filters[key];
        } else filter.value = filters[key];
      }
    }
    function notice(message, error = false) { node('rjNotice').textContent = message; node('rjNotice').setAttribute('data-state', error ? 'error' : 'info'); }
    function controls() {
      ['rjAdd', 'rjPopulate', 'rjPopulateVolunteers', 'rjSave'].forEach((key) => { node(key).disabled = locked(); });
      node('rjDelete').disabled = locked() || !selected.size;
      node('rjClearReview').disabled = locked() || !data.judges.some((row) => selected.has(row.id) && row.flaggedForReview);
      node('rjDetailsEdit').disabled = locked();
      node('rjCancel').disabled = writing;
      node('rjReload').disabled = writing;
      const rows = visible(), count = rows.filter((row) => selected.has(row.id)).length;
      node('rjAll').disabled = locked() || !rows.length;
      node('rjAll').checked = rows.length > 0 && count === rows.length;
      node('rjAll').indeterminate = count > 0 && count < rows.length;
      [...fields.map((key) => `rj-${key}`), 'rj-flaggedForReview'].forEach((key) => { node(key).disabled = locked(); });
      volunteerFields.forEach((key) => { node(`rj-${key}`).disabled = locked() || node('rjVolunteerFields').hidden; });
      const linked = data?.judges.find((row) => row.id === id);
      node('rj-rank').disabled = locked() || Boolean(linked?.competitorId);
    }
    function render() {
      renderFilters();
      node('rjBody').innerHTML = visible().map((row) => `<tr><td><input type="checkbox" data-rj-select="${esc(row.id)}" aria-label="Select ${esc(row.name)}" ${locked() ? 'disabled' : ''} ${selected.has(row.id) ? 'checked' : ''}></td><td><a class="tournament-name" href="${locked() ? '#rjDetailsDialog' : '#rjDialog'}" data-rj-name="${esc(row.id)}" title="${locked() ? 'View judge details' : 'Edit Judge'}">${esc(row.name)}</a></td><td>${esc(row.associationNumber)}</td><td>${esc(row.school)}</td><td>${esc(rankLabel(row.rank))}</td><td>${esc(certLabel(row.certification))}</td><td class="rj-priority-column">${row.priority ?? 4}</td><td>${row.flaggedForReview ? 'Yes' : 'No'}</td><td>${row.volunteerId ? 'Volunteer' : row.competitorId === null ? 'Manual' : 'Competitor'}</td></tr>`).join('') ||
        `<tr><td colspan="9">${data ? 'No matching judges.' : 'Select a tournament to view judges.'}</td></tr>`;
      node('rjCount').textContent = data ? `${visible().length} of ${data.judges.length} judges · ${selected.size} selected` : '';
      controls();
    }
    function close() {
      if (writing || dirty() && !confirm('Discard unsaved judge changes?')) return false;
      editing = false; node('rjDialog').close(); node('rjDetailsDialog').close(); detailsId = ''; return true;
    }
    function details(row) {
      if (!row || writing || scope !== selectedEvent()) return;
      detailsId = row.id;
      node('rjDetailsTitle').textContent = row.name;
      node('rjDetailsContent').innerHTML = [
        ['TSD ID', row.associationNumber], ['School', row.school], ['Rank', rankLabel(row.rank)],
        ['Certification', certLabel(row.certification)], ['Priority', row.priority ?? 4],
        ['Flagged for Review', row.flaggedForReview ? 'Yes' : 'No'],
        ['Source', row.volunteerId ? 'Volunteer' : row.competitorId === null ? 'Manual' : 'Competitor'],
        ['Review Notes', row.reviewNotes]
      ].map(([label, value]) => `<dt>${label}</dt><dd>${esc(value)}</dd>`).join('');
      controls(); node('rjDetailsDialog').showModal(); node('rjDetailsClose').focus();
    }
    function open(row) {
      if (!data || writing) return;
      id = row ? row.id : '';
      const competitor = Boolean(row?.competitorId);
      node('rjVolunteerFields').hidden = competitor;
      const volunteer = data.volunteerDirectory?.volunteers.find((member) => member.id === row?.volunteerId);
      const types = data.volunteerDirectory?.types || [];
      const typeOptions = types.map((type) => `<option value="${esc(type.id)}">${esc(type.name)}</option>`).join('');
      node('rj-primaryType').innerHTML = '<option value="">Select first choice</option>' + typeOptions;
      node('rj-secondaryType').innerHTML = '<option value="">None</option>' + typeOptions;
      volunteerFields.forEach((key) => {
        node(`rj-${key}`).value = volunteer?.[key] ?? (key === 'primaryType' ? types.find((type) => type.name.toLowerCase() === 'judging')?.id || '' : '');
      });
      node('rj-age').required = !competitor;
      node('rj-primaryType').required = !competitor;
      node('rj-parentName').required = !competitor && node('rj-age').value !== '' && Number(node('rj-age').value) < 18;
      node('rjSourceHelp').textContent = competitor
        ? "Certification is checked against the competitor's saved rank and tournament-date age. Correct rank through registration."
        : 'Save validates this volunteer and updates both the volunteer and this judge. Judging must be First or Second Choice.';
      node('rj-rank').innerHTML = '<option value="">--</option>' + (data.judgeRanks || []).map((rank) => `<option value="${esc(rank.code)}">${esc(rank.label)}</option>`).join('');
      if (row && !(data.judgeRanks || []).some((rank) => rank.code === row.rank)) {
        node('rj-rank').innerHTML += `<option value="${esc(row.rank)}" disabled>${esc(row.rank)} (outside allowed range)</option>`;
      }
      const schoolNames = new Set(schools.filter((school) => !school.archived).map((school) => school.name));
      if (row && row.school) schoolNames.add(row.school);
      if (volunteer?.school) schoolNames.add(volunteer.school);
      node('rj-school').innerHTML = '<option value="">--</option>' + [...schoolNames].sort((a, b) => a.localeCompare(b))
        .map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
      node('rj-certification').innerHTML = (data.certificationLevels || []).map((level) => `<option value="${esc(level.code)}">${esc(level.label)}</option>`).join('');
      fields.forEach((key) => { node(`rj-${key}`).value = row ? row[key] ?? (key === 'priority' ? 4 : '') : key === 'certification' ? 'UNKNOWN' : key === 'priority' ? 4 : ''; });
      if (volunteer) {
        for (const key of ['firstName', 'lastName', 'associationNumber', 'school', 'rank', 'certification']) {
          node(`rj-${key}`).value = volunteer[key];
        }
      }
      if (row && !volunteer && row.firstName === undefined && row.lastName === undefined) {
        // Legacy judges stored only a display name; populated names use "Last, First".
        const comma = row.name.indexOf(',');
        const space = row.name.lastIndexOf(' ');
        node('rj-firstName').value = comma >= 0 ? row.name.slice(comma + 1).trim() : space >= 0 ? row.name.slice(0, space) : row.name;
        node('rj-lastName').value = comma >= 0 ? row.name.slice(0, comma).trim() : space >= 0 ? row.name.slice(space + 1) : '';
      }
      node('rj-flaggedForReview').checked = row ? row.flaggedForReview : false;
      node('rjDialogTitle').textContent = row ? 'Edit Judge' : 'Add Volunteer to Ring Judges';
      node('rjError').textContent = data.configurationLocked ? data.configurationLockReason || 'Read only. Reset Run before editing.' : '';
      editing = true; baseline = editorDraft(); controls();
      node('rjDialog').show(); node('rjCancel').focus();
    }
    async function load() {
      const current = ++token;
      scope = selectedEvent(); data = null; schools = []; query = ''; node('rjSearch').value = ''; selected.clear();
      filterFields.forEach((key) => { filters[key] = ''; });
      render();
      if (!scope) { notice('Select a tournament above.'); return; }
      notice('Loading ring judges...');
      try {
        const [result, directory] = await Promise.all([
          request(`/api/ring-judges?eventName=${encodeURIComponent(scope)}`), request('/api/schools')
        ]);
        if (current !== token || scope !== selectedEvent()) return;
        schools = directory.schools;
        data = result; data.judges.sort((a, b) => a.name.localeCompare(b.name)); render();
        notice(data.configurationLocked ? data.configurationLockReason || 'Ring Judges are locked. Reset Run before editing.' : 'Preparation directory only. Population does not certify judges or confirm availability; judge assignments remain Planned.');
      } catch (error) { if (current === token) notice(error.message, true); }
    }
    async function write(suffix, method, body, form = false) {
      if (locked()) return;
      const current = token, event = scope;
      writing = true; render();
      try {
        const result = await request(`/api/ring-judges${suffix}?eventName=${encodeURIComponent(event)}`,
          { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: data.revision, ...body }) });
        if (current !== token || event !== selectedEvent()) return;
        data = result; data.judges.sort((a, b) => a.name.localeCompare(b.name)); selected.clear();
        if (form) { editing = false; node('rjDialog').close(); }
        notice(suffix.startsWith('/populate') ? `Added ${result.added} judges; ${result.skipped} already listed. Certification and availability still require verification.` :
          form ? 'Judge saved.' : suffix === '/clear-review' ? 'Review flags cleared. Notes are unchanged.' : 'Selected judges deleted. Competitor registrations are unchanged.');
      } catch (error) {
        if (current === token) { if (form) node('rjError').textContent = error.message; else notice(error.message, true); }
      } finally { writing = false; if (current === token) render(); }
    }
    node('rjAdd').addEventListener('click', () => { if (!locked()) open(); });
    node('rjBody').addEventListener('click', (event) => {
      const target = event.target.closest('[data-rj-name]');
      if (!target || !data) return;
      event.preventDefault();
      const row = data.judges.find((row) => row.id === target.getAttribute('data-rj-name'));
      if (locked()) details(row);
      else if (row && !editing) open(row);
    });
    node('rjBody').addEventListener('dblclick', (event) => {
      const target = event.target.closest('[data-rj-name]');
      if (!target) return;
      event.preventDefault();
      if (!locked() && !editing) open(data.judges.find((row) => row.id === target.getAttribute('data-rj-name')));
    });
    node('rjBody').addEventListener('change', (event) => {
      if (locked()) return;
      const value = event.target.getAttribute('data-rj-select');
      if (!visible().some((row) => row.id === value)) return;
      if (event.target.checked) selected.add(value); else selected.delete(value);
      render();
    });
    node('rjAll').addEventListener('change', () => {
      if (locked()) return;
      const all = node('rjAll').checked; selected.clear();
      if (all) visible().forEach((row) => selected.add(row.id));
      render();
    });
    node('rjSearchForm').addEventListener('submit', (event) => {
      event.preventDefault(); query = node('rjSearch').value.trim().toLowerCase(); selected.clear(); render();
    });
    for (const key of filterFields) {
      node(`rjFilter-${key}`).addEventListener(['name', 'associationNumber'].includes(key) ? 'input' : 'change', (event) => {
        filters[key] = event.target.value.trim();
        selected.clear(); render();
      });
    }
    node('rjClearFilters').addEventListener('click', () => {
      query = ''; node('rjSearch').value = '';
      filterFields.forEach((key) => { filters[key] = ''; });
      selected.clear(); render();
    });
    node('rjDelete').addEventListener('click', () => {
      if (!locked() && selected.size && confirm(`Delete ${selected.size} selected judges from ${scope}? Competitor registrations remain unchanged.`)) return write('/delete', 'POST', { ids: [...selected] });
    });
    node('rjClearReview').addEventListener('click', () => {
      if (locked()) return;
      const ids = data.judges.filter((row) => selected.has(row.id) && row.flaggedForReview).map((row) => row.id);
      if (ids.length && confirm(`Clear the review flag for ${ids.length} selected judges? Review notes will be kept.`)) return write('/clear-review', 'POST', { ids });
    });
    node('rjDetailsEdit').addEventListener('click', () => {
      if (locked()) return;
      const row = data.judges.find((row) => row.id === detailsId);
      if (close()) open(row);
    });
    node('rjDetailsClose').addEventListener('click', close);
    node('rjDetailsDialog').addEventListener('cancel', (event) => { event.preventDefault(); close(); });
    node('rjPopulate').addEventListener('click', () => {
      if (!locked() && confirm(`Add Dan-ranked competitors aged 18+ and other competitors who meet SK/TK age and rank requirements to Ring Judges for ${scope}? Certification stays Unknown and SK/TK eligibility is noted. Existing entries will not be overwritten.`)) return write('/populate', 'POST', {});
    });
    node('rjPopulateVolunteers').addEventListener('click', () => {
      if (!locked() && confirm(`Add primary or secondary Judging volunteers who are Dan-ranked and aged 18+, or have SK/TK certification and meet its rank and age requirements, for ${scope}? Existing entries will not be overwritten.`)) return write('/populate-volunteers', 'POST', {});
    });
    node('rj-age').addEventListener('input', () => {
      node('rj-parentName').required = node('rj-age').value !== '' && Number(node('rj-age').value) < 18;
    });
    node('rjForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const body = { judge: draft() };
      if (!node('rjVolunteerFields').hidden) {
        body.volunteer = volunteerDraft();
        body.volunteerRevision = data.volunteerDirectory.revision;
      }
      return write(id ? `/${encodeURIComponent(id)}` : '', id ? 'PUT' : 'POST', body, true);
    });
    node('rjCancel').addEventListener('click', close);
    node('rjDialog').addEventListener('cancel', (event) => { event.preventDefault(); close(); });
    node('rjDialog').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    });
    node('rjReload').addEventListener('click', () => { if (close()) return load(); });
    return { load, dirty, busy: () => writing, canLeave: close, leave: () => { ++token; } };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
  else root.RingJudgesWorkspace = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
