(function (root) {
  const roleMap = { center: 'CENTER_JUDGE', corner: 'CORNER_JUDGE', sktk: '', arbitrator: 'ARBITRATOR' };
  const labels = { center: 'Center', corner: 'Corner', sktk: 'SK/TK (choose actual role)', arbitrator: 'Arbitrator' };
  function buildReview(config, plan, directory) {
    const records = directory.experience || [];
    const eventScope = config.scope.toUpperCase().replace('-', '_');
    const related = records.filter((row) => row.eventName.toLowerCase() === config.name.toLowerCase() && row.eventDate === config.date);
    if (related.some((row) => !row.eventId || row.eventScope !== eventScope) || new Set(related.map((row) => row.eventId)).size > 1) {
      throw new Error('Existing experience has an unlinked or conflicting event identity. Reconcile this event in Experience before recording from assignments.');
    }
    const eventId = related[0]?.eventId || `simulation-event:${config.eventName}`;
    const eventName = related[0]?.eventName || config.name;
    if (records.some((row) => row.eventId === eventId &&
      (row.eventName !== eventName || row.eventDate !== config.date || row.eventScope !== eventScope))) {
      throw new Error('The shared event ID has conflicting metadata. Reconcile it in Experience before recording.');
    }
    const event = { eventId, eventName, eventDate: config.date, eventScope, location: config.location };
    const judges = new Map(directory.judges.map((judge) => [judge.associationId.toUpperCase(), judge]));
    const actual = records.filter((row) => row.eventId === eventId);
    const rows = [];
    for (const phase of ['P1', 'P2']) {
      const draft = plan.phases[phase];
      const add = (ring, role, associationId) => {
        const judge = judges.get(associationId.toUpperCase());
        const matching = actual.filter((row) => row.judgeId === judge?.id && row.phase === phase &&
          (role === 'sktk' ? ['SCOREKEEPER', 'TIMEKEEPER'].includes(row.role) : row.role === roleMap[role]));
        rows.push({ phase, ring, role, associationId: judge?.associationId || associationId,
          name: judge ? `${judge.lastName}, ${judge.firstName}` : 'Missing directory member',
          missing: !judge, matching, seed: { ...event, associationId: judge?.associationId || associationId,
            phase, role: roleMap[role], context: `${phase}, ${ring ? `Ring ${ring}` : 'phase reserve'}, planned ${labels[role]}` } });
      };
      for (const associationId of draft.arbitrators) add('', 'arbitrator', associationId);
      for (const ring of draft.rings) {
        const assigned = draft.assignments[ring];
        for (const role of ['center', 'corner', 'sktk']) for (const id of assigned?.[role] || []) add(ring, role, id);
      }
    }
    return { event, rows, actual, future: config.date > directory.asOf, asOf: directory.asOf };
  }
  function create({ document, request, selectedEvent, beginService, viewExperience }) {
    const node = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    let data = null, plan = null, directory = null, eventName = '', busy = false, token = 0;
    function notice(message, error = false) {
      node('srNotice').textContent = message;
      node('srNotice').setAttribute('data-state', error ? 'error' : 'info');
    }
    function render() {
      node('srReload').disabled = busy;
      node('srExperience').disabled = busy;
      if (!data) { node('srBody').innerHTML = ''; node('srActual').innerHTML = ''; node('srCount').textContent = ''; return; }
      const query = (node('srSearch').value || '').trim().toLowerCase(), phase = node('srPhase').value;
      const matches = (row, values) => (!phase || phase === row.phase) && values.join(' ').toLowerCase().includes(query);
      const planned = data.rows.map((row, index) => ({ row, index })).filter(({ row }) =>
        matches(row, [row.name, row.associationId, row.ring || 'Reserve', labels[row.role]]));
      node('srBody').innerHTML = planned.map(({ row, index }) => `<tr><td>${esc(row.phase)}</td><td>${esc(row.ring || 'Reserve')}</td>
        <td>${esc(labels[row.role])}</td><td>${esc(row.name)} (${esc(row.associationId)})</td>
        <td>${row.matching.length ? row.matching.map((record) => `${esc(record.role)}: ${record.logVerified ? 'Verified' : 'Pending verification'}`).join('<br>') :
          'No matching actual service recorded'}</td>
        <td><button type="button" data-service-review="${index}" ${busy || row.missing || data.future ? 'disabled' : ''}>Review actual service</button></td></tr>`).join('') ||
        `<tr><td colspan="6">${data.rows.length ? 'No matching planned service. Clear filters to see all.' : 'No saved ring assignments or arbitrator reserves. Save phase plans first; incomplete plans can still be reviewed.'}</td></tr>`;
      const judges = new Map(directory.judges.map((judge) => [judge.id, judge]));
      const actual = data.actual.filter((record) => {
        const judge = judges.get(record.judgeId);
        return matches(record, [judge?.associationId, judge?.lastName, judge?.firstName, record.role, record.role.replace(/_/g, ' ')]);
      });
      node('srCount').textContent = `${planned.length} of ${data.rows.length} planned positions; ${actual.length} of ${data.actual.length} actual service records shown`;
      node('srActual').innerHTML = actual.map((record) => {
        const judge = judges.get(record.judgeId);
        return `<tr><td>${esc(judge?.associationId || 'Missing judge')}</td><td>${esc(judge?.lastName)}, ${esc(judge?.firstName)}</td>
          <td>${esc(record.phase || 'Not specified')}</td><td>${esc(record.role)}</td>
          <td>${record.logVerified ? 'Verified' : 'Pending verification'}</td></tr>`;
      }).join('') || `<tr><td colspan="5">${data.actual.length ? 'No matching actual service. Clear filters to see all.' : 'No actual service recorded for this event.'}</td></tr>`;
    }
    async function load() {
      const run = ++token;
      eventName = selectedEvent(); data = null; plan = null; directory = null; render();
      if (!eventName) { notice('Select an isolated event.'); return; }
      busy = true; render(); notice('Loading saved assignments and actual service...');
      try {
        const [events, saved, people] = await Promise.all([request('/api/simulation/events'),
          request(`/api/judge-assignments?eventName=${encodeURIComponent(eventName)}`), request('/api/judge-management')]);
        if (run !== token || eventName !== selectedEvent()) return;
        const config = events.events.find((event) => event.eventName === eventName);
        if (!config) throw new Error('Selected isolated event no longer exists.');
        plan = saved; directory = people; data = buildReview(config, plan, directory);
        notice(`${data.event.eventName} (${data.event.eventDate}), shared ID: ${data.event.eventId}. ` +
          (data.future ? `Future event: advance the simulation date (currently ${data.asOf}) only after service is actually completed. ` : '') +
          'Read-only plans earn no credit. Review one actual service at a time; verify separately in Experience.');
      } catch (error) { if (run === token) { data = null; notice(error.message, true); } }
      finally { if (run === token) { busy = false; render(); } }
    }
    node('srReload').addEventListener('click', () => { if (!busy) return load(); });
    node('srSearch').addEventListener('input', render);
    node('srPhase').addEventListener('change', render);
    node('srClear').addEventListener('click', () => {
      node('srSearch').value = ''; node('srPhase').value = ''; render();
    });
    node('srExperience').addEventListener('click', () => { if (!busy) return viewExperience(); });
    node('srBody').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-service-review]');
      if (!button || button.disabled || busy || !data || data.future || eventName !== selectedEvent()) return;
      const row = data.rows[Number(button.getAttribute('data-service-review'))];
      if (!row || row.missing) return;
      busy = true; render();
      try {
        const latest = await request(`/api/judge-assignments?eventName=${encodeURIComponent(eventName)}`);
        if (latest.revision !== plan.revision || latest.sourceRevision !== plan.sourceRevision) {
          throw new Error('Assignments, qualifications or event participation changed. Reload review before recording service.');
        }
        await beginService(row.seed, directory.revision);
      } catch (error) { notice(error.message, true); }
      finally { busy = false; render(); }
    });
    return { load, dirty: () => false, busy: () => busy, canLeave: () => !busy, leave: () => { token++; busy = false; } };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { create, buildReview };
  else root.JudgeServiceReviewWorkspace = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
