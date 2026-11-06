/* global window, document, fetch */
(async () => {
  const ring = document.getElementById('ring'), status = document.getElementById('status');
  const display = document.getElementById('display'), code = document.getElementById('code');
  const print = document.getElementById('print'), printAll = document.getElementById('printAll');
  const address = document.getElementById('address'), pages = document.getElementById('printPages');
  let busy = false, displayed = false;
  const instructions = 'Scan with the Tournament Scoring App to authorize and assign this tablet to this ring. ' +
    'This code can be reused today and expires at midnight on the server laptop.';
  function controls() {
    ring.disabled = address.disabled = busy;
    display.disabled = printAll.disabled = busy || !ring.options.length;
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
  function generate(ringId) {
    return json('/api/tablet/codes', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ringId, useIp: address.value === 'ip' }) });
  }
  function details(data) {
    return `${data.event} - ${data.day} (server laptop date) - ${data.server}`;
  }
  async function show() {
    if (busy) return;
    invalidate(); busy = true; controls(); status.textContent = '';
    try {
      const data = await generate(ring.value);
      document.getElementById('title').textContent = `Ring ${data.ringLabel}`;
      document.getElementById('details').textContent = details(data);
      const image = document.getElementById('qr');
      image.src = data.image;
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
      let first;
      for (const option of ring.options) {
        const data = await generate(option.value);
        first ||= data;
        if (data.event !== first.event || data.day !== first.day || data.server !== first.server) {
          throw new Error('The active tournament or server day changed. Refresh and print again; no sheets were printed.');
        }
        const sheet = document.createElement('section'); sheet.className = 'print-sheet';
        const title = document.createElement('h2'); title.textContent = `Ring ${data.ringLabel}`;
        const description = document.createElement('p'); description.textContent = details(data);
        const image = document.createElement('img'); image.alt = `Ring ${data.ringLabel} daily QR code`; image.src = data.image;
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
  ring.addEventListener('change', invalidate);
  address.addEventListener('change', invalidate);
  controls();
  try {
    const data = await json('/api/rings/config');
    for (const entry of data.allowedRings) {
      const option = document.createElement('option');
      option.value = entry.ringId; option.textContent = entry.ringLabel; ring.append(option);
    }
    const requested = new URLSearchParams(window.location.search).get('ring');
    if ([...ring.options].some((option) => option.value === requested)) ring.value = requested;
    if (ring.options.length) await show();
    else status.textContent = 'No rings configured for the active tournament.';
  } catch (error) { status.textContent = error.message; }
  finally { controls(); }
})();
