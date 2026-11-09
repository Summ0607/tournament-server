(async function () {
  const node = (id) => document.getElementById(id);
  const panels = { 'judge-management': 'jmJudges', 'judge-testing': 'jmTesting',
    'judge-eligibility': 'jmEligibility', 'judge-experience': 'jmExperience', 'judge-csv-settings': 'jmCsvSettings' };
  async function request(url, options) {
    const response = await fetch(url, options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
    return result;
  }
  try {
    // Reuse the production form markup and controller without starting live application services.
    const response = await fetch('/management-template');
    if (!response.ok) throw new Error('Unable to load Judge Management forms.');
    const template = new DOMParser().parseFromString(await response.text(), 'text/html');
    const view = template.getElementById('judgeManagementView');
    if (!view) throw new Error('Judge Management forms are missing.');
    for (const style of template.querySelectorAll('style')) {
      const rules = style.textContent.split('\n').filter((line) => line.includes('#judgeManagementView'));
      const shared = document.createElement('style');
      shared.textContent = rules.join('\n');
      document.head.append(shared);
    }
    node('workspace').append(document.importNode(view, true));
    node('judgeManagementView').hidden = false;
    function showPanel(panel) {
      for (const section of node('judgeManagementView').querySelectorAll('section')) section.hidden = section.id !== (panels[panel] || panel);
    }
    const workspace = JudgeManagementWorkspace.create({ document, request, confirm: window.confirm.bind(window), showPanel });
    let state;
    async function reload() {
      state = await request('/api/simulation');
      node('simulationDate').value = state.date;
      node('simulationDate').min = state.date;
      node('currentDate').textContent = `All Judge Management date checks use ${state.date}.`;
      await workspace.load();
    }
    for (const button of document.querySelectorAll('[data-panel]')) {
      button.addEventListener('click', () => { if (workspace.canLeave()) showPanel(button.dataset.panel); });
    }
    for (const [id, origin] of [['jmAddJudge', 'judge-management'], ['jmTestingAdd', 'judge-testing'],
      ['jmEligibilityAdd', 'judge-eligibility'], ['jmExperienceAdd', 'judge-experience']]) {
      node(id).addEventListener('click', () => workspace.begin(origin));
    }
    node('jmImportJudges').addEventListener('click', () => showPanel('jmImport'));
    node('jmAddCancel').addEventListener('click', workspace.cancel);
    node('reload').addEventListener('click', async () => {
      if (!workspace.canLeave()) return;
      try { await reload(); showPanel('judge-management'); node('simulationError').textContent = ''; }
      catch (error) { node('simulationError').textContent = error.message; }
    });
    node('clockForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!workspace.canLeave()) return;
      node('advanceDate').disabled = true;
      try {
        await request('/api/simulation', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ previousDate: state.date, date: node('simulationDate').value }) });
        await reload(); showPanel('judge-management'); node('simulationError').textContent = '';
      } catch (error) { node('simulationError').textContent = error.message; }
      finally { node('advanceDate').disabled = false; }
    });
    window.addEventListener('beforeunload', (event) => {
      if (workspace.dirty() || workspace.busy()) { event.preventDefault(); event.returnValue = ''; }
    });
    await reload();
    showPanel('judge-management');
  } catch (error) { node('simulationError').textContent = error.message; }
})();
