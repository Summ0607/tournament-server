(function (root) {
  function create({ document, request, selectedEvent, confirm }) {
    const node = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const roles = ['center', 'corner', 'sktk'];
    const labels = { center: 'Center', corner: 'Corner', sktk: 'SK/TK' };
    let data = null, eventName = '', phase = 'P1', baseline = '', busy = false, token = 0;
    const dirty = () => Boolean(data && (
      JSON.stringify(data.phases) !== baseline || Boolean(node('jaReplacementPin')?.value)
    ));
    const current = () => data && eventName === selectedEvent();
    const notice = (message, error = false) => {
      node('jaNotice').textContent = message; node('jaNotice').setAttribute('data-state', error ? 'error' : 'info');
    };
    function canLeave() {
      if (busy) { notice('Wait for the current assignment operation to finish.', true); return false; }
      if (!dirty()) return true;
      if (!confirm('Discard unsaved judge assignments?')) return false;
      node('jaReplacementPin').value = '';
      data = null; eventName = ''; token++;
      return true;
    }
    const competitionDiscipline = (judge) => {
      if (!judge.sources.includes('competitor')) return '';
      const rank = String(judge.rank || '').trim().toUpperCase();
      if (/^D[1-8]$/.test(rank)) return 'black-belt';
      if (/^(?:G(?:10|[1-9])|CDB)$/.test(rank)) return 'gup';
      return '';
    };
    const competingInPhase = (judge, draft) => competitionDiscipline(judge) === draft.discipline;
    const eligible = (judge, role, draft) => judge.roles[role] && !competingInPhase(judge, draft);
    function render() {
      const ringsOpen = Boolean(node('jaRings')?.open);
      const availabilityOpen = Boolean(node('jaAvailability')?.open);
      const availabilityScroll = node('jaAvailabilityList')?.scrollTop || 0;
      const arbitratorsOpen = Boolean(node('jaArbitrators')?.open);
      const arbitratorsScroll = node('jaArbitratorList')?.scrollTop || 0;
      const focused = document.activeElement?.id;
      node('jaSave').disabled = busy || !current() || !dirty() || data.configurationLocked;
      node('jaSave').setAttribute('data-unsaved', String(Boolean(current() && dirty())));
      node('jaSaveState').textContent = !current() ? '' : busy ? 'Working...' : dirty()
        ? 'Unsaved changes - save before leaving.' : data.revision ? 'All assignment changes saved.' : 'No saved plans yet. Select rings and availability, then save.';
      node('jaAuto').disabled = busy || !current() || data.configurationLocked;
      node('jaAuto').setAttribute('data-action', 'primary');
      node('jaReload').disabled = busy;
      node('jaPhase').disabled = busy;
      node('jaReplacementPin').disabled = busy || Boolean(data?.configurationLocked);
      node('jaReplacementPinState').textContent = data?.replacementPinConfigured
        ? 'Configured; blank keeps the current PIN.'
        : 'Not configured; set before tablets load ring plans.';
      if (!current()) { node('jaContent').innerHTML = '<p>Select a tournament.</p>'; node('jaCandidateCount').textContent = ''; return; }
      const draft = data.phases[phase], byId = new Map(data.judges.map((judge) => [judge.id, judge]));
      const query = (node('jaSearch').value || '').trim().toLowerCase();
      const visible = data.judges.filter((judge) => `${judge.name} ${judge.associationId} ${judge.rank} ${judge.certification}`.toLowerCase().includes(query))
        .sort((a, b) => (b.priority ?? 6) - (a.priority ?? 6) || a.name.localeCompare(b.name));
      node('jaCandidateCount').textContent = `${visible.length} of ${data.judges.length} candidates shown; ${draft.available.length} confirmed available in ${phase}`;
      const locked = data.configurationLocked || busy;
      const disabled = locked ? 'disabled' : '';
      const used = new Set([...draft.arbitrators, ...Object.values(draft.assignments).flatMap((ring) => roles.flatMap((role) => ring[role]))]);
      const options = (role) => '<option value="">Select official</option>' + data.judges.filter((judge) =>
        draft.available.includes(judge.id) && !used.has(judge.id) && eligible(judge, role, draft))
        .sort((a, b) => (b.priority ?? 6) - (a.priority ?? 6) || a.name.localeCompare(b.name))
        .map((judge) => `<option value="${esc(judge.id)}">${esc(judge.name)} (${esc(judge.associationId)}; ${esc(judge.certification)}; priority ${judge.priority ?? 6})</option>`).join('');
      const person = (id) => byId.has(id) ? `${byId.get(id).name} (${byId.get(id).associationId})` : `Missing member: ${id}`;
      const minCorner = draft.discipline === 'black-belt' ? 4 : 2;
      const operating = draft.rings.filter((ring) => {
        const assigned = draft.assignments[ring];
        return assigned?.center.length === 1 && assigned.corner.length >= minCorner && assigned.sktk.length >= 1 &&
          roles.every((role) => assigned[role].every((id) => draft.available.includes(id) && byId.has(id) && eligible(byId.get(id), role, draft)));
      }).length;
      node('jaContent').innerHTML = `<p><strong>${operating}/${draft.rings.length} rings meet minimum staffing.</strong>
        Minimum: 1 Center, ${minCorner} Corners, 1 SK/TK. Preferred: 1 Center, 4 Corners, 2 SK/TK per ring. ${data.configurationLocked ? 'Locked after operational use.' : ''}</p>
        <label>Phase discipline <select id="jaDiscipline" ${disabled}><option value="black-belt" ${draft.discipline === 'black-belt' ? 'selected' : ''}>Black Belt</option><option value="gup" ${draft.discipline === 'gup' ? 'selected' : ''}>Gup</option></select></label>
        <details id="jaRings"${ringsOpen ? ' open' : ''}><summary>Select rings (${draft.rings.length} selected)</summary><button type="button" data-ja-all-rings ${disabled}>Select all rings</button> <button type="button" data-ja-clear-rings ${disabled}>Clear rings</button><div>${[...new Set([...data.rings, ...draft.rings])].map((ring, index) =>
          `<label><input id="jaRing-${index}" type="checkbox" data-ja-ring="${esc(ring)}" ${draft.rings.includes(ring) ? 'checked' : ''} ${disabled}> ${esc(ring)}</label>`).join('')}</div></details>
        <details id="jaAvailability"${availabilityOpen ? ' open' : ''}><summary>Confirm phase availability - ${data.judges.length} candidates; ${draft.available.length} confirmed available</summary>
        <p>Check only officials who agreed to serve in ${phase}. Higher priority is considered first; progression opportunities break ties. Filtering does not change availability or assignments.</p>
        ${draft.available.filter((id) => !byId.has(id)).map((id) => `<label><input type="checkbox" checked data-ja-available="${esc(id)}" ${disabled}> Missing candidate ${esc(id)}; uncheck to remove stale availability.</label>`).join('')}
        <div id="jaAvailabilityList" class="table-wrap"><table aria-label="Phase availability"><thead><tr><th>Available</th><th>Official / source</th><th>Priority</th><th>Certification</th><th>Progression / review</th></tr></thead><tbody>${visible.map((judge, index) => {
          const phaseConflict = competingInPhase(judge, draft), checked = draft.available.includes(judge.id);
          const unavailable = phaseConflict && !checked;
          const competingPhase = competitionDiscipline(judge) === 'black-belt' ? 'Black Belt' : 'Gup';
          const source = judge.potential ? 'Potential competitor; not a registered volunteer'
            : judge.sources.includes('competitor') ? 'Judging volunteer and competitor' : 'Judging volunteer';
          return `<tr><td><input id="jaAvailable-${index}" aria-label="Confirm ${esc(judge.name)} (${esc(judge.associationId)})" type="checkbox" data-ja-available="${esc(judge.id)}" ${checked ? 'checked' : ''} ${disabled || unavailable ? 'disabled' : ''}></td>
          <td>${esc(judge.name)} (${esc(judge.associationId)})<br>Rank: ${esc(judge.rank || 'unknown')}. ${source}${competitionDiscipline(judge) ? `; competes in the ${competingPhase} phase${phaseConflict ? ' and is unavailable' : ''}` : ''}</td>
          <td>${judge.priority ?? 6}</td>
          <td>${esc(judge.certification)}; expires ${esc(judge.expiration || 'unknown')}</td>
          <td>${esc(judge.qualificationIssue || (!Object.values(judge.roles).some(Boolean) ? Object.values(judge.roleIssues || {}).filter(Boolean).join(' ') : '') || judge.progression?.reason || judge.progression?.status || 'No profile match')}
          <br>Allowed roles: ${esc(Object.keys(judge.roles).filter((role) => eligible(judge, role, draft)).map((role) => labels[role] || 'Arbitrator').join(', ') || 'None')}.
          ${Object.values(judge.roleIssues || {}).some(Boolean) ? `<details><summary>Role restrictions</summary>${esc([...new Set(Object.values(judge.roleIssues).filter(Boolean))].join(' '))}</details>` : ''}
          ${judge.progression ? `<br>Target ${esc(judge.progression.targetLevel)}; experience ${esc(judge.progression.experienceCount)}/${esc(judge.progression.requiredExperience)}` : ''}</td></tr>`;
        }).join('') || '<tr><td colspan="5">No matching candidates. Clear search to see the full list.</td></tr>'}</tbody></table></div></details>
        <section><h3>Arbitrators (${draft.arbitrators.length}; reserve 2-4 as needed)</h3>
        ${draft.arbitrators.map((id) => `<p>${esc(person(id))} <button type="button" data-ja-unarb="${esc(id)}" ${disabled}>Remove</button></p>`).join('')}
        <details id="jaArbitrators"${arbitratorsOpen ? ' open' : ''}><summary>Add or remove arbitrator reservations</summary>
        <p>Select multiple qualified, confirmed-available officials below. Reservations apply only to ${phase} and exclude ring positions.</p>
        <div id="jaArbitratorList" class="table-wrap">${visible.filter((judge) => draft.arbitrators.includes(judge.id) ||
          draft.available.includes(judge.id) && !used.has(judge.id) && eligible(judge, 'arbitrator', draft)).map((judge, index) =>
          `<label><input id="jaArbitrator-${index}" type="checkbox" data-ja-arbitrator="${esc(judge.id)}" ${draft.arbitrators.includes(judge.id) ? 'checked' : ''} ${disabled}> ${esc(judge.name)} (${esc(judge.associationId)}; ${esc(judge.certification)})</label>`).join('') ||
          '<p>No matching eligible officials available for reservation. Clear search or confirm qualified availability first; officials already assigned to rings must be removed from those positions before reserving.</p>'}</div></details></section>
        <div class="ja-grid">${draft.rings.map((ringId) => {
          const ring = draft.assignments[ringId] || { center: [], corner: [], sktk: [] };
          return `<article class="ja-card"><h3>Ring ${esc(ringId)}</h3>${roles.map((role) =>
            `<h4>${labels[role]}</h4>${ring[role].map((id) => `<p>${esc(person(id))}
              ${!byId.has(id) || !eligible(byId.get(id), role, draft) || !draft.available.includes(id) ? '<strong>Invalid/stale assignment; remove before saving.</strong>' : ''}
              <button type="button" data-ja-remove="${esc(id)}" data-ring="${esc(ringId)}" data-role="${role}" ${disabled}>Remove</button></p>`).join('')}
            ${ring[role].length < (role === 'center' ? 1 : role === 'corner' ? 4 : 2) ?
              `<select aria-label="Add ${labels[role]} to ${esc(ringId)}" data-ja-add="${esc(ringId)}" data-role="${role}" ${disabled}>${options(role)}</select>` : ''}`).join('')}</article>`;
        }).join('')}</div>`;
      node('jaAvailabilityList').scrollTop = availabilityScroll;
      node('jaArbitratorList').scrollTop = arbitratorsScroll;
      if (focused?.startsWith('ja')) node(focused)?.focus?.({ preventScroll: true });
    }
    async function load() {
      const target = selectedEvent(), run = ++token;
      if (target !== eventName) node('jaSearch').value = '';
      node('jaReplacementPin').value = '';
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
    node('jaReplacementPin').addEventListener('input', render);
    node('jaSearch').addEventListener('input', () => { if (node('jaAvailability')) node('jaAvailability').open = true; render(); });
    node('jaClearSearch').addEventListener('click', () => { node('jaSearch').value = ''; render(); });
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
      } else if (get('data-ja-arbitrator')) {
        const id = get('data-ja-arbitrator');
        if (target.checked) {
          if (!draft.arbitrators.includes(id)) draft.arbitrators.push(id);
        }
        else draft.arbitrators = draft.arbitrators.filter((item) => item !== id);
      } else if (get('data-ja-add') && target.value) {
        const ring = get('data-ja-add'), role = get('data-role');
        draft.assignments[ring] ||= { center: [], corner: [], sktk: [] };
        draft.assignments[ring][role].push(target.value);
      }
      notice('Unsaved phase changes. Removing availability also removes that official from this phase assignments.'); render();
    });
    node('jaContent').addEventListener('click', (event) => {
      if (!current() || busy || data.configurationLocked) return;
      const target = event.target, draft = data.phases[phase];
      if (target.hasAttribute?.('data-ja-all-rings')) {
        draft.rings = [...data.rings];
        for (const ring of Object.keys(draft.assignments)) if (!draft.rings.includes(ring)) delete draft.assignments[ring];
        notice('Unsaved ring selection.'); render(); return;
      }
      if (target.hasAttribute?.('data-ja-clear-rings')) {
        if (!confirm('Clear selected rings and their assignments for this phase?')) return;
        draft.rings = []; draft.assignments = {}; notice('Unsaved ring selection.'); render(); return;
      }
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
        const replacementPin = node('jaReplacementPin').value;
        const result = await request(`/api/judge-assignments${auto ? '/auto' : ''}?eventName=${encodeURIComponent(eventName)}`,
          { method: auto ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ revision: data.revision, sourceRevision: data.sourceRevision,
              ...(auto ? { phase: data.phases[phase] } : {
                phases: data.phases,
                ...(replacementPin ? { replacementPin } : {})
              }) }) });
        if (auto) {
          data.phases[phase].assignments = result.assignments;
          notice(`Draft: ${result.operatingRings} rings staffed. Higher priority first; progression opportunities break ties. Save to keep.`);
        } else {
          data = result; baseline = JSON.stringify(data.phases);
          node('jaReplacementPin').value = '';
          notice('Both phase plans saved.');
        }
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
