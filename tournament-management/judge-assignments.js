(function (root) {
  function create({ document, request, selectedEvent, confirm }) {
    const node = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const roles = ['center', 'corner', 'sktk'];
    const labels = { center: 'Center', corner: 'Corner', sktk: 'SK/TK' };
    let data = null, eventName = '', phase = 'P1', baseline = '', busy = false, token = 0;
    const dirty = () => Boolean(data && JSON.stringify(data.phases) !== baseline);
    const current = () => data && eventName === selectedEvent();
    const notice = (message, error = false) => {
      node('jaNotice').textContent = message; node('jaNotice').setAttribute('data-state', error ? 'error' : 'info');
    };
    function canLeave() {
      if (busy) { notice('Wait for the current assignment operation to finish.', true); return false; }
      if (!dirty()) return true;
      if (!confirm('Discard unsaved judge assignments?')) return false;
      data = null; eventName = ''; token++;
      return true;
    }
    const eligible = (judge, role, draft) => judge.roles[role] &&
      !(draft.discipline === 'black-belt' && judge.sources.includes('competitor') && /^D[1-8]$/.test(judge.rank));
    function render() {
      node('jaSave').disabled = busy || !current() || !dirty() || data.configurationLocked;
      node('jaAuto').disabled = busy || !current() || data.configurationLocked;
      node('jaReload').disabled = busy;
      node('jaPhase').disabled = busy;
      if (!current()) { node('jaContent').innerHTML = '<p>Select a tournament.</p>'; return; }
      const draft = data.phases[phase], byId = new Map(data.judges.map((judge) => [judge.id, judge]));
      const locked = data.configurationLocked || busy;
      const disabled = locked ? 'disabled' : '';
      const used = new Set([...draft.arbitrators, ...Object.values(draft.assignments).flatMap((ring) => roles.flatMap((role) => ring[role]))]);
      const options = (role) => '<option value="">Select official</option>' + data.judges.filter((judge) =>
        draft.available.includes(judge.id) && !used.has(judge.id) && eligible(judge, role, draft))
        .map((judge) => `<option value="${esc(judge.id)}">${esc(judge.name)} (${esc(judge.certification)})</option>`).join('');
      const person = (id) => byId.get(id)?.name || `Missing member: ${id}`;
      const minCorner = draft.discipline === 'black-belt' ? 4 : 2;
      const operating = draft.rings.filter((ring) => {
        const assigned = draft.assignments[ring];
        return assigned?.center.length === 1 && assigned.corner.length >= minCorner && assigned.sktk.length >= 1 &&
          roles.every((role) => assigned[role].every((id) => draft.available.includes(id) && byId.has(id) && eligible(byId.get(id), role, draft)));
      }).length;
      node('jaContent').innerHTML = `<p><strong>${operating}/${draft.rings.length} rings meet minimum staffing.</strong>
        Target: 1 Center, 4 Corners, 2 SK/TK per ring. ${data.configurationLocked ? 'Locked after operational use.' : ''}</p>
        <label>Phase discipline <select id="jaDiscipline" ${disabled}><option value="black-belt" ${draft.discipline === 'black-belt' ? 'selected' : ''}>Black Belt</option><option value="gup" ${draft.discipline === 'gup' ? 'selected' : ''}>Gup</option></select></label>
        <details><summary>Rings (${draft.rings.length})</summary>${[...new Set([...data.rings, ...draft.rings])].map((ring) =>
          `<label><input type="checkbox" data-ja-ring="${esc(ring)}" ${draft.rings.includes(ring) ? 'checked' : ''} ${disabled}> ${esc(ring)}</label>`).join('')}</details>
        <details><summary>Confirm phase availability (${draft.available.length}); competitor candidates require agreement</summary>
        ${draft.available.filter((id) => !byId.has(id)).map((id) => `<label><input type="checkbox" checked data-ja-available="${esc(id)}" ${disabled}> Missing candidate ${esc(id)}; uncheck to remove stale availability.</label>`).join('')}
        <div class="table-wrap"><table><thead><tr><th>Available</th><th>Official / source</th><th>Certification</th><th>Progression / review</th></tr></thead><tbody>${data.judges.map((judge) =>
          `<tr><td><input aria-label="Confirm ${esc(judge.name)}" type="checkbox" data-ja-available="${esc(judge.id)}" ${draft.available.includes(judge.id) ? 'checked' : ''} ${disabled}></td>
          <td>${esc(judge.name)} (${esc(judge.associationId)})<br>${judge.potential ? 'Potential competitor; not a registered volunteer' : 'Judging volunteer'}${judge.sources.includes('competitor') ? '; competing BB officials unavailable in BB phase' : ''}</td>
          <td>${esc(judge.certification)}; expires ${esc(judge.expiration || 'unknown')}</td>
          <td>${esc(judge.qualificationIssue || (!Object.values(judge.roles).some(Boolean) ? Object.values(judge.roleIssues || {}).filter(Boolean).join(' ') : '') || judge.progression?.reason || judge.progression?.status || 'No profile match')}
          ${judge.progression ? `<br>Target ${esc(judge.progression.targetLevel)}; experience ${judge.progression.experienceCount}/${judge.progression.requiredExperience}` : ''}</td></tr>`).join('')}</tbody></table></div></details>
        <section><h3>Arbitrators (${draft.arbitrators.length}; reserve 2-4 as needed)</h3>
        ${draft.arbitrators.map((id) => `<p>${esc(person(id))} <button type="button" data-ja-unarb="${esc(id)}" ${disabled}>Remove</button></p>`).join('')}
        <select id="jaArbitrator" aria-label="Add arbitrator" ${disabled}>${options('arbitrator')}</select></section>
        <div class="ja-grid">${draft.rings.map((ringId) => {
          const ring = draft.assignments[ringId] || { center: [], corner: [], sktk: [] };
          return `<article class="ja-card"><h3>Ring ${esc(ringId)}</h3>${roles.map((role) =>
            `<h4>${labels[role]}</h4>${ring[role].map((id) => `<p>${esc(person(id))}
              ${!byId.has(id) || !eligible(byId.get(id), role, draft) || !draft.available.includes(id) ? '<strong>Invalid/stale assignment; remove before saving.</strong>' : ''}
              <button type="button" data-ja-remove="${esc(id)}" data-ring="${esc(ringId)}" data-role="${role}" ${disabled}>Remove</button></p>`).join('')}
            ${ring[role].length < (role === 'center' ? 1 : role === 'corner' ? 4 : 2) ?
              `<select aria-label="Add ${labels[role]} to ${esc(ringId)}" data-ja-add="${esc(ringId)}" data-role="${role}" ${disabled}>${options(role)}</select>` : ''}`).join('')}</article>`;
        }).join('')}</div>`;
    }
    async function load() {
      const target = selectedEvent(), run = ++token;
      data = null; eventName = ''; render();
      if (!target) return;
      notice('Loading judge profiles and event candidates...');
      try {
        const result = await request(`/api/judge-assignments?eventName=${encodeURIComponent(target)}`);
        if (run !== token || selectedEvent() !== target) return;
        data = result; eventName = target; baseline = JSON.stringify(data.phases);
        notice('Both phases can be planned before the event. Availability must be confirmed separately.'); render();
      } catch (error) { if (run === token) notice(error.message, true); }
    }
    node('jaPhase').addEventListener('change', () => { phase = node('jaPhase').value; render(); });
    node('jaReload').addEventListener('click', () => { if (canLeave()) return load(); });
    node('jaContent').addEventListener('change', (event) => {
      if (!current() || busy || data.configurationLocked) return;
      const target = event.target, draft = data.phases[phase], get = (name) => target.getAttribute(name);
      if (target.id === 'jaDiscipline') {
        if (!confirm('Changing discipline clears this phase assignments and arbitrators. Continue?')) { render(); return; }
        draft.discipline = target.value; draft.assignments = {}; draft.arbitrators = [];
      } else if (get('data-ja-ring')) {
        const ring = get('data-ja-ring');
        if (target.checked) draft.rings.push(ring);
        else { draft.rings = draft.rings.filter((id) => id !== ring); delete draft.assignments[ring]; }
      } else if (get('data-ja-available')) {
        const id = get('data-ja-available');
        if (target.checked) {
          const judge = data.judges.find((item) => item.id === id);
          if (judge.potential && !confirm(`Confirm ${judge.name} has agreed to serve in ${phase}?`)) { render(); return; }
          draft.available.push(id);
        } else {
          draft.available = draft.available.filter((item) => item !== id);
          draft.arbitrators = draft.arbitrators.filter((item) => item !== id);
          for (const ring of Object.values(draft.assignments)) for (const role of roles) ring[role] = ring[role].filter((item) => item !== id);
        }
      } else if (target.id === 'jaArbitrator' && target.value) draft.arbitrators.push(target.value);
      else if (get('data-ja-add') && target.value) {
        const ring = get('data-ja-add'), role = get('data-role');
        draft.assignments[ring] ||= { center: [], corner: [], sktk: [] };
        draft.assignments[ring][role].push(target.value);
      }
      notice('Unsaved phase changes. Removing availability also removes that official from this phase assignments.'); render();
    });
    node('jaContent').addEventListener('click', (event) => {
      if (!current() || busy || data.configurationLocked) return;
      const target = event.target, draft = data.phases[phase];
      const arb = target.getAttribute('data-ja-unarb'), id = target.getAttribute('data-ja-remove');
      if (arb) draft.arbitrators = draft.arbitrators.filter((item) => item !== arb);
      else if (id) {
        const ring = target.getAttribute('data-ring'), role = target.getAttribute('data-role');
        draft.assignments[ring][role] = draft.assignments[ring][role].filter((item) => item !== id);
      } else return;
      notice('Unsaved phase changes.'); render();
    });
    async function write(auto) {
      if (!current() || busy || data.configurationLocked) return;
      if (auto && !confirm(`Replace ring assignments for ${phase}? Availability and arbitrators will be preserved.`)) return;
      busy = true; render();
      try {
        const result = await request(`/api/judge-assignments${auto ? '/auto' : ''}?eventName=${encodeURIComponent(eventName)}`,
          { method: auto ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ revision: data.revision, sourceRevision: data.sourceRevision,
              ...(auto ? { phase: data.phases[phase] } : { phases: data.phases }) }) });
        if (auto) {
          data.phases[phase].assignments = result.assignments;
          notice(`Draft: ${result.operatingRings} rings staffed. Required staffing first; qualified progression opportunities preferred. Save to keep.`);
        } else { data = result; baseline = JSON.stringify(data.phases); notice('Both phase plans saved.'); }
      } catch (error) { notice(error.message, true); }
      finally { busy = false; render(); }
    }
    node('jaSave').addEventListener('click', () => write(false));
    node('jaAuto').addEventListener('click', () => write(true));
    return { load, dirty, busy: () => busy, canLeave, leave: () => { token++; } };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
  else root.JudgeAssignmentsWorkspace = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
