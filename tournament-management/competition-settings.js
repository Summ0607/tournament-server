(function (root) {
  const rules = typeof module !== 'undefined' && module.exports ? require('../assets/competition-settings') : root.CompetitionSettingsRules;
  function create({ document, request, selectedEvent, confirm }) {
    const node = (id) => document.getElementById(id);
    const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    let kind = '', scope = '', data = null, token = 0, writing = false, editing = false, id = '', baseline = '';
    const selected = new Set();
    function draft() {
      return Object.fromEntries(rules.schemas[kind].fields.map(([key, , type]) => [key,
        type === 'boolean' ? node(`cs-${key}`).checked : ['age', 'points'].includes(type) ? Number(node(`cs-${key}`).value) : node(`cs-${key}`).value]));
    }
    const dirty = () => editing && JSON.stringify(draft()) !== baseline;
    function notice(text, error = false) { node('csNotice').textContent = text; node('csNotice').setAttribute('data-state', error ? 'error' : 'info'); }
    function locked() { return !data || writing || data.configurationLocked || scope !== selectedEvent(); }
    function controls() {
      node('csAdd').disabled = locked();
      node('csDelete').disabled = locked() || !selected.size;
      node('csSave').disabled = locked();
      node('csCancel').disabled = writing;
      node('csAll').disabled = locked() || !data.rows.length;
      node('csAll').checked = Boolean(data && data.rows.length && selected.size === data.rows.length);
      node('csAll').indeterminate = Boolean(selected.size && data && selected.size < data.rows.length);
      node('csReload').disabled = writing;
    }
    function render() {
      const schema = rules.schemas[kind];
      const columns = kind === 'grand-champion-categories'
        ? [['name', 'Name'], ['gender', 'Gender'], ['ageRange', 'Age Range'], ['rankRange', 'Rank Range (Codes)']] : schema.fields;
      node('csHead').innerHTML = `<th><input id="csAll" type="checkbox" aria-label="Select all entries"></th>` +
        columns.map(([, label]) => `<th>${label}</th>`).join('');
      node('csBody').innerHTML = data ? data.rows.map((row) => `<tr><td><input type="checkbox" data-cs-select="${esc(row.id)}" aria-label="Select ${esc(row.name)}" ${selected.has(row.id) ? 'checked' : ''} ${locked() ? 'disabled' : ''}></td>` +
        columns.map(([key, , type]) => `<td>${key === 'name' ? `<button type="button" class="tournament-name" data-cs-edit="${esc(row.id)}" ${locked() ? 'disabled' : ''}>${esc(row[key])}</button>` : esc(key === 'ageRange' ? `${row.minAge} - ${row.maxAge}` : key === 'rankRange' ? `${row.minRank} - ${row.maxRank}` : type === 'boolean' ? row[key] ? 'Yes' : 'No' : row[key])}</td>`).join('') + '</tr>').join('') ||
        `<tr><td colspan="${columns.length + 1}">No entries yet.</td></tr>` : `<tr><td colspan="${columns.length + 1}">Select a tournament to view settings.</td></tr>`;
      node('csAll').addEventListener('change', () => {
        if (locked()) return;
        const all = node('csAll').checked; selected.clear();
        if (all) data.rows.forEach((row) => selected.add(row.id));
        render();
      });
      controls();
    }
    function close() {
      if (writing || dirty() && !confirm('Discard unsaved competition settings changes?')) return false;
      editing = false; node('csDialog').close(); return true;
    }
    function open(row) {
      if (locked()) return;
      id = row ? row.id : '';
      const schema = rules.schemas[kind];
      node('csDialogTitle').textContent = `${row ? 'Edit' : 'Add'} ${schema.singular}`;
      node('csFields').innerHTML = schema.fields.map(([key, label, type]) => {
        const options = type === 'gender' ? ['F', 'M'] : rules.rankCodes;
        const input = ['gender', 'rank'].includes(type) ? `<select id="cs-${key}">${options.map((value) => `<option value="${value}">${value}</option>`).join('')}</select>` :
          `<input id="cs-${key}" type="${type === 'boolean' ? 'checkbox' : ['age', 'points'].includes(type) ? 'number' : 'text'}" ${['age', 'points'].includes(type) ? `min="0" max="${type === 'age' ? 120 : 10000}" step="1"` : 'maxlength="1000"'} ${type === 'text' && key !== 'description' || ['age', 'points'].includes(type) ? 'required' : ''}>`;
        return `<label>${label}${input}</label>`;
      }).join('');
      schema.fields.forEach(([key, , type]) => {
        if (type === 'boolean') node(`cs-${key}`).checked = row ? row[key] : false;
        else node(`cs-${key}`).value = row ? row[key] : type === 'gender' ? 'F' : type === 'rank' ? 'G10' : ['age', 'points'].includes(type) ? 0 : '';
      });
      node('csError').textContent = '';
      editing = true; baseline = JSON.stringify(draft());
      node('csDialog').showModal(); node('cs-name').focus();
    }
    async function load(nextKind = kind) {
      kind = nextKind;
      const current = ++token;
      scope = selectedEvent(); data = null; selected.clear();
      node('csAdd').textContent = `Add ${rules.schemas[kind].singular}`;
      render();
      if (!scope) { notice('Select a tournament above.'); return; }
      notice('Loading competition settings...');
      try {
        const result = await request(`/api/competition-settings/${kind}?eventName=${encodeURIComponent(scope)}`);
        if (current !== token || scope !== selectedEvent()) return;
        data = result; render();
        notice(data.configurationLocked ? data.configurationLockReason || 'Tournament settings are locked.' : 'Reference settings only; live scoring and divisions are unchanged.');
      } catch (error) { if (current === token) notice(error.message, true); }
    }
    async function write(suffix, method, body, form) {
      if (locked()) return;
      writing = true;
      const requestToken = token, event = scope;
      controls();
      try {
        const result = await request(`/api/competition-settings/${kind}${suffix}?eventName=${encodeURIComponent(event)}`,
          { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: data.revision, ...body }) });
        if (requestToken !== token || event !== selectedEvent()) return;
        data = result; selected.clear();
        if (form) { editing = false; node('csDialog').close(); }
        notice('Competition settings saved. Live scoring and divisions are unchanged.');
      } catch (error) {
        if (requestToken === token) {
          if (form) node('csError').textContent = error.message; else notice(error.message, true);
        }
      } finally { writing = false; if (requestToken === token) render(); }
    }
    node('csAdd').addEventListener('click', () => open());
    node('csBody').addEventListener('click', (event) => {
      const target = event.target.closest('[data-cs-edit]');
      if (target && data) open(data.rows.find((row) => row.id === target.getAttribute('data-cs-edit')));
    });
    node('csBody').addEventListener('change', (event) => {
      if (locked()) return;
      const value = event.target.getAttribute('data-cs-select');
      if (!data.rows.some((row) => row.id === value)) return;
      if (event.target.checked) selected.add(value); else selected.delete(value);
      controls();
    });
    node('csDelete').addEventListener('click', () => {
      if (!locked() && selected.size && confirm(`Delete ${selected.size} selected reference entries for ${scope}?`)) return write('/delete', 'POST', { ids: [...selected] }, false);
    });
    node('csForm').addEventListener('submit', (event) => {
      event.preventDefault();
      let row;
      try { row = rules.validate(kind, draft()); }
      catch (error) { node('csError').textContent = error.message; return; }
      return write(id ? `/${encodeURIComponent(id)}` : '', id ? 'PUT' : 'POST', { row }, true);
    });
    node('csCancel').addEventListener('click', close);
    node('csDialog').addEventListener('cancel', (event) => { event.preventDefault(); close(); });
    node('csDialog').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    });
    node('csReload').addEventListener('click', () => { if (!writing && close()) return load(); });
    return { load, dirty, busy: () => writing, canLeave: () => !editing || close(), leave: () => { ++token; } };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
  else root.CompetitionSettingsWorkspace = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
