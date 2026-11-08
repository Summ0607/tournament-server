(function () {
  const ROTATE_MS = 12000;
  const REFRESH_MS = 10000;
  const key = (item) => `${item.ringId}:${item.divisionNumber || ''}`;
  const ringOrder = (a, b) => a.ringLabel.localeCompare(b.ringLabel, undefined, { numeric: true });
  const validWindow = (window) => {
    if (!window) return false;
    const times = [window.earliestAt, window.expectedAt, window.latestAt].map(Date.parse);
    return times.every(Number.isFinite) && times[0] <= times[1] && times[1] <= times[2];
  };
  function fresh(snapshot, now) {
    return snapshot && snapshot.status === 'ready'
      && Date.parse(snapshot.generatedAt) <= now + 5000
      && now - Date.parse(snapshot.generatedAt) < 30000
      && Date.parse(snapshot.validUntil) > now;
  }
  function validate(snapshot) {
    if (!snapshot || snapshot.version !== 1 || !['ready', 'unavailable'].includes(snapshot.status)
      || !Number.isFinite(Date.parse(snapshot.generatedAt)) || !Number.isFinite(Date.parse(snapshot.validUntil))
      || Date.parse(snapshot.validUntil) <= Date.parse(snapshot.generatedAt)
      || !Array.isArray(snapshot.rings) || !Array.isArray(snapshot.upcoming)
      || (snapshot.status === 'ready' && (typeof snapshot.eventName !== 'string' || !snapshot.eventName))) {
      throw new Error('Invalid audience monitor snapshot.');
    }
    const identity = (item) => item && typeof item.ringId === 'string' && typeof item.ringLabel === 'string'
      && typeof item.description === 'string';
    if (snapshot.rings.some((ring) => !identity(ring) || !Array.isArray(ring.phases)
      || (ring.divisionNumber !== null && typeof ring.divisionNumber !== 'string')
      || !['active', 'waiting', 'paused', 'updates-unavailable'].includes(ring.status)
      || (ring.overallProgress != null && (!Number.isFinite(ring.overallProgress)
        || ring.overallProgress < 0 || ring.overallProgress > 100))
      || ring.phases.some((phase) => !phase || typeof phase.label !== 'string'
        || !['complete', 'active', 'upcoming', 'idle'].includes(phase.state)
        || !Number.isFinite(phase.progress) || phase.progress < 0 || phase.progress > 100))
      || snapshot.upcoming.some((item) => !identity(item) || typeof item.divisionNumber !== 'string'
        || !Number.isInteger(item.position) || item.position < 1)) {
      throw new Error('Invalid audience monitor rows.');
    }
    return snapshot;
  }
  function upcomingOrder(a, b) {
    const aTime = validWindow(a.startWindow) ? Date.parse(a.startWindow.expectedAt) : Infinity;
    const bTime = validWindow(b.startWindow) ? Date.parse(b.startWindow.expectedAt) : Infinity;
    return a.position - b.position || aTime - bTime || ringOrder(a, b);
  }
  function reconcile(previous, items) {
    const byKey = new Map(items.map((item) => [key(item), item]));
    const kept = previous.filter((item) => byKey.has(key(item))).map((item) => byKey.get(key(item)));
    const keys = new Set(kept.map(key));
    return kept.concat(items.filter((item) => !keys.has(key(item))));
  }
  function capacity(width, height, rowHeight, minWidth = 320, maxColumns = Infinity) {
    const columns = Math.min(maxColumns, Math.max(1, Math.floor((width + 8) / (minWidth + 8))));
    const rows = Math.max(1, Math.floor((height + 8) / (rowHeight + 8)));
    return { columns, count: columns * rows };
  }
  function windowText(window, showSeconds = false, unavailable = 'Start TBD') {
    if (!validWindow(window)) return unavailable;
    return `~${new Date(window.expectedAt).toLocaleTimeString([], {
      hour: 'numeric', minute: '2-digit', ...(showSeconds ? { second: '2-digit' } : {})
    })}`;
  }
  const api = { ROTATE_MS, REFRESH_MS, key, ringOrder, upcomingOrder, validWindow, fresh, validate, reconcile, capacity, windowText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
  const sections = {
    rings: { items: [], latest: [], page: 0, rowHeight: 80, minWidth: 540, maxColumns: 2 },
    upcoming: { items: [], latest: [], page: 0, rowHeight: 80, minWidth: 540 }
  };
  let snapshot = null;
  let error = '';
  let paused = false;
  let wasFresh = false;
  const status = document.getElementById('connection');
  const sourceRun = document.getElementById('sourceRun');
  async function loadPalette() {
    const notice = document.getElementById('paletteStatus');
    try {
      const response = await fetch('/api/visual-definitions', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`Server returned ${response.status}.`);
      const result = await response.json();
      const tokens = VisualDefinitionRules.colorPresentation(result.values);
      for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value);
      document.documentElement.style.colorScheme = 'normal';
      notice.hidden = true;
    } catch (failure) {
      console.error('Audience monitor could not load saved colors:', failure);
      notice.textContent = `Saved display colors unavailable: ${failure.message} Using the built-in palette. Refresh to retry.`;
      notice.hidden = false;
    }
  }
  let selectedRunId = new URLSearchParams(window.location.search).get('simulatorRunId') || '';
  function ringCard(ring) {
    const labels = { paused: 'Temporarily paused', 'updates-unavailable': 'Updates unavailable' };
    const active = ring.status === 'active' && Boolean(ring.divisionNumber);
    const progress = active && Number.isFinite(ring.overallProgress)
      ? `<div class="overall-progress" role="meter" aria-label="Approximate overall division progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(ring.overallProgress)}"><span style="width:${ring.overallProgress}%"></span></div>`
      : `<span class="ring-status">${esc(labels[ring.status] || (active ? 'Progress unavailable' : 'No current division'))}</span>`;
    const finish = active ? windowText(ring.completionWindow, snapshot?.source === 'simulator', 'Not available') : 'Not available';
    return `<article class="card ring-card"><strong class="ring-label">Ring ${esc(ring.ringLabel)}</strong>
      <div class="division"><strong>${ring.divisionNumber ? `Division ${esc(ring.divisionNumber)}` : 'No current division'}</strong><div class="description">${esc(ring.description)}</div></div>
      <div class="progress-cell"><span class="column-label">Overall progress</span>${progress}</div>
      <div class="time-cell"><span class="column-label">Est. finish</span><strong${!active || !validWindow(ring.completionWindow) || snapshot?.source === 'simulator' ? ' class="compact-time"' : ''}>${esc(finish)}</strong></div></article>`;
  }
  function upcomingCard(item) {
    return `<article class="card upcoming-card"><strong class="ring-label">Ring ${esc(item.ringLabel)}</strong>
      <div class="division"><strong>Division ${esc(item.divisionNumber)}</strong><div class="description">${esc(item.description)}</div></div>
      <div class="time-cell"><span class="column-label">Est. start</span><strong${!validWindow(item.startWindow) || snapshot?.source === 'simulator' ? ' class="compact-time"' : ''}>${esc(windowText(item.startWindow, snapshot?.source === 'simulator', 'Not available'))}</strong></div></article>`;
  }
  function sectionCapacity(section, node) {
    return capacity(node.clientWidth, node.clientHeight, node.clientWidth < 540 ? 112 : section.rowHeight, section.minWidth, section.maxColumns);
  }
  function renderSection(name) {
    const section = sections[name];
    const node = document.getElementById(name);
    const fit = sectionCapacity(section, node);
    const pages = Math.max(1, Math.ceil(section.items.length / fit.count));
    section.page = Math.min(section.page, pages - 1);
    node.style.gridTemplateColumns = `repeat(${fit.columns}, minmax(0, 1fr))`;
    document.getElementById(`${name}Pages`).textContent = pages > 1 ? `Page ${section.page + 1} of ${pages}${paused ? ' - paused' : ''}` : '';
    const usable = !error && fresh(snapshot, Date.now());
    node.innerHTML = !usable ? '<p class="empty">Live information unavailable.</p>'
      : section.items.length ? section.items.slice(section.page * fit.count, (section.page + 1) * fit.count)
        .map(name === 'rings' ? ringCard : upcomingCard).join('')
        : `<p class="empty">${name === 'rings' ? 'No rings configured.' : 'No assigned divisions waiting.'}</p>`;
  }
  function render() {
    document.getElementById('eventName').textContent = snapshot?.eventName || 'Audience Monitor';
    const usable = !error && fresh(snapshot, Date.now());
    status.className = usable ? '' : 'warning';
    status.textContent = error ? `Updates unavailable: ${error} Retrying automatically.`
      : snapshot?.status === 'unavailable' ? 'Waiting for an active event.'
      : usable && snapshot?.source === 'simulator'
        ? `SIMULATION - ${snapshot.simulatorStatus} - estimated times use local clock - refresh every 10 seconds`
      : usable ? `Updated ${new Date(snapshot.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} - live refresh every 10 seconds`
      : 'Data is stale - waiting for fresh updates.';
    renderSection('rings');
    renderSection('upcoming');
    wasFresh = usable;
  }
  async function refresh() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const url = selectedRunId
        ? `/api/simulator/runs/${encodeURIComponent(selectedRunId)}/audience`
        : '/api/rings/monitor';
      const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`Server returned ${response.status}.`);
      const next = validate(await response.json());
      const eventChanged = snapshot?.eventName !== next.eventName;
      snapshot = next;
      error = '';
      for (const name of ['rings', 'upcoming']) {
        const section = sections[name];
        section.latest = next[name].slice().sort(name === 'rings' ? ringOrder : upcomingOrder);
        section.items = eventChanged || name === 'rings' ? section.latest
          : reconcile(section.items, section.latest).sort((a, b) => a.position - b.position);
        if (eventChanged) section.page = 0;
      }
    } catch (failure) {
      error = failure.name === 'AbortError' ? 'Refresh timed out.' : failure.message;
      console.error('Audience monitor refresh failed:', failure);
    } finally {
      clearTimeout(timeout);
      render();
      setTimeout(refresh, REFRESH_MS);
    }
  }
  async function loadSimulatorRuns() {
    try {
      const response = await fetch('/api/simulator/runs', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Server returned ${response.status}.`);
      const result = await response.json();
      const previous = sourceRun.value || selectedRunId;
      sourceRun.replaceChildren();
      sourceRun.disabled = false;
      const activeOption = document.createElement('option');
      activeOption.value = '';
      activeOption.textContent = 'Active event';
      sourceRun.append(activeOption);
      for (const run of result.runs || []) {
        const option = document.createElement('option');
        option.value = run.runId;
        option.textContent = `SIM - ${run.sourceEventName} (${run.status}, ${run.runId.slice(0, 8)})`;
        sourceRun.append(option);
      }
      if (previous && [...sourceRun.options].some((option) => option.value === previous)) {
        sourceRun.value = previous;
        selectedRunId = previous;
      } else if (previous) {
        const unavailable = document.createElement('option');
        unavailable.value = previous;
        unavailable.textContent = `SIM - unavailable (${previous.slice(0, 8)})`;
        sourceRun.append(unavailable);
        sourceRun.value = previous;
        selectedRunId = previous;
      } else {
        sourceRun.value = '';
        selectedRunId = '';
      }
    } catch (failure) {
      console.error('Audience monitor could not load simulator runs:', failure);
      sourceRun.replaceChildren();
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Simulator runs unavailable';
      sourceRun.append(option);
      sourceRun.disabled = true;
      status.className = 'warning';
      status.textContent = `Simulator run list unavailable: ${failure.message}`;
    }
  }
  sourceRun.addEventListener('change', () => {
    selectedRunId = sourceRun.value;
    refresh();
  });
  setInterval(loadSimulatorRuns, 30000);
  setInterval(() => {
    if (paused || document.hidden || error || !fresh(snapshot, Date.now())) return;
    for (const name of ['rings', 'upcoming']) {
      const section = sections[name];
      const node = document.getElementById(name);
      const fit = sectionCapacity(section, node);
      const pages = Math.max(1, Math.ceil(section.items.length / fit.count));
      if (pages > 1) {
        section.items = section.latest;
        section.page = (section.page + 1) % pages;
        renderSection(name);
      }
    }
  }, ROTATE_MS);
  function tickClock() {
    document.getElementById('clock').textContent = new Date(Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  }
  tickClock();
  setInterval(() => {
    tickClock();
    if (wasFresh && !fresh(snapshot, Date.now())) render();
  }, 1000);
  new ResizeObserver(render).observe(document.querySelector('.display'));
  document.getElementById('pause').addEventListener('click', (event) => {
    paused = !paused;
    event.currentTarget.textContent = paused ? 'Resume pages' : 'Pause pages';
    event.currentTarget.setAttribute('aria-pressed', String(paused));
    render();
  });
  document.getElementById('fullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (failure) {
      console.error('Audience monitor fullscreen failed:', failure);
      status.textContent = 'Fullscreen unavailable. Use the browser fullscreen command instead.';
      status.className = 'warning';
    }
  });
  loadPalette();
  loadSimulatorRuns().then(refresh);
})();
