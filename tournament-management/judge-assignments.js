(function (root) {
  function create({ document, request, selectedEvent, confirm }) {
    const node = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const roles = ['center', 'corner', 'sktk'];
    const labels = { center: 'Center', corner: 'Corner', sktk: 'SK/TK' };
    let data = null, eventName = '', phase = 'P1', baseline = '', busy = false, token = 0;
    let dragSource = null, dragElement = null, dragOverElement = null;
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
    const findAssignmentPosition = (id, draft) => {
      for (const ring of draft.rings) {
        for (const role of roles) {
          const index = draft.assignments[ring]?.[role]?.indexOf(id) ?? -1;
          if (index >= 0) return { id, ring, role, index };
        }
      }
      return null;
    };
    const assignmentIsValid = (id, role, draft, judges) => {
      const judge = judges.get(id);
      return Boolean(judge && draft.available.includes(id) && !draft.arbitrators.includes(id) &&
        eligible(judge, role, draft));
    };
    function clearDrag() {
      dragElement?.removeAttribute('aria-grabbed');
      dragOverElement?.classList?.remove('ja-drop-target');
      dragSource = null;
      dragElement = null;
      dragOverElement = null;
      node('jaDragHint').textContent = '';
      node('jaDragHint').hidden = true;
    }
    const resolveDragTarget = (element, draft) => {
      const assignment = element?.closest?.('[data-ja-assignment]');
      if (assignment) {
        return {
          id: assignment.getAttribute('data-ja-assignment'),
          position: {
            id: assignment.getAttribute('data-ja-assignment'),
            ring: assignment.getAttribute('data-ring'),
            role: assignment.getAttribute('data-role'),
            index: Number(assignment.getAttribute('data-index'))
          },
          element: assignment
        };
      }
      const candidate = element?.closest?.('[data-ja-candidate]');
      if (!candidate) return null;
      const id = candidate.getAttribute('data-ja-candidate');
      return { id, position: findAssignmentPosition(id, draft), element: candidate };
    };
    const canDropOn = (source, target, draft, judges) => {
      if (!source || !target || source.id === target.id) return false;
      if (!source.position && (!draft.available.includes(source.id) || draft.arbitrators.includes(source.id))) return false;
      if (!target.position) {
        const sourceJudge = judges.get(source.id), targetJudge = judges.get(target.id);
        return Boolean(source.position && sourceJudge && targetJudge &&
          assignmentIsValid(source.id, source.position.role, draft, judges) &&
          draft.available.includes(target.id) && !draft.arbitrators.includes(target.id) &&
          eligible(targetJudge, source.position.role, draft));
      }
      const destination = target.position;
      const sourceJudge = judges.get(source.id);
      if (!sourceJudge || !eligible(sourceJudge, destination.role, draft)) return false;
      if (!source.position) return true;
      const targetJudge = judges.get(target.id);
      if (!targetJudge || !draft.available.includes(target.id) || draft.arbitrators.includes(target.id)) return false;
      return assignmentIsValid(source.id, source.position.role, draft, judges) &&
        assignmentIsValid(target.id, destination.role, draft, judges) &&
        eligible(targetJudge, source.position.role, draft);
    };
    function moveAssignment(source, target, draft) {
      const removeFromPosition = (position) => {
        const values = draft.assignments[position.ring][position.role];
        values.splice(position.index, 1);
      };
      const insertAtPosition = (position, id) => {
        draft.assignments[position.ring][position.role].splice(position.index, 0, id);
      };
      if (source.position && target.position) {
        const from = source.position, to = target.position;
        const fromValues = draft.assignments[from.ring][from.role];
        const toValues = draft.assignments[to.ring][to.role];
        if (from.ring === to.ring && from.role === to.role) {
          [fromValues[from.index], fromValues[to.index]] = [fromValues[to.index], fromValues[from.index]];
          return;
        }
        fromValues[from.index] = target.id;
        toValues[to.index] = source.id;
        return;
      }
      if (source.position) {
        removeFromPosition(source.position);
        insertAtPosition(source.position, target.id);
      } else if (target.position) {
        removeFromPosition(target.position);
        insertAtPosition(target.position, source.id);
      }
    }
    function render() {
      clearDrag();
      const availabilityScroll = node('jaAvailabilityList')?.scrollTop || 0;
      const arbitratorsOpen = Boolean(node('jaArbitrators')?.open);
      const arbitratorsScroll = node('jaArbitratorList')?.scrollTop || 0;
      const focused = document.activeElement?.id;
      node('jaSave').disabled = busy || !current() || !dirty() || data.configurationLocked;
      node('jaSave').setAttribute('data-unsaved', String(Boolean(current() && dirty())));
      node('jaSaveState').textContent = !current() ? '' : busy ? 'Working...' : dirty()
        ? 'Unsaved changes' : data.revision ? 'Saved' : 'No saved assignments';
      node('jaAuto').disabled = busy || !current() || data.configurationLocked;
      node('jaAuto').setAttribute('data-action', 'primary');
      node('jaReload').disabled = busy || !current();
      node('jaPhase').disabled = busy || !current();
      node('jaDiscipline').disabled = busy || !current() || data.configurationLocked;
      node('jaPhase').value = phase;
      node('jaReplacementPin').disabled = busy || !current() || Boolean(data?.configurationLocked);
      node('jaReplacementPinState').textContent = !current() ? '' : data.replacementPinConfigured
        ? 'Configured; blank keeps the current PIN.'
        : 'Not configured.';
      if (!current()) {
        node('jaDiscipline').value = 'black-belt';
        node('jaSearch').disabled = true;
        node('jaClearSearch').disabled = true;
        node('jaBuildHint').textContent = '';
        node('jaCandidateCount').textContent = '';
        node('jaStaffingStatus').textContent = '';
        node('jaAvailabilityPanel').innerHTML = '<p class="ja-empty">No judge list is loaded.</p>';
        node('jaRingPlanning').innerHTML = '<p class="ja-empty">No tournament rings are loaded.</p>';
        return;
      }
      const draft = data.phases[phase], byId = new Map(data.judges.map((judge) => [judge.id, judge]));
      const used = new Set([...draft.arbitrators, ...Object.values(draft.assignments).flatMap((ring) =>
        roles.flatMap((role) => ring[role]))]);
      node('jaDiscipline').value = draft.discipline;
      node('jaSearch').disabled = busy;
      node('jaClearSearch').disabled = busy;
      const query = (node('jaSearch').value || '').trim().toLowerCase();
      const rankLabel = (code) => (data.judgeRanks || []).find((rank) => rank.code === code)?.label || code || 'Unspecified';
      const visible = data.judges.filter((judge) =>
        `${judge.name} ${judge.associationId} ${judge.rank} ${rankLabel(judge.rank)} ${judge.certification}`.toLowerCase().includes(query))
        .sort((a, b) => (b.priority ?? 6) - (a.priority ?? 6) || a.name.localeCompare(b.name));
      node('jaCandidateCount').textContent = `${visible.length} of ${data.judges.length} judges shown; ${draft.available.length} marked available for ${phase}`;
      const locked = data.configurationLocked || busy;
      const disabled = locked ? 'disabled' : '';
      node('jaAuto').disabled = locked || !draft.rings.length || !draft.available.length;
      node('jaBuildHint').textContent = !draft.rings.length ? 'Select at least one ring to build assignments.'
        : !draft.available.length ? `Mark at least one judge available for ${phase} to build assignments.`
          : '';
      const options = (role) => '<option value="">Select official</option>' + data.judges.filter((judge) =>
        draft.available.includes(judge.id) && !used.has(judge.id) && eligible(judge, role, draft))
        .sort((a, b) => (b.priority ?? 6) - (a.priority ?? 6) || a.name.localeCompare(b.name))
        .map((judge) => `<option value="${esc(judge.id)}">${esc(judge.name)} (${esc(judge.associationId)}; ${esc(judge.certification)}; priority ${judge.priority ?? 6})</option>`).join('');
      const person = (id) => byId.has(id) ? `${byId.get(id).name} (${byId.get(id).associationId})` : `Missing member: ${id}`;
      const assignedPerson = (id) => {
        const judge = byId.get(id);
        if (!judge) return `<span>Missing member: ${esc(id)}</span>`;
        return `<span>${esc(judge.name)} (${esc(judge.associationId)})</span><span class="ja-rank">${esc(rankLabel(judge.rank))}</span>`;
      };
      const minCorner = draft.discipline === 'black-belt' ? 4 : 2;
      const operating = draft.rings.filter((ring) => {
        const assigned = draft.assignments[ring];
        return assigned?.center.length === 1 && assigned.corner.length >= minCorner && assigned.sktk.length >= 1 &&
          roles.every((role) => assigned[role].every((id) => draft.available.includes(id) && byId.has(id) && eligible(byId.get(id), role, draft)));
      }).length;
      node('jaAvailabilityPanel').innerHTML = `${draft.available.filter((id) => !byId.has(id)).map((id) =>
        `<label><input type="checkbox" checked data-ja-available="${esc(id)}" ${disabled}> Missing candidate ${esc(id)}; uncheck to remove stale availability.</label>`).join('')}
      <div id="jaAvailabilityList" class="table-wrap"><table class="ja-roster-table" aria-label="Available judges for ${phase}"><thead><tr><th>Available</th><th>Judge</th></tr></thead><tbody>${visible.map((judge, index) => {
          const phaseConflict = competingInPhase(judge, draft), checked = draft.available.includes(judge.id);
          const unavailable = phaseConflict && !checked;
          const competingPhase = competitionDiscipline(judge) === 'black-belt' ? 'Black Belt' : 'Gup';
        const canDrag = checked && !draft.arbitrators.includes(judge.id) && !locked;
        const dragTitle = used.has(judge.id) ? 'Drag to another assigned judge to swap positions.'
          : 'Drag onto an assigned judge to replace them.';
        return `<tr data-ja-candidate="${esc(judge.id)}" draggable="${canDrag}"${canDrag ? ` title="${dragTitle}"` : ''}><td><input id="jaAvailable-${index}" aria-label="Confirm ${esc(judge.name)} (${esc(judge.associationId)})" type="checkbox" data-ja-available="${esc(judge.id)}" ${checked ? 'checked' : ''} ${disabled || unavailable ? 'disabled' : ''}></td>
          <td>${esc(judge.name)} <span class="ja-rank">${esc(rankLabel(judge.rank))}</span>${phaseConflict ? `<br><span class="ja-unavailable">Unavailable: competes in ${competingPhase}</span>` : ''}</td></tr>`;
        }).join('') || '<tr><td colspan="2">No matching judges. Clear the filter to see the full list.</td></tr>'}</tbody></table></div>`;
      node('jaStaffingStatus').textContent = draft.rings.length
        ? `${operating}/${draft.rings.length} rings meet minimum staffing.${data.configurationLocked ? ' Locked after operational use.' : ''}`
        : 'No rings selected.';
      const ringChecks = [...new Set([...data.rings, ...draft.rings])].map((ring, index) =>
        `<label><input id="jaRing-${index}" type="checkbox" data-ja-ring="${esc(ring)}" ${draft.rings.includes(ring) ? 'checked' : ''} ${disabled}> ${esc(ring)}</label>`).join('');
      const ringCards = draft.rings.map((ringId) => {
        const ring = draft.assignments[ringId] || { center: [], corner: [], sktk: [] };
        const minimums = { center: 1, corner: minCorner, sktk: 1 };
        const limits = { center: 1, corner: 4, sktk: 2 };
        return `<article class="ja-card"><h3>Ring ${esc(ringId)}</h3>${roles.map((role) =>
          `<fieldset class="ja-role"><legend>${role === 'corner' ? 'Corners' : labels[role]} ${ring[role].length}/${minimums[role]}</legend>
            ${ring[role].map((id, index) => {
              const valid = assignmentIsValid(id, role, draft, byId);
              const canDrag = valid && !locked;
              return `<p class="ja-assigned-official ja-assignment-person" data-ja-assignment="${esc(id)}" data-ring="${esc(ringId)}" data-role="${role}" data-index="${index}" draggable="${canDrag}"${canDrag ? ' title="Drag to another assigned judge or an available judge to swap."' : ''}>
                ${assignedPerson(id)}${valid ? '' : ` <strong>Invalid</strong> <button type="button" data-ja-remove="${esc(id)}" data-ring="${esc(ringId)}" data-role="${role}" ${disabled}>Remove</button>`}</p>`;
            }).join('')}
            ${ring[role].length < limits[role] ? `<select aria-label="Add ${labels[role]} to ${esc(ringId)}" data-ja-add="${esc(ringId)}" data-role="${role}" ${disabled}>${options(role)}</select>` : ''}
          </fieldset>`).join('')}</article>`;
      }).join('');
      node('jaRingPlanning').innerHTML = `<div class="ja-ring-selection">
        <h4>Select tournament rings</h4>
        <button type="button" data-ja-all-rings ${disabled}>Select all rings</button>
        <button type="button" data-ja-clear-rings ${disabled}>Clear rings</button>
        <div class="ja-ring-list">${ringChecks || '<span class="ja-empty">No rings available for this tournament.</span>'}</div>
      </div>
      ${draft.rings.length ? `<div class="ja-grid">${ringCards}</div>` :
        '<p class="ja-empty">Select rings above to assign judges.</p>'}
        <section class="ja-arbitrator-section"><h4>Arbitrator reserves (${draft.arbitrators.length})</h4>
        <div class="ja-arbitrator-reserves">${draft.arbitrators.map((id) =>
          `<p class="ja-arbitrator-reserve">${esc(person(id))} <button type="button" data-ja-unarb="${esc(id)}" aria-label="Remove ${esc(person(id))} from arbitrator reserves" ${disabled}>Remove</button></p>`).join('')}</div>
        <details id="jaArbitrators"${arbitratorsOpen ? ' open' : ''}><summary>Add or remove arbitrator reservations</summary>
        <p>Select multiple qualified, confirmed-available officials below. Reservations apply only to ${phase} and exclude ring positions.</p>
        <div id="jaArbitratorList" class="table-wrap">${visible.filter((judge) => draft.arbitrators.includes(judge.id) ||
          draft.available.includes(judge.id) && !used.has(judge.id) && eligible(judge, 'arbitrator', draft)).map((judge, index) =>
          `<label><input id="jaArbitrator-${index}" type="checkbox" data-ja-arbitrator="${esc(judge.id)}" ${draft.arbitrators.includes(judge.id) ? 'checked' : ''} ${disabled}> ${esc(judge.name)} (${esc(judge.associationId)}; ${esc(judge.certification)})</label>`).join('') ||
          '<p>No eligible available officials. Confirm availability or remove ring assignments to reserve someone.</p>'}</div></details></section>`;
      if (node('jaAvailabilityList')) node('jaAvailabilityList').scrollTop = availabilityScroll;
      if (node('jaArbitratorList')) node('jaArbitratorList').scrollTop = arbitratorsScroll;
      if (focused?.startsWith('ja')) node(focused)?.focus?.({ preventScroll: true });
    }
    async function load() {
      const target = selectedEvent(), run = ++token;
      if (target !== eventName) node('jaSearch').value = '';
      node('jaReplacementPin').value = '';
      data = null; eventName = ''; render();
      if (!target) {
        notice('Choose a tournament in the “Tournament for this page” selector above to load its judges and rings.');
        return;
      }
      notice('Loading judge profiles and event candidates...');
      try {
        const result = await request(`/api/judge-assignments?eventName=${encodeURIComponent(target)}`);
        if (run !== token || selectedEvent() !== target) return;
        data = result; eventName = target; baseline = JSON.stringify(data.phases);
        notice(''); render();
      } catch (error) { if (run === token) notice(error.message, true); }
    }
    node('jaContent').addEventListener('dragstart', (event) => {
      if (!current() || busy || data.configurationLocked) return;
      const draft = data.phases[phase], source = resolveDragTarget(event.target, draft);
      if (!source) return;
      if (source.position && !assignmentIsValid(source.id, source.position.role, draft,
        new Map(data.judges.map((judge) => [judge.id, judge])))) {
        event.preventDefault();
        return;
      }
      if (!source.position && (!draft.available.includes(source.id) || draft.arbitrators.includes(source.id))) {
        event.preventDefault();
        return;
      }
      dragSource = source;
      dragElement = source.element;
      dragElement.setAttribute('aria-grabbed', 'true');
      const hint = node('jaDragHint');
      hint.textContent = 'Drop on another assigned judge to swap positions, or on an available judge to replace them.';
      hint.hidden = false;
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', source.id);
      }
    });
    node('jaContent').addEventListener('dragover', (event) => {
      if (!current() || !dragSource) return;
      const draft = data.phases[phase], target = resolveDragTarget(event.target, draft);
      if (!canDropOn(dragSource, target, draft, new Map(data.judges.map((judge) => [judge.id, judge])))) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      if (dragOverElement !== target.element) {
        dragOverElement?.classList?.remove('ja-drop-target');
        dragOverElement = target.element;
        dragOverElement.classList?.add('ja-drop-target');
      }
    });
    node('jaContent').addEventListener('dragleave', (event) => {
      if (!current() || !dragSource) return;
      const target = resolveDragTarget(event.target, data?.phases[phase]);
      if (target?.element !== dragOverElement || target.element.contains?.(event.relatedTarget)) return;
      dragOverElement.classList?.remove('ja-drop-target');
      dragOverElement = null;
    });
    node('jaContent').addEventListener('drop', (event) => {
      if (!current() || !dragSource || busy || data.configurationLocked) return;
      const draft = data.phases[phase], target = resolveDragTarget(event.target, draft);
      if (!canDropOn(dragSource, target, draft, new Map(data.judges.map((judge) => [judge.id, judge])))) return;
      event.preventDefault();
      moveAssignment(dragSource, target, draft);
      notice('Unsaved phase changes.');
      clearDrag();
      render();
    });
    node('jaContent').addEventListener('dragend', clearDrag);
    node('jaPhase').addEventListener('change', () => { phase = node('jaPhase').value; render(); });
    node('jaDiscipline').addEventListener('change', () => {
      if (!current() || busy || data.configurationLocked) return;
      const draft = data.phases[phase], nextDiscipline = node('jaDiscipline').value;
      if (draft.discipline === nextDiscipline) return;
      if (!confirm(`Change ${phase} to ${nextDiscipline === 'black-belt' ? 'Black Belt' : 'Gup'}? Existing ring assignments and arbitrator reservations will be cleared, as will availability for competitors in that discipline.`)) {
        render();
        return;
      }
      draft.discipline = nextDiscipline;
      draft.assignments = {};
      draft.arbitrators = [];
      draft.available = draft.available.filter((id) => {
        const judge = data.judges.find((item) => item.id === id);
        return judge && competitionDiscipline(judge) !== nextDiscipline;
      });
      notice(`Updated the ${phase} discipline. Review judge availability and rebuild assignments.`);
      render();
    });
    node('jaReplacementPin').addEventListener('input', render);
    node('jaSearch').addEventListener('input', render);
    node('jaClearSearch').addEventListener('click', () => { node('jaSearch').value = ''; render(); });
    node('jaReload').addEventListener('click', () => { if (canLeave()) return load(); });
    node('jaContent').addEventListener('change', (event) => {
      if (!current() || busy || data.configurationLocked) return;
      const target = event.target, draft = data.phases[phase], get = (name) => target.getAttribute(name);
      if (get('data-ja-ring')) {
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
          notice(`Built assignments for ${result.operatingRings} of ${data.phases[phase].rings.length} rings. Review the ring assignments, then save.`);
        } else {
          data = result; baseline = JSON.stringify(data.phases);
          node('jaReplacementPin').value = '';
          notice('Assignments saved for P1 and P2.');
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
