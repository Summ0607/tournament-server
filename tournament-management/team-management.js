(function (root) {
  const rules = typeof module !== 'undefined' && module.exports ? require('../assets/team-rules') : root.TeamRules;
  const ageOf = typeof module !== 'undefined' && module.exports ? require('../assets/division-rules').ageOf : root.DivisionRules.ageOf;
  function create({ document, request, selectedEvent, confirm, changed = () => {} }) {
    const node = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fullName = (member) => member ? `${member.firstName || ''} ${member.lastName || ''}`.trim() || `Competitor ${member.id}` : 'Unavailable';
    const disciplineLabel = (value) => value === 'TH' ? 'Team Hyung' : 'Team Sparring';
    let data = null, eventName = '', token = 0, busy = false, writing = false, editing = false, id, page = 0, baseline = '', settingsBaseline = '', view = '';
    const selected = new Set();
    function draft() {
      return JSON.stringify({ name: node('tmName').value, discipline: node('tmDiscipline').value, ids: [...selected].sort((a, b) => a - b) });
    }
    function settingsDraft() {
      return JSON.stringify({
        TS: { teamSize: Number(node('tmSize').value), genderPolicy: node('tmPolicy').value },
        TH: { teamSize: Number(node('tmHyungSize').value), genderPolicy: node('tmHyungPolicy').value }
      });
    }
    function teamSettings() { return data.settings[editing ? node('tmDiscipline').value : 'TS']; }
    function dirty() {
      return Boolean(editing && draft() !== baseline || data && settingsDraft() !== settingsBaseline);
    }
    function message(text, error = false) {
      node('tmNotice').textContent = text;
      node('tmNotice').setAttribute('data-state', error ? 'error' : 'info');
      node('tmSettingsNotice').textContent = text;
      node('tmSettingsNotice').setAttribute('data-state', error ? 'error' : 'info');
    }
    function readonly() { return busy || !data || eventName !== selectedEvent() || data.configurationLocked; }
    function controls() {
      const locked = readonly();
      ['tmAdd', 'tmSave', 'tmDelete', 'tmName', 'tmDiscipline', 'tmSize', 'tmPolicy', 'tmHyungSize', 'tmHyungPolicy', 'tmSettingsSave', 'tmHyungSettingsSave'].forEach((key) => { node(key).disabled = Boolean(locked); });
      node('tmCancel').disabled = busy;
      node('tmRefresh').disabled = busy || dirty();
      node('tmSave').disabled = Boolean(locked || selected.size !== teamSettings().teamSize);
      node('tmLock').textContent = data && data.configurationLocked
        ? `${data.configurationLockReason || 'Event configuration is locked.'} Stop tablet activity, then reset the run from Tournament to edit teams and settings.`
        : '';
      node('tmSettingsLock').textContent = node('tmLock').textContent;
    }
    function renderRoster() {
      if (!data) return;
      const query = node('tmSearch').value.trim().toLowerCase();
      const rows = data.roster.filter((member) => [fullName(member), member.id, member.gender, member.rank, member.studio, member.age]
        .join(' ').toLowerCase().includes(query));
      page = Math.max(0, Math.min(page, Math.ceil(rows.length / 25) - 1));
      node('tmRosterBody').innerHTML = rows.slice(page * 25, (page + 1) * 25).map((member) => {
        const assigned = data.teams.some((team) => team.id !== id && team.discipline === node('tmDiscipline').value && team.memberIds.includes(member.id));
        return `<tr><td><input type="checkbox" data-member="${member.id}" aria-label="Select ${esc(fullName(member))}" ${selected.has(member.id) ? 'checked' : ''} ${readonly() || assigned && !selected.has(member.id) ? 'disabled' : ''}></td><td>${esc(fullName(member))}${assigned ? ' (Already assigned)' : ''}</td><td>${member.id}</td><td>${esc(ageOf(member) ?? 'Unknown')}</td><td>${esc(member.gender)}</td><td>${esc(member.rank || 'Unknown')}</td><td>${esc(member.studio)}</td></tr>`;
      }).join('') || '<tr><td colspan="7">No matching registered competitors.</td></tr>';
      node('tmPage').textContent = `Page ${page + 1} of ${Math.max(1, Math.ceil(rows.length / 25))} · ${rows.length} competitors`;
      node('tmPrev').disabled = page === 0;
      node('tmNext').disabled = (page + 1) * 25 >= rows.length;
      const members = [...selected].map((memberId) => data.roster.find((member) => member.id === memberId));
      node('tmSelected').textContent = `Selected ${selected.size} / ${teamSettings().teamSize}: ` +
        [...selected].map((memberId) => fullName(data.roster.find((member) => member.id === memberId)) + ` (#${memberId})`).join(', ');
      const valid = members.every((member) => member && Number.isFinite(rules.rankStrength(member.rank)) && Number.isInteger(ageOf(member)) && ageOf(member) >= 0 && ageOf(member) <= 120);
      const captain = valid ? members.map((member) => ({ ...member, age: ageOf(member) })).sort(rules.compareCaptains)[0] : null;
      node('tmCaptain').textContent = captain ? `Automatic captain: ${fullName(captain)} (#${captain.id})` : 'Automatic captain: select members with known ranks and valid ages. Server validates on save.';
      const genders = new Set(members.map((member) => member && member.gender));
      const validGender = members.every((member) => member && ['Male', 'Female'].includes(member.gender)) &&
        (teamSettings().genderPolicy === 'mixed' || genders.size <= 1);
      const available = !data.teams.some((team) => team.id !== id && team.discipline === node('tmDiscipline').value &&
        team.memberIds.some((memberId) => selected.has(memberId)));
      controls();
      node('tmSave').disabled = node('tmSave').disabled || !valid || !validGender || !available;
    }
    function render() {
      node('tmList').hidden = editing;
      node('tmForm').hidden = !editing;
      node('tmTeamsBody').innerHTML = data ? data.teams.map((team) => `<tr><td><button type="button" data-edit="${team.id}">${esc(team.name)}</button>${team.error ? `<p role="alert">${esc(team.error)}</p>` : ''}</td><td>${disciplineLabel(team.discipline)}</td><td>${esc(team.gender)}</td><td>${esc(fullName(team.captain))}</td><td>${team.members.map((member) => esc(fullName(member))).join(', ')}</td><td>Unassigned</td></tr>`).join('') || '<tr><td colspan="6">No teams yet. Add a team to begin.</td></tr>'
        : '<tr><td colspan="6">Select a tournament to manage its teams.</td></tr>';
      controls();
      if (editing) renderRoster();
    }
    function resetSettings() {
      node('tmSize').value = data ? data.settings.TS.teamSize : 3;
      node('tmPolicy').value = data ? data.settings.TS.genderPolicy : 'single';
      node('tmHyungSize').value = data ? data.settings.TH.teamSize : 3;
      node('tmHyungPolicy').value = data ? data.settings.TH.genderPolicy : 'single';
      settingsBaseline = settingsDraft();
      changed();
    }
    async function load(nextView = view) {
      view = nextView;
      const requestToken = ++token;
      eventName = selectedEvent();
      const scope = eventName;
      data = null; editing = false; selected.clear(); busy = false; baseline = ''; resetSettings(); render();
      if (!scope) { message('Select a tournament above. Team data never falls back to the active tournament.'); return; }
      busy = true; render(); message('Loading teams and registered competitors…');
      try {
        const result = await request(`/api/teams?eventName=${encodeURIComponent(scope)}`);
        if (requestToken !== token || scope !== selectedEvent()) return;
        data = result;
        resetSettings();
        message('Manual teams only. Division assignment is deferred; all team divisions remain Unassigned.');
        node('tmSettingsNotice').textContent = '';
      } catch (error) {
        if (requestToken === token && scope === selectedEvent()) message(error.message, true);
      } finally {
        if (requestToken === token) { busy = false; render(); }
      }
    }
    function open(team) {
      if (!data || busy) return;
      id = team && team.id;
      editing = true; selected.clear();
      (team ? team.memberIds : []).forEach((memberId) => selected.add(memberId));
      node('tmName').value = team ? team.name : '';
      node('tmDiscipline').value = team ? team.discipline : 'TS';
      node('tmSearch').value = ''; page = 0;
      node('tmFormTitle').textContent = team ? 'Edit Team' : 'Add Team';
      node('tmDanger').hidden = !team;
      baseline = draft(); render(); node('tmName').focus();
    }
    async function write(url, method, body, discipline) {
      if (readonly()) return;
      const scope = eventName, requestToken = token;
      busy = true; writing = true; render(); message('Saving…');
      try {
        const result = await request(`${url}?eventName=${encodeURIComponent(scope)}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
        if (requestToken !== token || scope !== selectedEvent()) return;
        if (discipline) {
          data.settings[discipline] = result[discipline];
          const saved = JSON.parse(settingsBaseline);
          saved[discipline] = result[discipline];
          settingsBaseline = JSON.stringify(saved);
          message(`${disciplineLabel(discipline)} settings saved.`);
          changed();
          return;
        }
        editing = false; baseline = draft(); resetSettings();
        await load(view); changed();
      } catch (error) {
        if (requestToken === token && scope === selectedEvent()) {
          message(error.message, true);
          if (/locked|operational use/i.test(error.message)) data.configurationLocked = true;
        }
      } finally {
        writing = false;
        if (requestToken === token) { busy = false; render(); }
      }
    }
    node('tmAdd').addEventListener('click', () => { if (!readonly()) open(); });
    node('tmTeamsBody').addEventListener('click', (event) => {
      const target = event.target.closest('[data-edit]');
      if (target && data) open(data.teams.find((team) => team.id === Number(target.getAttribute('data-edit'))));
    });
    node('tmRosterBody').addEventListener('change', (event) => {
      const memberId = Number(event.target.getAttribute('data-member'));
      if (readonly() || !data.roster.some((member) => member.id === memberId)) return;
      if (event.target.checked) selected.add(memberId); else selected.delete(memberId);
      renderRoster(); changed();
    });
    ['tmName', 'tmDiscipline'].forEach((key) => node(key).addEventListener('input', () => { renderRoster(); changed(); }));
    node('tmSearch').addEventListener('input', () => { page = 0; renderRoster(); });
    node('tmPrev').addEventListener('click', () => { page--; renderRoster(); });
    node('tmNext').addEventListener('click', () => { page++; renderRoster(); });
    node('tmCancel').addEventListener('click', () => {
      if (busy || draft() !== baseline && !confirm('Discard unsaved team changes?')) return;
      editing = false; baseline = ''; render(); changed();
    });
    node('tmForm').addEventListener('submit', (event) => {
      event.preventDefault();
      if (node('tmSave').disabled) return;
      return write(id ? `/api/teams/${id}` : '/api/teams', id ? 'PUT' : 'POST',
        { name: node('tmName').value, discipline: node('tmDiscipline').value, memberIds: [...selected] });
    });
    node('tmDelete').addEventListener('click', () => {
      if (!readonly() && id && confirm(`Delete team "${node('tmName').value}"? Members remain registered.`)) return write(`/api/teams/${id}`, 'DELETE');
    });
    ['tmSize', 'tmPolicy', 'tmHyungSize', 'tmHyungPolicy'].forEach((key) => node(key).addEventListener('input', () => { controls(); changed(); }));
    for (const [discipline, formId] of [['TS', 'tmSettingsForm'], ['TH', 'tmHyungSettingsForm']]) {
      node(formId).addEventListener('submit', (event) => {
        event.preventDefault();
        const settings = JSON.parse(settingsDraft());
        const { teamSize } = settings[discipline];
        if (!Number.isInteger(teamSize) || teamSize < 1 || teamSize > 50) {
          message(`${disciplineLabel(discipline)} team size must be a whole number from 1 to 50.`, true); return;
        }
        return write('/api/teams/settings', 'PUT', { [discipline]: settings[discipline] }, discipline);
      });
    }
    node('tmRefresh').addEventListener('click', () => { if (!busy && !dirty()) return load(); });
    return { load, dirty, busy: () => writing, discard: () => { ++token; editing = false; data = null; selected.clear(); resetSettings(); },
      leave: () => { ++token; if (!writing) busy = false; } };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
  else root.TeamWorkspace = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
