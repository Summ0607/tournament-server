(function (root) {
  function create({ document, request, selectedEvent, confirm }) {
    const node = (id) => document.getElementById(id);
    const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fields = ['firstName', 'lastName', 'age', 'associationNumber', 'school', 'rank', 'certification', 'primaryType', 'secondaryType'];
    let data = null, scope = '', kind = 'volunteers', token = 0, writing = false, reading = false, editing = false, id = '', baseline = '', query = '';
    const selected = new Set();
    const draft = () => kind === 'volunteer-types' ? { name: node('vm-typeName').value } : {
      ...Object.fromEntries(fields.map((key) => [key, key === 'age' ? Number(node(`vm-${key}`).value) : node(`vm-${key}`).value])), ageAsOf: data.tournamentDate };
    const dirty = () => editing && JSON.stringify(draft()) !== baseline;
    const locked = () => !data || writing || reading || data.configurationLocked || scope !== selectedEvent();
    const rows = () => data ? (kind === 'volunteer-types' ? data.types : data.volunteers).filter((row) => [
      ...Object.values(row), ...data.types.filter((type) => type.id === row.primaryType || type.id === row.secondaryType).map((type) => type.name)
    ].some((v) => String(v).toLowerCase().includes(query))) : [];
    function notice(text, error = false) { node('vmNotice').textContent = text; node('vmNotice').setAttribute('data-state', error ? 'error' : 'info'); }
    function controls() {
      ['vmAdd', 'vmSave', 'vmImport', 'vmCsv'].forEach((key) => { node(key).disabled = locked(); });
      node('vmDelete').disabled = locked() || !selected.size; node('vmCancel').disabled = writing;
      node('vmReload').disabled = writing || reading;
      fields.forEach((key) => { node(`vm-${key}`).disabled = kind === 'volunteer-types' || locked(); });
      node('vm-typeName').disabled = kind !== 'volunteer-types' || locked();
      const visible = rows(), count = visible.filter((row) => selected.has(row.id)).length;
      node('vmAll').disabled = locked() || !visible.length;
      node('vmAll').checked = visible.length > 0 && count === visible.length;
      node('vmAll').indeterminate = count > 0 && count < visible.length;
    }
    function render() {
      const types = kind === 'volunteer-types';
      node('vmAdd').textContent = types ? 'Add Volunteer Type' : 'Add Volunteer';
      node('vmImportArea').hidden = types;
      for (let i = 0; i < 7; i++) node(`vmCol${i}`).hidden = types;
      const typeName = (id) => data.types.find((row) => row.id === id)?.name || '';
      node('vmBody').innerHTML = rows().map((row) => `<tr><td><input type="checkbox" data-vm-select="${esc(row.id)}" aria-label="Select ${esc(types ? row.name : `${row.lastName}, ${row.firstName}`)}" ${selected.has(row.id) ? 'checked' : ''} ${locked() ? 'disabled' : ''}></td><td><button class="tournament-name" type="button" data-vm-edit="${esc(row.id)}">${esc(types ? row.name : `${row.lastName}, ${row.firstName}`)}</button></td>${types ? '' : [row.age, row.associationNumber, row.school, row.rank, row.certification, typeName(row.primaryType), typeName(row.secondaryType)].map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('') ||
        `<tr><td colspan="${types ? 2 : 9}">${data ? 'No matching entries.' : 'Select a tournament above.'}</td></tr>`;
      node('vmCount').textContent = `${rows().length} shown · ${selected.size} selected`; controls();
    }
    function close() {
      if (writing || dirty() && !confirm('Discard unsaved volunteer changes?')) return false;
      editing = false; node('vmDialog').close(); return true;
    }
    function open(row) {
      if (!data || writing || reading) return;
      const types = kind === 'volunteer-types'; id = row ? row.id : '';
      node('vmTypeFields').hidden = !types; node('vmVolunteerFields').hidden = types;
      node('vm-typeName').disabled = !types || locked(); node('vm-typeName').required = types;
      fields.forEach((key) => { node(`vm-${key}`).disabled = types || locked(); });
      const options = data.types.map((type) => `<option value="${esc(type.id)}">${esc(type.name)}</option>`).join('');
      node('vm-primaryType').innerHTML = options; node('vm-secondaryType').innerHTML = '<option value="">None</option>' + options;
      fields.forEach((key) => { node(`vm-${key}`).value = row && !types ? row[key] : key === 'primaryType' ? data.types[0]?.id || '' : ''; });
      node('vm-typeName').value = types && row ? row.name : '';
      node('vmDialogTitle').textContent = `${row ? 'Edit' : 'Add'} ${types ? 'Volunteer Type' : 'Volunteer'}`;
      node('vmError').textContent = data.configurationLocked ? 'Read only. Reset Run before editing.' : '';
      editing = true; baseline = JSON.stringify(draft()); node('vmDialog').showModal(); node('vmCancel').focus();
    }
    async function load(nextKind = kind) {
      kind = nextKind; const current = ++token;
      scope = selectedEvent(); data = null; query = ''; node('vmSearch').value = ''; node('vmCsv').value = ''; selected.clear(); render();
      if (!scope) { notice('Select a tournament above.'); return; }
      notice('Loading volunteer management...');
      try {
        const result = await request(`/api/volunteers?eventName=${encodeURIComponent(scope)}`);
        if (current !== token || scope !== selectedEvent()) return;
        data = result; render(); notice(data.configurationLocked ? data.configurationLockReason || 'Preparation is locked. Reset Run before editing.' : 'Tournament preparation. CSV imports add/update by Assoc ID; blank IDs always add new volunteers.');
      } catch (error) { if (current === token) notice(error.message, true); }
    }
    async function write(url, body, method = 'POST', form = false) {
      if (locked()) return;
      const current = token, event = scope;
      writing = true; render();
      try {
        const result = await request(`${url}?eventName=${encodeURIComponent(event)}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: data.revision, ...body }) });
        if (current !== token || event !== selectedEvent()) return;
        data = result; selected.clear();
        if (form) { editing = false; node('vmDialog').close(); }
        notice(url.endsWith('/import') ? `Imported: ${result.added} added, ${result.updated} updated.` : 'Volunteer management saved.');
      } catch (error) { if (current === token) { if (form) node('vmError').textContent = error.message; else notice(error.message, true); } }
      finally { writing = false; if (current === token) render(); }
    }
    node('vmAdd').addEventListener('click', () => { if (!locked()) open(); });
    node('vmBody').addEventListener('click', (event) => {
      const target = event.target.closest('[data-vm-edit]');
      if (target) open(rows().find((row) => row.id === target.getAttribute('data-vm-edit')));
    });
    node('vmBody').addEventListener('change', (event) => {
      if (locked()) return;
      const id = event.target.getAttribute('data-vm-select');
      if (!rows().some((row) => row.id === id)) return;
      if (event.target.checked) selected.add(id); else selected.delete(id); render();
    });
    node('vmAll').addEventListener('change', () => {
      if (locked()) return;
      const checked = node('vmAll').checked; selected.clear(); if (checked) rows().forEach((row) => selected.add(row.id)); render();
    });
    node('vmSearchForm').addEventListener('submit', (event) => { event.preventDefault(); query = node('vmSearch').value.trim().toLowerCase(); selected.clear(); render(); });
    node('vmForm').addEventListener('submit', (event) => { event.preventDefault(); return write(`/api/${kind}${id ? `/${encodeURIComponent(id)}` : ''}`, kind === 'volunteer-types' ? draft() : { volunteer: draft() }, id ? 'PUT' : 'POST', true); });
    node('vmDelete').addEventListener('click', () => {
      if (!locked() && selected.size && confirm(`Delete ${selected.size} selected ${kind === 'volunteer-types' ? 'volunteer types' : 'volunteers'}? Types in use cannot be deleted. Existing judges are not changed.`)) return write(`/api/${kind}/delete`, { ids: [...selected] });
    });
    node('vmImport').addEventListener('click', async () => {
      if (locked()) return;
      const file = node('vmCsv').files[0];
      if (!file || file.size > 2 * 1024 * 1024) { notice('Choose a CSV file of at most 2 MB.', true); return; }
      if (!confirm('Import CSV? Matching Assoc IDs will be updated. Blank IDs always add new records. The whole file must validate before saving.')) return;
      const current = token; reading = true; controls();
      let text;
      try { text = await file.text(); } catch (error) { notice(`Unable to read CSV: ${error.message}`, true); }
      finally { reading = false; controls(); }
      if (text !== undefined && current === token) return write('/api/volunteers/import', { csv: text });
    });
    node('vmCancel').addEventListener('click', close);
    node('vmDialog').addEventListener('cancel', (event) => { event.preventDefault(); close(); });
    node('vmDialog').addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } });
    node('vmReload').addEventListener('click', () => { if (close()) return load(); });
    return { load, dirty, busy: () => writing || reading, canLeave: () => !editing || close(), leave: () => { ++token; } };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
  else root.VolunteersWorkspace = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
