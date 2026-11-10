/* global window, document, fetch */
(async () => {
  const division = document.getElementById('division'), status = document.getElementById('status');
  const display = document.getElementById('display'), code = document.getElementById('code');
  const print = document.getElementById('print'), printAll = document.getElementById('printAll');
  const pages = document.getElementById('printPages');
  let busy = false, displayed = false, eventName = '';
  const instructions = 'Scan with the Tournament Scoring App to load this division onto the tablet. ' +
    'The code is self-contained and works without a network connection.';
  function controls() {
    division.disabled = busy;
    display.disabled = printAll.disabled = busy || !division.options.length;
    print.disabled = busy || !displayed;
  }
  function invalidate() {
    displayed = false; code.hidden = true; pages.replaceChildren();
    document.body.classList.remove('printing-all'); controls();
  }
  async function json(url, options) {
    const response = await fetch(url, options);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
    return body;
  }
  function generate(groupIds) {
    return json('/api/divisions/qr-codes', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(groupIds ? { eventName, groupIds } : { eventName }) });
  }
  function entryTitle(entry) {
    return entry.groupDivisionNumber != null ? `Division ${entry.groupDivisionNumber}` : entry.name;
  }
  function details(entry) {
    return `${eventName} - ${entry.name} - ${entry.competitorCount} competitors`;
  }
  async function show() {
    if (busy) return;
    invalidate(); busy = true; controls(); status.textContent = '';
    try {
      const entry = (await generate([division.value])).codes[0];
      if (entry.error) throw new Error(entry.error);
      document.getElementById('title').textContent = entryTitle(entry);
      document.getElementById('details').textContent = details(entry);
      const image = document.getElementById('qr');
      image.src = entry.image;
      await image.decode();
      code.hidden = false; displayed = true;
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; controls(); }
  }
  display.addEventListener('click', show);
  print.addEventListener('click', () => {
    if (!displayed || busy) return;
    document.body.classList.remove('printing-all'); window.print();
  });
  printAll.addEventListener('click', async () => {
    if (busy) return;
    busy = true; controls(); status.textContent = ''; pages.replaceChildren();
    try {
      const data = await generate();
      const failed = data.codes.filter((entry) => entry.error);
      if (failed.length) {
        throw new Error(`No sheets were printed. Fix these divisions first: ${failed
          .map((entry) => `${entryTitle(entry)} (${entry.error})`).join(' ')}`);
      }
      for (const entry of data.codes) {
        const sheet = document.createElement('section'); sheet.className = 'print-sheet';
        const title = document.createElement('h2'); title.textContent = entryTitle(entry);
        const description = document.createElement('p'); description.textContent = details(entry);
        const image = document.createElement('img'); image.alt = `${entryTitle(entry)} QR code`; image.src = entry.image;
        const help = document.createElement('p'); help.textContent = instructions;
        sheet.append(title, description, image, help); pages.append(sheet);
        await image.decode();
      }
      document.body.classList.add('printing-all'); window.print();
    } catch (error) {
      pages.replaceChildren(); document.body.classList.remove('printing-all');
      status.textContent = error.message;
    } finally { busy = false; controls(); }
  });
  window.addEventListener('afterprint', () => {
    document.body.classList.remove('printing-all'); pages.replaceChildren();
  });
  division.addEventListener('change', invalidate);
  controls();
  try {
    const requestedEvent = new URLSearchParams(window.location.search).get('event');
    eventName = (requestedEvent || '').trim() || (await json('/api/events/active')).activeEvent || '';
    if (!eventName) throw new Error('Activate a tournament or open this page with ?event=<name>.');
    const data = await json(`/api/groups?eventName=${encodeURIComponent(eventName)}`);
    for (const group of data.groups || []) {
      const option = document.createElement('option');
      option.value = group.groupDivisionNumber != null ? String(group.groupDivisionNumber) : String(group.groupId || group.id || '');
      const label = group.groupDivisionNumber != null ? `Division ${group.groupDivisionNumber}` : (group.name || option.value);
      const count = Array.isArray(group.competitors) ? group.competitors.length : 0;
      option.textContent = `${label} - ${group.name || ''} (${count})`;
      division.append(option);
    }
    const requested = new URLSearchParams(window.location.search).get('division');
    if ([...division.options].some((option) => option.value === requested)) division.value = requested;
    if (division.options.length) await show();
    else status.textContent = 'No saved divisions for this tournament. Build and save divisions first.';
  } catch (error) { status.textContent = error.message; }
  finally { controls(); }
})();
