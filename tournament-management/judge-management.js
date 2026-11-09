(function (root) {
  function create({ document, request, confirm, showPanel }) {
    const node = (id) => document.getElementById(id);
    const fields = ['associationId', 'firstName', 'lastName', 'school', 'rank', 'certification', 'expiration', 'status', 'notes'];
    const levels = ['SK_TK', 'CORNER', 'REGIONAL', 'INTERNATIONAL'];
    const roles = ['JUDGE', 'CORNER_JUDGE', 'CENTER_JUDGE', 'SCOREKEEPER', 'TIMEKEEPER', 'ARBITRATOR'];
    const scopes = ['REGIONAL', 'NATIONAL', 'WORLD', 'IN_HOUSE'];
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const pretty = (value) => String(value || '').replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    let data = null, busy = false, token = 0, editing = false, editId = null, baseline = '', aliasesBaseline = '', origin = 'judge-management';
    let testRecords = [], experienceRecords = [];
    const serviceFields = ['associationId', 'eventId', 'eventName', 'eventDate', 'eventScope', 'location', 'phase', 'role'];
    let serviceOpen = false, serviceId = null, serviceBaseline = '';
    const serviceDraft = () => ({ ...Object.fromEntries(serviceFields.map((field) => [field, node(`jmService-${field}`).value])),
      confirmedCompleted: Boolean(node('jmServiceCompleted').checked) });
    const selected = new Set();
    const draft = () => Object.fromEntries(fields.map((f) => [f, node(`jm-${f}`).value]));
    const visibleAliases = () => Object.fromEntries(fields.map((f) => [f, node(`jmAlias-${f}`).value.split(',').map((v) => v.trim())]));
    const cleaned = (rows, required) => rows.filter((row) => required.some((field) => row[field] !== '' && row[field] !== null));
    const formDraft = () => ({ judge: draft(), tests: cleaned(testRecords, ['writtenDate', 'writtenScore', 'practicalDate', 'practicalPassed']),
      experience: cleaned(experienceRecords, ['eventName', 'eventDate', 'location', 'role', 'eventScope', 'logVerified']) });
    const dirty = () => editing && JSON.stringify(formDraft()) !== baseline ||
      serviceOpen && JSON.stringify(serviceDraft()) !== serviceBaseline || data && JSON.stringify(visibleAliases()) !== aliasesBaseline;
    function notice(message, error = false) {
      node('jmNotice').textContent = message;
      node('jmNotice').setAttribute('data-state', error ? 'error' : 'info');
    }
    function options(id, entries, blank) {
      const current = node(id).value;
      node(id).innerHTML = (blank ? `<option value="">${esc(blank)}</option>` : '') +
        entries.map((entry) => `<option value="${esc(entry.value)}">${esc(entry.label)}</option>`).join('');
      node(id).value = current;
    }
    function label(code) {
      return data?.certificationLevels.find((item) => item.code === code)?.label || pretty(code);
    }
    function render() {
      if (!data) return;
      const text = node('jmSearch').value.trim().toLowerCase();
      const status = node('jmFilterStatus').value, school = node('jmFilterSchool').value;
      const certification = node('jmFilterCertification').value, days = node('jmFilterExpiration').value;
      const today = data.asOf ? new Date(`${data.asOf}T00:00:00`) : new Date(); today.setHours(0, 0, 0, 0);
      const end = new Date(today); if (days) end.setDate(end.getDate() + Number(days));
      const rows = data.judges.filter((j) => {
        const expiry = j.expiration ? new Date(`${j.expiration}T00:00:00`) : null;
        return (!text || `${j.firstName} ${j.lastName} ${j.associationId}`.toLowerCase().includes(text)) &&
          (!status || j.status === status) && (!school || j.school === school) &&
          (!certification || j.certification === certification) && (!days || expiry && expiry <= end);
      });
      node('jmBody').innerHTML = rows.map((j) => `<tr><td><input type="checkbox" data-jm-select="${j.id}" aria-label="Select ${esc(j.firstName)} ${esc(j.lastName)}" ${selected.has(j.id) ? 'checked' : ''}></td><td><button type="button" data-jm-edit="${j.id}">Edit</button></td><td>${esc(j.associationId)}</td><td>${esc(j.lastName)}</td><td>${esc(j.firstName)}</td><td>${esc(j.school)}</td><td>${esc(label(j.certification))}</td><td>${esc(j.expiration)}</td><td>${esc(j.status)}</td></tr>`).join('') || '<tr><td colspan="9">No matching judges.</td></tr>';
      const judges = new Map(data.judges.map((judge) => [judge.id, judge]));
      node('jmTestingBody').innerHTML = (data.tests || []).map((record) => {
        const judge = judges.get(record.judgeId);
        if (!judge) return '';
        const practical = record.practicalDate ? (record.practicalPassed === 1 ? 'Pass' : 'Fail') : '-';
        return `<tr><td>${esc(judge.associationId)}</td><td>${esc(judge.firstName)} ${esc(judge.lastName)}</td><td>${esc(label(record.targetLevel))}</td><td>${esc(record.writtenDate || '-')}</td><td>${record.writtenScore == null ? '-' : `${esc(record.writtenScore)}%`}</td><td>${esc(record.practicalDate || '-')}</td><td>${practical}</td></tr>`;
      }).join('') || '<tr><td colspan="7">No testing records.</td></tr>';
      node('jmExperienceBody').innerHTML = (data.experience || []).map((record) => {
        const judge = judges.get(record.judgeId);
        if (!judge) return '';
        const manual = record.source === 'MANUAL' && record.sourceId;
        return `<tr><td>${esc(judge.associationId)}</td><td>${esc(judge.firstName)} ${esc(judge.lastName)}</td><td>${esc(record.eventName)}${record.phase ? ` (${esc(record.phase)})` : ''}<br>${esc(record.eventId || '')}${manual ? '<br>Coordinator-recorded actual service' : ''}</td><td>${esc(record.eventDate)}</td><td>${esc(record.location)}</td><td>${esc(pretty(record.role))}</td><td>${esc(pretty(record.eventScope))}</td><td>${record.logVerified ? 'Verified' : 'Not verified'} <button type="button" data-jm-verify="${record.id}" data-judge="${judge.id}">${record.logVerified ? 'Unverify' : 'Verify'}</button>${manual ? ` <button type="button" data-jm-service-edit="${record.id}">Correct</button> <button type="button" data-jm-service-delete="${record.id}">Withdraw</button>` : ''}</td></tr>`;
      }).join('') || '<tr><td colspan="8">No experience records.</td></tr>';
      node('jmEligibilityBody').innerHTML = (data.eligibility || []).map((item) => {
        const judge = judges.get(item.judgeId);
        if (!judge) return '';
        const testsPassed = item.writtenPassed && item.practicalPassed;
        const exp = `${item.experienceCount || 0}${item.requiredExperience ? ` / ${item.requiredExperience}` : ''}`;
        const grantDate = data.asOf || new Date().toISOString().slice(0, 10);
        return `<tr><td>${esc(judge.associationId)}</td><td>${esc(judge.firstName)} ${esc(judge.lastName)}</td><td>${esc(judge.rank)}</td><td>${esc(label(judge.certification))}</td><td>${esc(label(item.targetLevel))}</td><td>${esc(exp)}</td><td>${item.writtenPassed ? 'Written pass' : 'Written required'}; ${item.practicalRequired ? item.practicalPassed ? 'Practical pass' : 'Practical required' : 'No practical required'}</td><td>${esc(item.eligible && testsPassed ? 'Ready for coordinator award' : item.status)}${item.reason ? `<br>${esc(item.reason)}` : ''}${item.reviewRequired ? '<br>Coordinator review; certification will not be reset automatically.' : ''}${item.mayJudge === false ? '<br>Cannot judge until Dan rank.' : ''}</td><td><input type="date" data-jm-grant-date="${judge.id}" value="${grantDate}" max="${grantDate}" aria-label="Certification grant date for ${esc(judge.firstName)} ${esc(judge.lastName)}"></td><td><button type="button" data-jm-award="${judge.id}" ${busy || !item.eligible || !testsPassed ? 'disabled' : ''}>Grant</button></td></tr>`;
      }).join('') || '<tr><td colspan="10">No judges to evaluate.</td></tr>';
      node('jmDelete').disabled = busy || !selected.size;
      node('jmServiceFields').disabled = busy;
      for (const id of ['jmServiceAdd', 'jmServiceSave', 'jmServiceCancel']) node(id).disabled = busy;
    }
    function recordOptions(values, selectedValue) {
      return `<option value="">-- Select --</option>${values.map((value) => `<option value="${value}" ${selectedValue === value ? 'selected' : ''}>${esc(pretty(value))}</option>`).join('')}`;
    }
    function renderRecordForms() {
      node('jmExperienceRecords').innerHTML = experienceRecords.map((record, index) => `<div class="jm-card" data-exp-record="${index}">${record.sourceId ? '<p>API service record: read-only here. Verify from Experience.</p>' : ''}<fieldset ${record.sourceId ? 'disabled' : ''}><div class="jm-form-grid">
        <label>Event<input data-exp-field="eventName" maxlength="200" value="${esc(record.eventName)}"></label>
        <label>Date<input data-exp-field="eventDate" type="date" value="${esc(record.eventDate)}"></label>
        <label>Location<input data-exp-field="location" maxlength="200" value="${esc(record.location)}"></label>
        <label>Role<select data-exp-field="role">${recordOptions(roles, record.role)}</select></label>
        <label>Event Scope<select data-exp-field="eventScope">${recordOptions(scopes, record.eventScope)}</select></label>
        <label>Log Verified<select data-exp-field="logVerified"><option value="">-- Select --</option><option value="true" ${record.logVerified === true ? 'selected' : ''}>Yes</option><option value="false" ${record.logVerified === false ? 'selected' : ''}>No</option></select></label>
        </div><button type="button" data-remove-exp="${index}">Remove Record</button></fieldset></div>`).join('');
      node('jmTestRecords').innerHTML = testRecords.map((record, index) => `<div class="jm-card" data-test-record="${index}"><div class="jm-form-grid">
        <label>Certification Level<select data-test-field="targetLevel">${recordOptions(levels, record.targetLevel)}</select></label>
        <label>Written Test Date<input data-test-field="writtenDate" type="date" value="${esc(record.writtenDate)}"></label>
        <label>Written Score (%)<input data-test-field="writtenScore" type="number" min="0" max="100" step="1" value="${esc(record.writtenScore)}"></label>
        <label>Practical Test Date<input data-test-field="practicalDate" type="date" value="${esc(record.practicalDate)}"></label>
        <label>Practical Result<select data-test-field="practicalPassed"><option value="">-- Select --</option><option value="true" ${record.practicalPassed === true ? 'selected' : ''}>Pass</option><option value="false" ${record.practicalPassed === false ? 'selected' : ''}>Fail</option></select></label>
        </div><button type="button" data-remove-test="${index}">Remove Record</button></div>`).join('');
    }
    function setData(value) {
      data = value;
      selected.clear();
      options('jm-rank', data.ranks.map((r) => ({ value: r.code, label: r.label })), '-- Select --');
      options('jm-certification', data.certificationLevels.map((c) => ({ value: c.code, label: c.label })));
      options('jmFilterCertification', data.certificationLevels.map((c) => ({ value: c.code, label: c.label })), 'Any');
      for (const [id, field] of [['jmFilterSchool', 'school'], ['jmFilterStatus', 'status']]) {
        options(id, [...new Set(data.judges.map((j) => j[field]).filter(Boolean))].sort().map((v) => ({ value: v, label: v })), 'Any');
      }
      for (const field of fields) node(`jmAlias-${field}`).value = data.aliases[field].join(', ');
      options('jmService-associationId', data.judges.map((judge) => ({
        value: judge.associationId, label: `${judge.associationId}: ${judge.lastName}, ${judge.firstName}`
      })), 'Select judge');
      options('jmServiceEvent', [...new Map((data.experience || []).filter((record) => record.eventId).map((record) =>
        [record.eventId, { value: record.eventId, label: `${record.eventName} (${record.eventDate}) - ${record.eventId}` }])).values()], 'New event');
      aliasesBaseline = JSON.stringify(visibleAliases());
      render();
    }
    async function load() {
      const current = ++token;
      notice('Loading judge directory...');
      try {
        const result = await request('/api/judge-management');
        if (current !== token) return;
        setData(result); notice('');
      } catch (error) { if (current === token) notice(error.message, true); }
    }
    function begin(source, judge = null) {
      if (busy || !data) return;
      if (serviceOpen && !canLeave()) return;
      origin = source; editId = judge?.id || null;
      for (const field of fields) node(`jm-${field}`).value = judge?.[field] ?? (field === 'certification' ? 'UNKNOWN' : field === 'status' ? 'Active' : '');
      testRecords = (data.tests || []).filter((record) => record.judgeId === judge?.id).map((record) => ({
        targetLevel: record.targetLevel, writtenDate: record.writtenDate || '', writtenScore: record.writtenScore ?? '',
        practicalDate: record.practicalDate || '', practicalPassed: record.practicalPassed == null ? '' : record.practicalPassed === 1
      }));
      experienceRecords = (data.experience || []).filter((record) => record.judgeId === judge?.id).map((record) => ({
        eventName: record.eventName, eventDate: record.eventDate, location: record.location, role: record.role,
        eventScope: record.eventScope, logVerified: Boolean(record.logVerified), sourceId: record.sourceId
      }));
      renderRecordForms();
      baseline = JSON.stringify(formDraft()); editing = true; node('jmError').textContent = '';
      showPanel('jmAdd', judge ? 'Edit Judge' : 'Add Judge');
    }
    function canLeave() {
      if (busy) { notice('Wait for the current Judge Management operation to finish.', true); return false; }
      if (dirty() && !confirm('Discard unsaved Judge Management changes?')) return false;
      editing = false;
      serviceOpen = false; node('jmServiceForm').hidden = true;
      if (data) { for (const field of fields) node(`jmAlias-${field}`).value = data.aliases[field].join(', '); }
      return true;
    }
    async function write(url, method, body, message, form = false) {
      if (!data || busy) return;
      busy = true;
      render();
      try {
        const result = await request(url, { method, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, revision: data.revision }) });
        setData(result);
        if (form) { editing = false; showPanel(origin); }
        notice(typeof message === 'function' ? message(result) : message);
        return true;
      } catch (error) {
        if (form) node('jmError').textContent = error.message;
        else notice(error.message, true);
      } finally { busy = false; render(); }
    }
    function updateRecordRows(event, collection, selector, fieldAttribute) {
      const target = event.target;
      const card = target.closest(selector);
      if (!card) return;
      const index = Number(card.getAttribute(selector === '[data-exp-record]' ? 'data-exp-record' : 'data-test-record'));
      const field = target.getAttribute(fieldAttribute);
      if (!Number.isInteger(index) || !field) return;
      const rows = collection === 'experience' ? experienceRecords : testRecords;
      rows[index][field] = field === 'logVerified' || field === 'practicalPassed'
        ? target.value === '' ? '' : target.value === 'true'
        : target.value;
    }
    node('jmFilter').addEventListener('click', render);
    node('jmBody').addEventListener('click', (event) => {
      const target = event.target.closest('[data-jm-edit]');
      if (target) begin('judge-management', data.judges.find((j) => j.id === Number(target.getAttribute('data-jm-edit'))));
    });
    node('jmBody').addEventListener('change', (event) => {
      const id = Number(event.target.getAttribute('data-jm-select'));
      if (!data?.judges.some((j) => j.id === id)) return;
      if (event.target.checked) selected.add(id); else selected.delete(id);
      render();
    });
    node('jmDelete').addEventListener('click', () => {
      if (selected.size && confirm(`Permanently delete ${selected.size} selected judge(s)?`)) return write('/api/judge-management/delete', 'POST', { ids: [...selected] }, 'Selected judges deleted.');
    });
    node('jmEligibilityBody').addEventListener('click', (event) => {
      const target = event.target.closest('[data-jm-award]');
      if (!target || target.disabled || busy) return;
      const judgeId = Number(target.getAttribute('data-jm-award'));
      const grantDate = node('jmEligibilityBody').querySelector(`[data-jm-grant-date="${judgeId}"]`).value;
      if (grantDate && confirm(`Grant ${label(data.eligibility.find((item) => item.judgeId === judgeId)?.targetLevel)} certification effective ${grantDate}?`)) {
        return write(`/api/judge-management/${judgeId}/award`, 'POST', { grantedAt: grantDate }, 'Certification granted.');
      }
    });
    node('jmExperienceBody').addEventListener('click', (event) => {
      if (busy) return;
      const correction = event.target.closest('[data-jm-service-edit]');
      if (correction) return openService(data.experience.find((record) => record.id === Number(correction.getAttribute('data-jm-service-edit'))));
      const withdrawal = event.target.closest('[data-jm-service-delete]');
      if (withdrawal) {
        if (!canLeave()) return;
        const id = Number(withdrawal.getAttribute('data-jm-service-delete'));
        if (confirm('Withdraw this actual-service record? This removes its experience credit; other service records are retained.')) {
          return write(`/api/judge-management/experience/${id}`, 'DELETE', { confirmedWithdrawal: true }, 'Service withdrawn; progression recalculated.');
        }
        return;
      }
      const target = event.target.closest('[data-jm-verify]');
      if (!target) return;
      if (!canLeave()) return;
      const record = data.experience.find((item) => item.id === Number(target.getAttribute('data-jm-verify')));
      const judge = data.judges.find((item) => item.id === record?.judgeId);
      if (judge && confirm(`${record.logVerified ? 'Remove verification of' : 'Verify'} this experience for ${judge.firstName} ${judge.lastName}?`)) {
        return write('/api/judge-management/experience-verify', 'POST',
          { associationId: judge.associationId, ids: [record.id], verified: !record.logVerified }, 'Experience verification updated.');
      }
    });
    function openService(record = null) {
      if (!data || !canLeave()) return;
      serviceId = record?.id || null;
      const judge = data.judges.find((item) => item.id === record?.judgeId);
      for (const field of serviceFields) node(`jmService-${field}`).value =
        field === 'associationId' ? judge?.associationId || '' : record?.[field] || '';
      node('jmServiceEvent').value = record?.eventId || '';
      node('jmServiceEvent').disabled = Boolean(record);
      for (const field of ['eventId', 'eventName', 'eventDate', 'eventScope']) node(`jmService-${field}`).disabled = Boolean(record);
      node('jmService-eventDate').max = data.asOf || '';
      node('jmServiceCompleted').checked = false;
      node('jmServiceError').textContent = '';
      node('jmServiceTitle').textContent = record ? 'Correct Completed Service (verification will reset)' : 'Record Completed Service';
      node('jmServiceForm').hidden = false; serviceOpen = true;
      serviceBaseline = JSON.stringify(serviceDraft());
    }
    node('jmServiceAdd').addEventListener('click', () => openService());
    node('jmServiceCancel').addEventListener('click', canLeave);
    node('jmServiceEvent').addEventListener('change', () => {
      if (busy || serviceId) return;
      const record = data?.experience.find((item) => item.eventId === node('jmServiceEvent').value);
      for (const field of ['eventId', 'eventName', 'eventDate', 'eventScope']) {
        node(`jmService-${field}`).value = record?.[field] || '';
        node(`jmService-${field}`).disabled = Boolean(record);
      }
      node('jmService-location').value = record?.location || '';
    });
    node('jmServiceForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!data || busy || !serviceOpen) return;
      const draft = serviceDraft();
      if (!draft.confirmedCompleted) { node('jmServiceError').textContent = 'Confirm actual completed service before submitting.'; return; }
      if (!confirm(serviceId ? 'Save this correction and reset verification? The record must be verified again.' :
        'Submit this actual completed service as pending experience?')) return;
      node('jmServiceError').textContent = '';
      const saved = await write(serviceId ? `/api/judge-management/experience/${serviceId}` : '/api/judge-management/experience',
        serviceId ? 'PUT' : 'POST', { associationId: draft.associationId, confirmedCompleted: true,
          ...(serviceId ? { record: draft } : { records: [{ ...draft, source: 'MANUAL' }] }) },
        serviceId ? 'Service corrected; verification reset and progression recalculated.' :
          (result) => result.duplicates ? 'Service already recorded; no duplicate credit added.' : 'Actual service recorded as pending experience. Verify after review.');
      if (saved) { serviceOpen = false; node('jmServiceForm').hidden = true; }
    });
    node('jmExperienceRecords').addEventListener('input', (event) => updateRecordRows(event, 'experience', '[data-exp-record]', 'data-exp-field'));
    node('jmExperienceRecords').addEventListener('change', (event) => updateRecordRows(event, 'experience', '[data-exp-record]', 'data-exp-field'));
    node('jmTestRecords').addEventListener('input', (event) => updateRecordRows(event, 'tests', '[data-test-record]', 'data-test-field'));
    node('jmTestRecords').addEventListener('change', (event) => updateRecordRows(event, 'tests', '[data-test-record]', 'data-test-field'));
    for (const [id, collection, attribute] of [['jmExperienceRecords', 'experience', 'data-remove-exp'], ['jmTestRecords', 'tests', 'data-remove-test']]) {
      node(id).addEventListener('click', (event) => {
        const target = event.target.closest(`[${attribute}]`);
        if (!target) return;
        const rows = collection === 'experience' ? experienceRecords : testRecords;
        rows.splice(Number(target.getAttribute(attribute)), 1); renderRecordForms();
      });
    }
    node('jmExperienceRecordAdd').addEventListener('click', () => { experienceRecords.push({ eventName: '', eventDate: '', location: '', role: '', eventScope: '', logVerified: '' }); renderRecordForms(); });
    node('jmTestRecordAdd').addEventListener('click', () => { testRecords.push({ targetLevel: '', writtenDate: '', writtenScore: '', practicalDate: '', practicalPassed: '' }); renderRecordForms(); });
    node('jmForm').addEventListener('submit', (event) => {
      event.preventDefault();
      return write(editId ? `/api/judge-management/${editId}` : '/api/judge-management', editId ? 'PUT' : 'POST',
        { judge: draft(), tests: formDraft().tests.map((record) => ({ ...record,
          practicalPassed: record.practicalPassed === '' ? '' : record.practicalPassed })),
        experience: formDraft().experience }, 'Judge saved.', true);
    });
    node('jmSaveAliases').addEventListener('click', () => write('/api/judge-management-settings', 'PUT', { aliases: visibleAliases() }, 'CSV settings saved.'));
    node('jmImportRun').addEventListener('click', async () => {
      if (!data || busy) return;
      const file = node('jmCsv').files[0];
      if (!file || file.size > 2 * 1024 * 1024) { notice('Choose a CSV file of at most 2 MB.', true); return; }
      if (!confirm('Import this file? Matching Association IDs will be updated with nonblank CSV values.')) return;
      let text;
      busy = true;
      try { text = await file.text(); } catch (error) { notice(`Unable to read CSV: ${error.message}`, true); return; }
      finally { busy = false; }
      return write('/api/judge-management-import', 'POST', { csv: text }, (result) => `Import complete: ${result.added} added, ${result.updated} updated.`);
    });
    return { load, begin, canLeave, dirty, busy: () => busy, leave: () => { ++token; }, cancel: () => { if (canLeave()) showPanel(origin); } };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
  else root.JudgeManagementWorkspace = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
