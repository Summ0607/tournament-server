(function (root) {
  function create({ document, request, selectedEvent, confirm }) {
    const node = (id) => document.getElementById(id);
    const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fields = ['name', 'associationNumber', 'school', 'rank', 'certification', 'reviewNotes'];
    let data = null, scope = '', token = 0, writing = false, editing = false, id = '', baseline = '', query = '';
    const selected = new Set();
    const draft = () => ({ ...Object.fromEntries(fields.map((key) => [key, node(`rj-${key}`).value])), flaggedForReview: node('rj-flaggedForReview').checked });
    const dirty = () => editing && JSON.stringify(draft()) !== baseline;
    const locked = () => !data || writing || data.configurationLocked || scope !== selectedEvent();
    const visible = () => data ? data.judges.filter((row) => [row.name, row.associationNumber, row.school, row.rank, row.certification, row.reviewNotes]
      .some((value) => value.toLowerCase().includes(query))) : [];
    function notice(message, error = false) { node('rjNotice').textContent = message; node('rjNotice').setAttribute('data-state', error ? 'error' : 'info'); }
    function controls() {
      ['rjAdd', 'rjPopulate', 'rjPopulateVolunteers', 'rjSave'].forEach((key) => { node(key).disabled = locked(); });
      node('rjDelete').disabled = locked() || !selected.size;
      node('rjCancel').disabled = writing;
      node('rjReload').disabled = writing;
      const rows = visible(), count = rows.filter((row) => selected.has(row.id)).length;
      node('rjAll').disabled = locked() || !rows.length;
      node('rjAll').checked = rows.length > 0 && count === rows.length;
      node('rjAll').indeterminate = count > 0 && count < rows.length;
      [...fields.map((key) => `rj-${key}`), 'rj-flaggedForReview'].forEach((key) => { node(key).disabled = locked(); });
    }
    function render() {
      node('rjBody').innerHTML = visible().map((row) => `<tr><td><input type="checkbox" data-rj-select="${esc(row.id)}" aria-label="Select ${esc(row.name)}" ${selected.has(row.id) ? 'checked' : ''} ${locked() ? 'disabled' : ''}></td><td><button class="tournament-name" type="button" data-rj-edit="${esc(row.id)}">${esc(row.name)}</button></td><td>${esc(row.associationNumber)}</td><td>${esc(row.school)}</td><td>${esc(row.rank)}</td><td>${esc(row.certification)}</td><td>${row.flaggedForReview ? 'Yes' : 'No'}</td><td>${esc(row.reviewNotes)}</td><td>${row.volunteerId ? 'Volunteer' : row.competitorId === null ? 'Manual' : 'Competitor'}</td></tr>`).join('') ||
        `<tr><td colspan="9">${data ? 'No matching judges.' : 'Select a tournament to view judges.'}</td></tr>`;
      node('rjCount').textContent = data ? `${visible().length} of ${data.judges.length} judges · ${selected.size} selected` : '';
      controls();
    }
    function close() {
      if (writing || dirty() && !confirm('Discard unsaved judge changes?')) return false;
      editing = false; node('rjDialog').close(); return true;
    }
    function open(row) {
      if (!data || writing) return;
      id = row ? row.id : '';
      fields.forEach((key) => { node(`rj-${key}`).value = row ? row[key] : key === 'rank' ? 'D1' : ''; });
      node('rj-flaggedForReview').checked = row ? row.flaggedForReview : false;
      node('rjDialogTitle').textContent = row ? 'Edit Judge' : 'Add Judge';
      node('rjError').textContent = data.configurationLocked ? data.configurationLockReason || 'Read only. Reset Run before editing.' : '';
      editing = true; baseline = JSON.stringify(draft()); controls();
      node('rjDialog').showModal(); node('rjCancel').focus();
    }
    async function load() {
      const current = ++token;
      scope = selectedEvent(); data = null; query = ''; node('rjSearch').value = ''; selected.clear(); render();
      if (!scope) { notice('Select a tournament above.'); return; }
      notice('Loading ring judges...');
      try {
        const result = await request(`/api/ring-judges?eventName=${encodeURIComponent(scope)}`);
        if (current !== token || scope !== selectedEvent()) return;
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
          form ? 'Judge saved.' : 'Selected judges deleted. Competitor registrations are unchanged.');
      } catch (error) {
        if (current === token) { if (form) node('rjError').textContent = error.message; else notice(error.message, true); }
      } finally { writing = false; if (current === token) render(); }
    }
    node('rjAdd').addEventListener('click', () => { if (!locked()) open(); });
    node('rjBody').addEventListener('click', (event) => {
      const target = event.target.closest('[data-rj-edit]');
      if (target && data) open(data.judges.find((row) => row.id === target.getAttribute('data-rj-edit')));
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
    node('rjDelete').addEventListener('click', () => {
      if (!locked() && selected.size && confirm(`Delete ${selected.size} selected judges from ${scope}? Competitor registrations remain unchanged.`)) return write('/delete', 'POST', { ids: [...selected] });
    });
    node('rjPopulate').addEventListener('click', () => {
      if (!locked() && confirm(`Add Dan-ranked competitors aged 18 or older on the tournament date to Ring Judges for ${scope}? Existing judges will not be overwritten. This does not certify judges or confirm availability.`)) return write('/populate', 'POST', {});
    });
    node('rjPopulateVolunteers').addEventListener('click', () => {
      if (!locked() && confirm(`Add primary or secondary Judging volunteers who are Dan-ranked and aged 18+ on the tournament date for ${scope}? Existing judges will not be overwritten. Availability and certification still require verification.`)) return write('/populate-volunteers', 'POST', {});
    });
    node('rjForm').addEventListener('submit', (event) => { event.preventDefault(); return write(id ? `/${encodeURIComponent(id)}` : '', id ? 'PUT' : 'POST', { judge: draft() }, true); });
    node('rjCancel').addEventListener('click', close);
    node('rjDialog').addEventListener('cancel', (event) => { event.preventDefault(); close(); });
    node('rjDialog').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    });
    node('rjReload').addEventListener('click', () => { if (close()) return load(); });
    return { load, dirty, busy: () => writing, canLeave: () => !editing || close(), leave: () => { ++token; } };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
  else root.RingJudgesWorkspace = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
