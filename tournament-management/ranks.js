(function (root) {
  function create({ document, request, confirm }) {
    const node = (id) => document.getElementById(id);
    const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    let ranks = [], ready = false, writing = false, token = 0, editing = false, id = '', baseline = '';
    const selected = new Set();
    const fields = ['name', 'code', 'belt', 'alternateNames', 'sortWeight'];
    const draft = () => Object.fromEntries(fields.map((key) => [key, key === 'sortWeight' ? Number(node(`rank-${key}`).value) : node(`rank-${key}`).value]));
    const dirty = () => editing && JSON.stringify(draft()) !== baseline;
    function notice(message, error = false) {
      node('ranksNotice').textContent = message;
      node('ranksNotice').setAttribute('data-state', error ? 'error' : 'info');
    }
    function controls() {
      node('addRank').disabled = !ready || writing;
      node('deleteRanks').disabled = !ready || writing || !selected.size;
      node('rankSave').disabled = writing;
      node('rankCancel').disabled = writing;
      node('ranksSelectAll').disabled = !ready || writing || !ranks.length;
      node('ranksSelectAll').checked = ranks.length > 0 && selected.size === ranks.length;
      node('ranksSelectAll').indeterminate = selected.size > 0 && selected.size < ranks.length;
      fields.forEach((key) => { node(`rank-${key}`).disabled = writing; });
    }
    function render() {
      ranks.sort((a, b) => b.sortWeight - a.sortWeight || a.name.localeCompare(b.name));
      node('ranksBody').innerHTML = ranks.map((rank) => `<tr><td><input type="checkbox" data-rank-select="${esc(rank.id)}" aria-label="Select ${esc(rank.name)}" ${selected.has(rank.id) ? 'checked' : ''} ${writing ? 'disabled' : ''}></td><td><button class="tournament-name" type="button" data-rank="${esc(rank.id)}" ${writing ? 'disabled' : ''}>${esc(rank.name)}</button></td><td>${esc(rank.code)}</td><td>${esc(rank.belt)}</td><td>${esc(rank.alternateNames)}</td><td>${rank.sortWeight}</td></tr>`).join('') || '<tr><td colspan="6">No ranks yet.</td></tr>';
      controls();
    }
    function close() {
      if (writing || dirty() && !confirm('Discard unsaved rank changes?')) return false;
      editing = false; node('rankDialog').close(); return true;
    }
    function open(rank) {
      if (!ready || writing) return;
      id = rank ? rank.id : '';
      fields.forEach((key) => { node(`rank-${key}`).value = rank ? rank[key] : key === 'sortWeight' ? 0 : ''; });
      node('rankDialogTitle').textContent = rank ? 'Edit Rank' : 'Add Rank';
      node('rankError').textContent = '';
      editing = true; baseline = JSON.stringify(draft());
      node('rankDialog').showModal(); node('rank-name').focus();
    }
    async function load() {
      const current = ++token;
      ready = false; selected.clear(); ranks = []; render(); notice('Loading ranks...');
      try {
        const data = await request('/api/ranks');
        if (current !== token) return;
        ranks = data.ranks; ready = true; render(); notice('');
      } catch (error) { if (current === token) notice(error.message, true); }
    }
    async function write(url, method, body, form = false) {
      if (!ready || writing) return;
      writing = true; render();
      try {
        const data = await request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        ranks = data.ranks; selected.clear();
        if (form) { editing = false; node('rankDialog').close(); }
        notice(form ? 'Rank saved.' : 'Selected reference ranks deleted. Live competitor data is unchanged.');
      } catch (error) {
        if (form) node('rankError').textContent = error.message;
        else notice(error.message, true);
      } finally { writing = false; render(); }
    }
    node('addRank').addEventListener('click', () => open());
    node('ranksBody').addEventListener('click', (event) => {
      const target = event.target.closest('[data-rank]');
      if (target) open(ranks.find((rank) => rank.id === target.getAttribute('data-rank')));
    });
    node('ranksBody').addEventListener('change', (event) => {
      if (writing || !ready) return;
      const id = event.target.getAttribute('data-rank-select');
      if (!ranks.some((rank) => rank.id === id)) return;
      if (event.target.checked) selected.add(id); else selected.delete(id);
      controls();
    });
    node('ranksSelectAll').addEventListener('change', () => {
      if (writing || !ready) return;
      selected.clear();
      if (node('ranksSelectAll').checked) ranks.forEach((rank) => selected.add(rank.id));
      render();
    });
    node('deleteRanks').addEventListener('click', () => {
      if (selected.size && confirm(`Delete ${selected.size} selected reference rank(s)? Existing registration, division and captain rules will not change.`)) {
        return write('/api/ranks/delete', 'POST', { ids: [...selected] });
      }
    });
    node('rankCancel').addEventListener('click', close);
    node('rankDialog').addEventListener('cancel', (event) => { event.preventDefault(); close(); });
    node('rankDialog').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    });
    node('rankForm').addEventListener('submit', (event) => {
      event.preventDefault();
      return write(id ? `/api/ranks/${encodeURIComponent(id)}` : '/api/ranks', id ? 'PUT' : 'POST', draft(), true);
    });
    return { load, dirty, busy: () => writing, canLeave: () => !editing || close(), leave: () => { ++token; } };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
  else root.RanksWorkspace = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
