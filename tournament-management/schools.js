(function (root) {
  function create({ document, request, confirm }) {
    const node = (id) => document.getElementById(id);
    const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    let schools = [], token = 0, busy = false, ready = false, editing = false, id = '', baseline = '';
    const selected = new Set();
    const draft = () => ({ name: node('schoolName').value, alternateNames: node('schoolAlternateNames').value,
      chiefInstructor: node('schoolInstructor').value, archived: node('schoolArchived').checked });
    const dirty = () => editing && JSON.stringify(draft()) !== baseline;
    function notice(text, error = false) {
      node('schoolsNotice').textContent = text;
      node('schoolsNotice').setAttribute('data-state', error ? 'error' : 'info');
    }
    function render() {
      node('schoolsBody').innerHTML = schools.map((school) => `<tr><td><input type="checkbox" data-school-select="${escape(school.id)}" aria-label="Select ${escape(school.name)}" ${selected.has(school.id) ? 'checked' : ''} ${busy ? 'disabled' : ''}></td><td><button type="button" class="tournament-name" data-school="${escape(school.id)}" ${busy ? 'disabled' : ''}>${escape(school.name)}</button></td><td>${escape(school.alternateNames)}</td><td>${escape(school.chiefInstructor)}</td><td>${school.archived ? 'Yes' : 'No'}</td></tr>`).join('') ||
        '<tr><td colspan="5">No schools yet.</td></tr>';
      controls();
    }
    function controls() {
      node('addSchool').disabled = !ready || busy;
      node('deleteSchools').disabled = !ready || busy || !selected.size;
      node('schoolsSelectAll').disabled = !ready || busy || !schools.length;
      node('schoolsSelectAll').checked = schools.length > 0 && selected.size === schools.length;
      node('schoolsSelectAll').indeterminate = selected.size > 0 && selected.size < schools.length;
      ['schoolSave', 'schoolCancel', 'schoolName', 'schoolAlternateNames', 'schoolInstructor', 'schoolArchived'].forEach((key) => { node(key).disabled = busy; });
    }
    function close() {
      if (busy || dirty() && !confirm('Discard unsaved school changes?')) return false;
      editing = false; node('schoolDialog').close(); return true;
    }
    function open(school) {
      if (busy || !ready) return;
      id = school ? school.id : '';
      node('schoolDialogTitle').textContent = school ? 'Edit School' : 'Add School';
      node('schoolName').value = school ? school.name : '';
      node('schoolAlternateNames').value = school ? school.alternateNames : '';
      node('schoolInstructor').value = school ? school.chiefInstructor : '';
      node('schoolArchived').checked = school ? school.archived : false;
      node('schoolError').textContent = '';
      editing = true; baseline = JSON.stringify(draft());
      node('schoolDialog').showModal(); node('schoolName').focus();
    }
    async function load() {
      const current = ++token;
      ready = false; schools = []; selected.clear(); render(); notice('Loading schools...');
      try {
        const data = await request('/api/schools');
        if (current !== token) return;
        schools = data.schools; ready = true; render(); notice('');
      } catch (error) { if (current === token) notice(error.message, true); }
    }
    node('addSchool').addEventListener('click', () => open());
    node('schoolsBody').addEventListener('click', (event) => {
      const target = event.target.closest('[data-school]');
      if (target) open(schools.find((school) => school.id === target.getAttribute('data-school')));
    });
    node('schoolsBody').addEventListener('change', (event) => {
      if (busy || !ready) return;
      const value = event.target.getAttribute('data-school-select');
      if (!schools.some((school) => school.id === value)) return;
      if (event.target.checked) selected.add(value); else selected.delete(value);
      controls();
    });
    node('schoolsSelectAll').addEventListener('change', () => {
      if (busy || !ready) return;
      selected.clear();
      if (node('schoolsSelectAll').checked) schools.forEach((school) => selected.add(school.id));
      render();
    });
    node('deleteSchools').addEventListener('click', () => {
      if (!ready || busy || !selected.size) return;
      if (confirm(`Permanently delete ${selected.size} selected school(s) from the shared directory? Existing competitors and their stored school names will not change.`)) {
        return write('/api/schools/delete', 'POST', { ids: [...selected] });
      }
    });
    node('schoolCancel').addEventListener('click', close);
    node('schoolDialog').addEventListener('cancel', (event) => { event.preventDefault(); close(); });
    node('schoolDialog').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    });
    async function write(url, method, body, form = false) {
      if (busy || !ready) return;
      busy = true; render();
      if (form) node('schoolError').textContent = 'Saving...';
      try {
        const data = await request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        schools = data.schools; selected.clear();
        if (form) { editing = false; node('schoolDialog').close(); }
        notice(form ? 'School saved.' : 'Selected schools deleted. Existing competitor registrations are unchanged.');
      } catch (error) {
        if (form) node('schoolError').textContent = error.message;
        else notice(error.message, true);
      } finally { busy = false; render(); }
    }
    node('schoolForm').addEventListener('submit', (event) => {
      event.preventDefault();
      return write(id ? `/api/schools/${encodeURIComponent(id)}` : '/api/schools', id ? 'PUT' : 'POST', draft(), true);
    });
    return { load, dirty, busy: () => busy, leave: () => { ++token; } };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
  else root.SchoolsWorkspace = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
