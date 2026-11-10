(function (root) {
  function create({ document, request, selectedEvent, confirm, print = () => root.print(), onChange = async () => {} }) {
    const node = (id) => document.getElementById(id);
    const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fields = ['firstName', 'lastName', 'age', 'associationNumber', 'school', 'rank', 'certification', 'primaryType', 'secondaryType', 'parentName', 'contactNumber'];
    const certLabel = (code) => (data && data.certificationLevels || []).find((level) => level.code === code)?.label || code || 'Unknown';
    const rankLabel = (code) => (data?.rankOptions || []).find((rank) => rank.code === code)?.label || code;
    const typeName = (id) => data?.types.find((row) => row.id === id)?.name || '';
    const filterLabels = { school: 'Studio', rank: 'Rank', certification: 'Certification', primaryType: 'First choice', secondaryType: 'Second choice' };
    const dropdowns = ['school', 'rank', 'primaryType', 'secondaryType', 'certification'];
    const filters = Object.fromEntries(Object.keys(filterLabels).map((key) => [key, '']));
    const fullName = (row) => `${row.lastName}, ${row.firstName}`;
    const contains = (value, text) => String(value ?? '').toLowerCase().includes(text.toLowerCase());
    let data = null, scope = '', kind = 'volunteers', token = 0, writing = false, reading = false, editing = false, id = '', baseline = '', query = '';
    const selected = new Set();
    const draft = () => kind === 'volunteer-types' ? { name: node('vm-typeName').value } : {
      ...Object.fromEntries(fields.map((key) => [key, key === 'age' ? Number(node(`vm-${key}`).value) : node(`vm-${key}`).value])), ageAsOf: data.tournamentDate };
    const dirty = () => editing && JSON.stringify(draft()) !== baseline;
    const locked = () => !data || writing || reading || data.configurationLocked || scope !== selectedEvent();
    const rows = () => data ? (kind === 'volunteer-types' ? data.types : data.volunteers).filter((row) =>
      (kind === 'volunteer-types' ? [row.name] : [fullName(row), `${row.firstName} ${row.lastName}`, row.associationNumber, row.contactNumber])
        .some((value) => contains(value, query)) && (kind === 'volunteer-types' ||
      dropdowns.every((key) => !filters[key] || (row[key] || (key === 'certification' ? 'UNKNOWN' : '')) === filters[key]))) : [];
    function renderFilters() {
      for (const key of dropdowns) {
        const values = [...new Set((data?.volunteers || []).map((row) => row[key] || (key === 'certification' ? 'UNKNOWN' : '')).filter(Boolean))].sort();
        if (filters[key] && !values.includes(filters[key])) values.push(filters[key]);
        const label = (value) => key === 'certification' ? certLabel(value) : key === 'rank' ? rankLabel(value) : key.endsWith('Type') ? typeName(value) : value;
        node(`vmFilter-${key}`).innerHTML = '<option value="">All</option>' +
          values.map((value) => `<option value="${esc(value)}">${esc(label(value))}</option>`).join('');
        node(`vmFilter-${key}`).value = filters[key];
      }
    }
    function resetFilters() {
      query = ''; node('vmSearch').value = '';
      for (const key of Object.keys(filters)) { filters[key] = ''; node(`vmFilter-${key}`).value = ''; }
      selected.clear();
    }
    function notice(text, error = false) { node('vmNotice').textContent = text; node('vmNotice').setAttribute('data-state', error ? 'error' : 'info'); }
    function controls() {
      ['vmAdd', 'vmSave', 'vmImport', 'vmCsv'].forEach((key) => { node(key).disabled = locked(); });
      node('vmDelete').disabled = locked() || !selected.size; node('vmCancel').disabled = writing;
      node('vmReload').disabled = writing || reading;
      node('vmPrint').disabled = !data || writing || reading || scope !== selectedEvent() || !rows().length;
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
      node('vmPrint').hidden = types;
      node('vmColumnFilters').hidden = types;
      node('vmSearch').placeholder = types ? 'Volunteer type name' : 'Name, membership number or contact';
      for (let i = 0; i < 7; i++) node(`vmCol${i}`).hidden = types;
      renderFilters();
      node('vmBody').innerHTML = rows().map((row) => `<tr><td><input type="checkbox" data-vm-select="${esc(row.id)}" aria-label="Select ${esc(types ? row.name : fullName(row))}" ${selected.has(row.id) ? 'checked' : ''} ${locked() ? 'disabled' : ''}></td><td><button class="tournament-name" type="button" data-vm-edit="${esc(row.id)}">${esc(types ? row.name : fullName(row))}</button></td>${types ? '' : [row.contactNumber || '', typeName(row.primaryType), typeName(row.secondaryType),       row.school, rankLabel(row.rank), certLabel(row.certification), row.associationNumber].map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('') ||
        `<tr><td colspan="${types ? 2 : 9}">${data ? 'No matching entries.' : 'Select a tournament above.'}</td></tr>`;
      node('vmCount').textContent = `${rows().length} of ${data ? (types ? data.types : data.volunteers).length : 0} ${types ? 'types' : 'volunteers'} · ${selected.size} selected`; controls();
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
      node('vm-certification').innerHTML = (data.certificationLevels || []).map((level) => `<option value="${esc(level.code)}">${esc(level.label)}</option>`).join('');
      const ranks = (data.rankOptions || []).filter((rank) => rank.code !== 'D8');
      node('vm-rank').innerHTML = '<option value="">Select rank</option>' + ranks.map((rank) =>
        `<option value="${esc(rank.code)}">${esc(rank.label)}</option>`).join('');
      if (row && !types && !ranks.some((rank) => rank.code === row.rank)) {
        node('vm-rank').innerHTML += `<option value="${esc(row.rank)}">${esc(rankLabel(row.rank))} (saved rank outside editor range)</option>`;
      }
      fields.forEach((key) => { node(`vm-${key}`).value = row && !types ? row[key] ?? '' : key === 'primaryType' ? data.types[0]?.id || '' : key === 'certification' ? 'UNKNOWN' : ''; });
      node('vm-associationNumber').required = data.eventScope !== 'in-house';
      node('vm-parentName').required = !types && node('vm-age').value !== '' && Number(node('vm-age').value) < 18;
      node('vm-typeName').value = types && row ? row.name : '';
      node('vmDialogTitle').textContent = `${row ? 'Edit' : 'Add'} ${types ? 'Volunteer Type' : 'Volunteer'}`;
      node('vmError').textContent = data.configurationLocked ? 'Read only. Reset Run before editing.' : '';
      editing = true; baseline = JSON.stringify(draft()); node('vmDialog').showModal(); node('vmCancel').focus();
    }
    async function load(nextKind = kind) {
      const reset = scope !== selectedEvent() || kind !== nextKind;
      kind = nextKind; const current = ++token;
      scope = selectedEvent(); data = null;
      if (reset) resetFilters();
      selected.clear(); node('vmCsv').value = ''; render();
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
        notice(url.endsWith('/import') ? `Imported: ${result.added} added, ${result.updated} updated.${result.unrecognizedCertifications ? ` ${result.unrecognizedCertifications} unrecognized certification value(s) stored as Unknown.` : ''}` : 'Volunteer management saved.');
        await onChange();
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
    for (const key of Object.keys(filters)) {
      node(`vmFilter-${key}`).addEventListener(dropdowns.includes(key) ? 'change' : 'input', () => {
        filters[key] = node(`vmFilter-${key}`).value.trim();
        selected.clear(); render();
      });
    }
    node('vmClearFilters').addEventListener('click', () => { resetFilters(); render(); });
    node('vm-age').addEventListener('input', () => {
      node('vm-parentName').required = node('vm-age').value !== '' && Number(node('vm-age').value) < 18;
    });
    node('vmPrint').addEventListener('click', () => {
      if (!data || kind !== 'volunteers' || writing || reading || scope !== selectedEvent() || !rows().length) return;
      const activeFilters = Object.entries(filters).filter(([, value]) => value).map(([key, value]) =>
        `${filterLabels[key]}: ${key === 'certification' ? certLabel(value) : key.endsWith('Type') ? typeName(value) : value}`);
      if (query) activeFilters.unshift(`Search: ${query}`);
      const report = node('vmPrintReport');
      report.innerHTML = `<h1>${esc(scope)} - Volunteers</h1><p>${rows().length} volunteer${rows().length === 1 ? '' : 's'}</p><p>${esc(activeFilters.join('; ') || 'All volunteers')}</p>` +
        '<table><thead><tr><th>Name</th><th>Contact number</th><th>First choice</th><th>Second choice</th><th>Certification</th></tr></thead><tbody>' +
        rows().map((row) => `<tr>${[fullName(row), row.contactNumber || '', typeName(row.primaryType), typeName(row.secondaryType), certLabel(row.certification)]
          .map((value) => `<td>${esc(value)}</td>`).join('')}</tr>`).join('') + '</tbody></table>';
      document.body.classList.add('vm-printing');
      try { print(); }
      catch (error) { notice(`Unable to print volunteers: ${error.message}`, true); }
      finally { document.body.classList.remove('vm-printing'); report.innerHTML = ''; }
    });
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
