(async function () {
  const node = (id) => document.getElementById(id);
  const panels = { 'judge-management': 'jmJudges', 'judge-testing': 'jmTesting',
    'judge-eligibility': 'jmEligibility', 'judge-experience': 'jmExperience', 'judge-csv-settings': 'jmCsvSettings' };
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let pendingRequests = 0;
  async function request(url, options) {
    pendingRequests++;
    try {
      const response = await fetch(url, options);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
      return result;
    } finally { pendingRequests--; }
  }
  const send = (url, body) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const response = await fetch('/management-template');
    if (!response.ok) throw new Error('Unable to load preparation forms.');
    const template = new DOMParser().parseFromString(await response.text(), 'text/html');
    const viewIds = ['judgeManagementView', 'volunteersView', 'ringJudgesView', 'judgeAssignmentsView'];
    for (const id of viewIds) {
      const view = template.getElementById(id);
      if (!view) throw new Error(`Preparation forms are missing: ${id}.`);
      node('workspace').append(document.importNode(view, true));
    }
    for (const style of template.querySelectorAll('style')) {
      const shared = document.createElement('style');
      shared.textContent = style.textContent.split('\n').filter((line) => line.includes('#judgeManagementView')).join('\n');
      document.head.append(shared);
    }
    let selected = '', currentPanel = 'judge-management', state, participation = null, loading = 0, writing = false, eventBaseline = '';
    const selectedEvent = () => selected;
    const confirm = window.confirm.bind(window);
    function showPanel(panel) {
      if (panels[panel]) currentPanel = panel;
      node('eventPreparation').hidden = panel !== 'event-preparation';
      node('serviceReview').hidden = panel !== 'service-review';
      const visibleView = panels[panel] || panel === 'jmAdd' || panel === 'jmImport' ? 'judgeManagementView'
        : panel === 'ring-judges' ? 'ringJudgesView' : panel === 'judge-assignments' ? 'judgeAssignmentsView'
          : panel.startsWith('volunteer') ? 'volunteersView' : '';
      for (const id of viewIds) node(id).hidden = id !== visibleView;
      for (const section of node('judgeManagementView').querySelectorAll('section')) section.hidden = section.id !== (panels[panel] || panel);
    }
    const workspace = JudgeManagementWorkspace.create({ document, request, confirm, showPanel });
    const volunteers = VolunteersWorkspace.create({ document, request, selectedEvent, confirm });
    const ringJudges = RingJudgesWorkspace.create({ document, request, selectedEvent, confirm });
    const assignments = JudgeAssignmentsWorkspace.create({ document, request, selectedEvent, confirm });
    const serviceReview = JudgeServiceReviewWorkspace.create({ document, request, selectedEvent,
      beginService: (draft, revision) => workspace.beginService(draft, revision),
      viewExperience: () => loadPanel('judge-experience') });
    const controllers = [workspace, volunteers, ringJudges, assignments, serviceReview];
    const newSelections = () => [...node('seParticipants').querySelectorAll('tr')].map((row) => ({
      associationId: row.dataset.member, volunteer: row.querySelector('[data-volunteer]').checked &&
        !row.querySelector('[data-volunteer]').disabled,
      competitor: row.querySelector('[data-competitor]').checked && !row.querySelector('[data-competitor]').disabled,
      age: row.querySelector('[data-age]').value === '' ? null : Number(row.querySelector('[data-age]').value)
    })).filter((row) => row.volunteer || row.competitor);
    const eventDraft = () => JSON.stringify(['seName', 'seDate', 'seScope', 'seDays', 'seRings'].map((id) => node(id).value));
    const preparationDirty = () => eventBaseline !== '' && eventDraft() !== eventBaseline || newSelections().length > 0;
    function resetEventForm() {
      node('simulationEventForm').reset();
      node('seDate').value = state.date;
      eventBaseline = eventDraft();
    }
    const busy = () => writing || pendingRequests > 0 || controllers.some((controller) => controller.busy());
    function canLeave() {
      if (busy()) { node('simulationError').textContent = 'Wait for the current preparation operation to finish.'; return false; }
      if (preparationDirty()) {
        if (!confirm('Discard unsaved event/participant selections?')) return false;
        resetEventForm();
        for (const checkbox of node('seParticipants').querySelectorAll('input[type=checkbox]:not(:disabled)')) checkbox.checked = false;
      }
      return controllers.every((controller) => controller.canLeave());
    }
    async function loadParticipation() {
      const run = ++loading, event = selected;
      participation = null; node('seParticipants').innerHTML = '';
      node('simulationParticipationFields').disabled = true;
      if (!event) { node('seNotice').textContent = 'Create or select an isolated event.'; return; }
      const result = await request(`/api/simulation/participation?eventName=${encodeURIComponent(event)}`);
      if (run !== loading || event !== selected) return;
      participation = result;
      const members = (rows) => new Set(rows.map((row) => row.associationId.toUpperCase()));
      const attending = members(result.volunteers), competing = members(result.competitors);
      node('seParticipants').innerHTML = result.judges.map((judge) => {
        const id = judge.associationId.toUpperCase(), volunteer = attending.has(id), competitor = competing.has(id);
        return `<tr data-member="${esc(judge.associationId)}"><td>${esc(judge.lastName)}, ${esc(judge.firstName)} (${esc(judge.associationId)})</td>
          <td>${esc(judge.rank)} / ${esc(judge.certification)}</td>
          <td><input data-age type="number" min="0" max="120" step="1" value="${esc(judge.age)}" ${judge.age !== null ? 'readonly' : ''}
            aria-label="Event age for ${esc(judge.associationId)}">${judge.ageIssue ? `<br>${esc(judge.ageIssue)}` : ''}</td>
          <td><input type="checkbox" data-volunteer aria-label="Volunteer ${esc(judge.associationId)}" ${volunteer ? 'checked disabled' : ''}></td>
          <td><input type="checkbox" data-competitor aria-label="Competitor ${esc(judge.associationId)}" ${competitor ? 'checked disabled' : ''}></td></tr>`;
      }).join('');
      node('simulationParticipationFields').disabled = false;
      node('seNotice').textContent = `${result.config.name}: ${result.config.date}, ${result.config.scope}, ${result.config.tournamentDays} day(s), ${result.config.ringConfigX * result.config.ringConfigY} rings. ${result.volunteers.length} volunteers; ${result.competitors.length} competitors.`;
    }
    async function loadEvents() {
      const result = await request('/api/simulation/events');
      if (!result.events.some((event) => event.eventName === selected)) selected = '';
      node('simulationEvent').innerHTML = '<option value="">Select an event</option>' + result.events.map((event) =>
        `<option value="${esc(event.eventName)}">${esc(event.name)} (${esc(event.date)})</option>`).join('');
      node('simulationEvent').value = selected;
    }
    async function loadPanel(panel) {
      currentPanel = panel;
      showPanel(panel);
      if (panel === 'event-preparation') await loadParticipation();
      else if (panel === 'service-review') await serviceReview.load();
      else if (panel === 'ring-judges') await ringJudges.load();
      else if (panel === 'judge-assignments') await assignments.load();
      else if (panel.startsWith('volunteer')) await volunteers.load(panel);
      else await workspace.load();
    }
    async function reload() {
      state = await request('/api/simulation');
      node('simulationDate').value = state.date;
      node('simulationDate').min = state.date;
      node('seDate').value = state.date;
      eventBaseline = eventDraft();
      node('currentDate').textContent = `Judge Management uses ${state.date}; event qualifications use each event's date.`;
      await loadEvents();
      await loadPanel(currentPanel);
    }
    async function operation(action) {
      if (busy()) { node('simulationError').textContent = 'Wait for the current preparation operation to finish.'; return; }
      writing = true; node('simulationError').textContent = '';
      for (const id of ['simulationEventFields', 'simulationParticipationFields', 'simulationEvent', 'advanceDate', 'reload']) node(id).disabled = true;
      try { await action(); }
      catch (error) { node('simulationError').textContent = error.message; }
      finally {
        writing = false;
        for (const id of ['simulationEventFields', 'simulationEvent', 'advanceDate', 'reload']) node(id).disabled = false;
        node('simulationParticipationFields').disabled = !participation;
      }
    }
    for (const button of document.querySelectorAll('[data-panel]')) {
      button.addEventListener('click', async () => {
        if (!canLeave()) return;
        try { await loadPanel(button.dataset.panel); node('simulationError').textContent = ''; }
        catch (error) { node('simulationError').textContent = error.message; }
      });
    }
    node('simulationEvent').addEventListener('change', async () => {
      const target = node('simulationEvent').value;
      if (!canLeave()) { node('simulationEvent').value = selected; return; }
      selected = target;
      try { await loadPanel(currentPanel); }
      catch (error) { node('simulationError').textContent = error.message; }
    });
    node('simulationEventForm').addEventListener('submit', (event) => {
      event.preventDefault();
      return operation(async () => {
        const result = await send('/api/simulation/events', { name: node('seName').value, date: node('seDate').value,
          scope: node('seScope').value, tournamentDays: Number(node('seDays').value), ringCount: Number(node('seRings').value) });
        selected = result.event.eventName; resetEventForm();
        await loadEvents(); await loadParticipation();
      });
    });
    node('simulationParticipationForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const members = newSelections();
      if (!participation || !members.length) { node('simulationError').textContent = 'Select participants to add.'; return; }
      if (!confirm(`Add ${members.length} selected directory members to ${selected}? This does not confirm phase availability.`)) return;
      return operation(async () => {
        await send(`/api/simulation/participation?eventName=${encodeURIComponent(selected)}`, {
          revision: participation.revision, judgeRevision: participation.judgeRevision, members
        });
        await loadParticipation();
      });
    });
    node('seSelectVolunteers').addEventListener('click', () => {
      for (const input of node('seParticipants').querySelectorAll('[data-volunteer]:not(:disabled)')) input.checked = true;
    });
    node('seClear').addEventListener('click', () => {
      for (const input of node('seParticipants').querySelectorAll('input[type=checkbox]:not(:disabled)')) input.checked = false;
    });
    for (const [id, origin] of [['jmAddJudge', 'judge-management'], ['jmTestingAdd', 'judge-testing'],
      ['jmEligibilityAdd', 'judge-eligibility'], ['jmExperienceAdd', 'judge-experience']]) {
      node(id).addEventListener('click', () => workspace.begin(origin));
    }
    node('jmImportJudges').addEventListener('click', () => { if (workspace.canLeave()) showPanel('jmImport'); });
    node('jmAddCancel').addEventListener('click', workspace.cancel);
    node('reload').addEventListener('click', () => { if (canLeave()) return operation(reload); });
    node('clockForm').addEventListener('submit', (event) => {
      event.preventDefault();
      if (!canLeave()) return;
      const date = node('simulationDate').value;
      return operation(async () => {
        await request('/api/simulation', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ previousDate: state.date, date }) });
        await reload();
      });
    });
    window.addEventListener('beforeunload', (event) => {
      if (preparationDirty() || controllers.some((controller) => controller.dirty()) || busy()) { event.preventDefault(); event.returnValue = ''; }
    });
    await reload();
  } catch (error) { node('simulationError').textContent = error.message; }
})();
