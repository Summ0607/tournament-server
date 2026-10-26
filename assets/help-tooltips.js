(() => {
  const tooltip = document.createElement('div');
  tooltip.id = 'helpTooltip';
  tooltip.className = 'help-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  document.body.appendChild(tooltip);
  const pageHelp = document.createElement('dialog');
  pageHelp.id = 'pageHelp';
  pageHelp.className = 'page-help';
  pageHelp.setAttribute('aria-labelledby', 'pageHelpTitle');
  const helpTitle = document.createElement('h2');
  helpTitle.id = 'pageHelpTitle';
  const helpContent = document.createElement('div');
  const closeHelp = document.createElement('button');
  closeHelp.type = 'button';
  closeHelp.className = 'page-help-close';
  closeHelp.textContent = 'Close help';
  closeHelp.dataset.help = 'Close page help and return to the page.';
  pageHelp.appendChild(helpTitle);
  pageHelp.appendChild(helpContent);
  pageHelp.appendChild(closeHelp);
  document.body.appendChild(pageHelp);
  const helpRoot = document.querySelector('[data-help-root]');
  const helpButton = document.createElement('button');
  helpButton.type = 'button';
  helpButton.className = 'help-trigger';
  helpButton.textContent = '?';
  helpButton.setAttribute('aria-haspopup', 'dialog');
  helpButton.setAttribute('aria-controls', 'pageHelp');
  helpButton.setAttribute('aria-expanded', 'false');
  if (helpRoot) helpRoot.appendChild(helpButton);
  let currentPage = null;
  let contentSignature = '';
  let active = null;
  let hideTimer;
  let showTimer;
  let pointerHeld = false;
  let dragging = false;
  let dismissed = null;

  function hide() {
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    if (active) {
      const ids = (active.getAttribute('aria-describedby') || '').split(/\s+/).filter((id) => id && id !== tooltip.id);
      if (ids.length) active.setAttribute('aria-describedby', ids.join(' '));
      else active.removeAttribute('aria-describedby');
    }
    tooltip.hidden = true;
    active = null;
  }

  function position() {
    if (!active) return;
    const rect = active.getBoundingClientRect();
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    tooltip.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`;
    tooltip.style.top = `${Math.max(12, rect.bottom + height + 8 < innerHeight ? rect.bottom + 8 : rect.top - height - 8)}px`;
  }

  function show(target) {
    clearTimeout(hideTimer);
    if (pointerHeld || dragging || !target || target === dismissed || !target.dataset.help
      || !target.isConnected || target.closest('[hidden]')) return;
    if (active !== target) hide();
    active = target;
    const host = pageHelp.open && pageHelp.contains(target) ? pageHelp : document.body;
    if (tooltip.parentElement !== host) host.appendChild(tooltip);
    tooltip.textContent = target.dataset.help;
    tooltip.hidden = false;
    const ids = new Set((target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    ids.add(tooltip.id);
    target.setAttribute('aria-describedby', [...ids].join(' '));
    position();
  }

  function prepare(root) {
    const elements = [...(root.matches && root.matches('[title], [data-help-source]') ? [root] : []),
      ...root.querySelectorAll('[title], [data-help-source]')];
    elements.forEach((element) => {
      if (element.hasAttribute('title')) {
        const text = element.getAttribute('title');
        if (text) element.dataset.help = text;
        else delete element.dataset.help;
        element.removeAttribute('title');
      }
      if (element.hasAttribute('data-help-source')) element.classList.add('help-source-ready');
    });
  }

  function syncPageHelp() {
    const page = [...document.querySelectorAll('[data-help-page]')].find((item) => !item.closest('[hidden]'));
    if (page !== currentPage) {
      if (pageHelp.open) pageHelp.close();
      currentPage = page;
      contentSignature = '';
    }
    const hidden = !page;
    if (helpButton.hidden !== hidden) helpButton.hidden = hidden;
    if (!page) return;
    const title = `${page.dataset.helpTitle} help`;
    if (helpButton.getAttribute('aria-label') !== title) helpButton.setAttribute('aria-label', title);
    const hint = `Open ${page.dataset.helpTitle} guidance, including its details panel.`;
    if (helpButton.dataset.help !== hint) helpButton.dataset.help = hint;
    const entries = [...document.querySelectorAll('[data-help-source]')].filter((source) =>
      !source.hidden && (page.contains(source) || source.dataset.helpFor === page.dataset.helpPage || source.dataset.helpFor === '*')
    ).map((source) => [source.dataset.helpSource, source.textContent.trim()]).filter(([, text]) => text);
    const signature = JSON.stringify([title, entries]);
    if (signature === contentSignature) return;
    contentSignature = signature;
    helpTitle.textContent = title;
    helpContent.replaceChildren();
    entries.forEach(([heading, text]) => {
      const section = document.createElement('section');
      const label = document.createElement('h3');
      label.textContent = heading;
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      section.appendChild(label);
      section.appendChild(paragraph);
      helpContent.appendChild(section);
    });
  }

  closeHelp.addEventListener('click', () => pageHelp.close());
  pageHelp.addEventListener('close', () => {
    helpButton.setAttribute('aria-expanded', 'false');
    if (!helpButton.hidden) helpButton.focus();
    dismissed = helpButton;
    hide();
  });
  pageHelp.addEventListener('click', (event) => {
    if (event.target !== pageHelp) return;
    const rect = pageHelp.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) pageHelp.close();
  });
  const targetOf = (event) => event.target.closest && event.target.closest('[data-help]');
  document.addEventListener('pointerover', (event) => {
    if (pointerHeld || dragging || event.buttons) return;
    if (tooltip.contains(event.target)) { clearTimeout(hideTimer); return; }
    const target = targetOf(event);
    if (target !== dismissed) dismissed = null;
    if (target === active || target && target.contains(event.relatedTarget)) return;
    hide();
    if (target) showTimer = setTimeout(() => show(target), 650);
  });
  document.addEventListener('pointerout', (event) => {
    const target = targetOf(event);
    if (target && target.contains(event.relatedTarget) || tooltip.contains(event.relatedTarget)) return;
    clearTimeout(showTimer);
    hideTimer = setTimeout(hide, 100);
  });
  document.addEventListener('focusin', (event) => { dismissed = null; show(targetOf(event)); });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', () => { pointerHeld = true; hide(); }, true);
  ['pointerup', 'pointercancel'].forEach((type) => {
    document.addEventListener(type, () => { pointerHeld = false; hide(); }, true);
  });
  document.addEventListener('dragstart', () => { dragging = true; hide(); }, true);
  ['dragend', 'drop'].forEach((type) => {
    document.addEventListener(type, () => { dragging = false; pointerHeld = false; hide(); }, true);
  });
  window.addEventListener('blur', () => { dragging = false; pointerHeld = false; hide(); });
  document.addEventListener('click', (event) => {
    const target = targetOf(event);
    if (target === helpButton) {
      event.preventDefault();
      event.stopPropagation();
      hide();
      syncPageHelp();
      if (!pageHelp.open && currentPage) {
        pageHelp.showModal();
        helpButton.setAttribute('aria-expanded', 'true');
        closeHelp.focus();
      }
    } else if (!tooltip.contains(event.target)) hide();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      dismissed = active;
      hide();
      if (pageHelp.open) {
        event.preventDefault();
        event.stopPropagation();
        pageHelp.close();
      }
    }
  });
  document.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  prepare(document);
  syncPageHelp();
  new MutationObserver((records) => {
    records.forEach((record) => {
      if (record.type === 'attributes') prepare(record.target);
      else record.addedNodes.forEach((node) => { if (node.nodeType === 1) prepare(node); });
    });
    syncPageHelp();
    if (active && (!active.isConnected || active.closest('[hidden]'))) hide();
    else if (active && tooltip.textContent !== active.dataset.help) {
      if (active.dataset.help) { tooltip.textContent = active.dataset.help; position(); }
      else hide();
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'hidden', 'data-help', 'data-help-title', 'data-help-for'] });
})();
