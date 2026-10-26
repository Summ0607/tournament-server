const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const script = fs.readFileSync(path.join(__dirname, '..', 'assets', 'help-tooltips.js'), 'utf8');

function loadTooltips() {
  const handlers = {};
  const timers = new Map();
  let timerId = 0;
  let time = 0;
  let mutations;
  class Element {
    constructor() {
      this.nodeType = 1;
      this.attributes = new Map();
      this.dataset = {};
      this.children = [];
      this.style = {};
      this.handlers = {};
      this.open = false;
      this.hidden = false;
      this.textContent = '';
      this.className = '';
      this.classList = {
        contains: (name) => this.className.split(' ').includes(name),
        add: (name) => { this.className += ` ${name}`; }
      };
    }
    get isConnected() { return this === body || Boolean(this.parent && this.parent.isConnected); }
    get parentElement() { return this.parent; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) || null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    matches(selector) {
      return selector.split(', ').some((part) => part === '[title]' ? this.hasAttribute('title')
        : part === '[data-help-source]' ? this.hasAttribute('data-help-source')
          : part === '[data-help-page]' ? Boolean(this.dataset.helpPage)
            : part === '[data-help-root]' ? this.hasAttribute('data-help-root')
          : part === '[data-help]' ? Boolean(this.dataset.help) : part === '[hidden]' && this.hidden);
    }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    appendChild(child) {
      if (child.parent) child.remove();
      child.parent = this;
      this.children.push(child);
    }
    replaceChildren() { this.children.forEach((child) => { child.parent = null; }); this.children = []; }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    focus() { document.activeElement = this; }
    showModal() { this.returnFocus = document.activeElement; this.open = true; }
    close() { this.open = false; document.activeElement = this.returnFocus; if (this.handlers.close) this.handlers.close(); }
    before(child) { child.parent = this.parent; this.parent.children.splice(this.parent.children.indexOf(this), 0, child); }
    remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    contains(child) { return Boolean(child && (child === this || this.children.some((item) => item.contains(child)))); }
    closest(selector) { return this.matches(selector) ? this : this.parent ? this.parent.closest(selector) : null; }
    getBoundingClientRect() { return { left: 900, top: 400, bottom: 424 }; }
    get offsetWidth() { return 200; }
    get offsetHeight() { return 60; }
  }
  const body = new Element();
  const title = new Element();
  title.setAttribute('data-help-root', '');
  const view = new Element();
  view.dataset.helpPage = 'test';
  view.dataset.helpTitle = 'Test page';
  const source = new Element();
  source.dataset.helpSource = 'Page help';
  source.setAttribute('data-help-source', 'Page help');
  source.textContent = 'Instruction text';
  const button = new Element();
  button.setAttribute('title', 'Action help');
  body.appendChild(title);
  body.appendChild(view);
  view.appendChild(source);
  body.appendChild(button);
  const document = {
    body, activeElement: null,
    createElement: () => new Element(),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    querySelector: () => title,
    addEventListener: (event, handler) => { handlers[event] = handler; }
  };
  vm.runInNewContext(script, {
    document, window: { addEventListener: (event, handler) => { handlers[event] = handler; } },
    innerWidth: 1000, innerHeight: 500,
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, at: time + delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    MutationObserver: class {
      constructor(callback) { mutations = callback; }
      observe() {}
    }
  });
  return {
    body, title, view, source, button, document,
    get tooltip() { return body.children.find((child) => child.id === 'helpTooltip') || this.dialog.children.find((child) => child.id === 'helpTooltip'); },
    get dialog() { return body.children.find((child) => child.id === 'pageHelp'); },
    trigger: () => title.children[0],
    event: (type, target, extra = {}) => handlers[type]({ target, preventDefault() {}, stopPropagation() {}, ...extra }),
    mutate: (target = source, type = 'attributes') => mutations([{ type, target, addedNodes: [] }]),
    flush: (ms = 1000) => {
      time += ms;
      for (const [id, timer] of timers) {
        if (timer.at <= time) { timers.delete(id); timer.callback(); }
      }
    }
  };
}

test('one page help trigger gathers guidance into a modal rather than creating individual question marks', () => {
  const page = loadTooltips();
  const trigger = page.trigger();
  assert.equal(trigger.type, 'button');
  assert.equal(trigger.getAttribute('aria-label'), 'Test page help');
  assert.equal(page.title.children.length, 1);
  assert.ok(page.source.classList.contains('help-source-ready'));
  page.document.activeElement = trigger;
  page.event('click', trigger);
  assert.equal(page.dialog.open, true);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(page.dialog.children[1].children[0].children[1].textContent, 'Instruction text');
  assert.equal(page.document.activeElement.textContent, 'Close help');
  page.event('focusin', page.dialog.children[2]);
  assert.equal(page.tooltip.parentElement, page.dialog, 'modal action tooltip stays in the top layer');
  page.dialog.children[2].handlers.click();
  assert.equal(page.dialog.open, false);
  assert.equal(page.document.activeElement, trigger);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  page.event('click', trigger);
  page.event('keydown', trigger, { key: 'Escape' });
  assert.equal(page.dialog.open, false);
});

test('action tooltips preserve accessible descriptions and fit within the viewport', () => {
  const page = loadTooltips();
  page.button.setAttribute('aria-describedby', 'existing');
  page.event('focusin', page.button);
  assert.equal(page.tooltip.textContent, 'Action help');
  assert.equal(page.button.getAttribute('aria-describedby'), 'existing helpTooltip');
  assert.equal(page.tooltip.style.left, '788px');
  assert.equal(page.tooltip.style.top, '432px');
  page.event('keydown', page.button, { key: 'Escape' });
  assert.equal(page.tooltip.hidden, true);
  assert.equal(page.button.getAttribute('aria-describedby'), 'existing');
});

test('hover, touch click, escape and focus dismissal share one tooltip', () => {
  const page = loadTooltips();
  assert.equal(page.button.hasAttribute('title'), false);
  page.event('pointerover', page.button);
  assert.equal(page.tooltip.hidden, true);
  page.flush(650);
  assert.equal(page.tooltip.textContent, 'Action help');
  page.event('pointerout', page.button);
  page.flush();
  assert.equal(page.tooltip.hidden, true);
  const trigger = page.button;
  page.event('focusin', trigger);
  assert.equal(page.tooltip.hidden, false);
  page.event('keydown', trigger, { key: 'Escape' });
  page.event('pointerover', trigger);
  assert.equal(page.tooltip.hidden, true, 'Escape remains dismissed until leaving the trigger');
  page.event('pointerover', page.body);
  page.event('pointerover', trigger);
  page.flush(650);
  assert.equal(page.tooltip.hidden, false);
  page.event('focusout', trigger);
  assert.equal(page.tooltip.hidden, true);
});

test('hover help waits for deliberate hovering and promptly leaves even a focused control', () => {
  const page = loadTooltips();
  page.event('pointerover', page.button);
  page.flush(649);
  assert.equal(page.tooltip.hidden, true);
  page.event('pointerout', page.button);
  page.flush();
  assert.equal(page.tooltip.hidden, true, 'passing over a control never shows a delayed tooltip');
  page.event('pointerover', page.button);
  page.flush(650);
  assert.equal(page.tooltip.hidden, false);
  page.document.activeElement = page.button;
  page.event('pointerout', page.button);
  page.flush(100);
  assert.equal(page.tooltip.hidden, true, 'focus does not pin hover help after the pointer leaves');
});

test('pointer and native drags suppress pending, visible, focus and target hover help', () => {
  const page = loadTooltips();
  page.event('pointerover', page.button);
  page.event('pointerdown', page.button);
  page.event('focusin', page.button);
  page.event('pointerover', page.trigger(), { buttons: 1 });
  page.flush();
  assert.equal(page.tooltip.hidden, true);
  page.event('pointerup', page.button);
  page.flush();
  assert.equal(page.tooltip.hidden, true, 'release does not reopen a tooltip over the drop target');
  page.event('focusin', page.button);
  assert.equal(page.tooltip.hidden, false, 'keyboard focus still provides immediate help');
  page.event('dragstart', page.button);
  assert.equal(page.tooltip.hidden, true);
  page.event('pointerover', page.trigger());
  page.flush();
  assert.equal(page.tooltip.hidden, true);
  page.event('drop', page.body);
  page.event('pointerover', page.button);
  page.flush(650);
  assert.equal(page.tooltip.hidden, false);
  page.event('pointerdown', page.button);
  page.event('pointercancel', page.button);
  page.event('focusin', page.button);
  assert.equal(page.tooltip.hidden, false);
  page.event('blur', page.body);
  assert.equal(page.tooltip.hidden, true);
});

test('page help follows navigation, includes associated details guidance, and hides on incomplete pages', () => {
  const page = loadTooltips();
  page.event('click', page.trigger());
  page.source.textContent = 'Updated <text> is plain text';
  page.mutate();
  assert.equal(page.dialog.children[1].children[0].children[1].textContent, 'Updated <text> is plain text');
  page.view.hidden = true;
  page.mutate();
  assert.equal(page.dialog.open, false);
  assert.equal(page.trigger().hidden, true);
  page.view.hidden = false;
  const details = page.source;
  page.view.replaceChildren();
  page.body.appendChild(details);
  details.dataset.helpFor = 'test';
  page.view.dataset.helpTitle = 'Updated page';
  page.mutate();
  assert.equal(page.trigger().hidden, false);
  assert.equal(page.trigger().getAttribute('aria-label'), 'Updated page help');
  assert.equal(page.dialog.children[1].children.length, 1);
  details.dataset.helpFor = 'other';
  page.mutate();
  assert.equal(page.dialog.children[1].children.length, 0, 'other page guidance is excluded');
});

test('dynamically replaced action descriptions update and removed controls dismiss tooltips', () => {
  const page = loadTooltips();
  page.button.setAttribute('title', 'New action help');
  page.mutate(page.button);
  page.event('focusin', page.button);
  assert.equal(page.tooltip.textContent, 'New action help');
  page.button.remove();
  page.mutate(page.body, 'childList');
  assert.equal(page.tooltip.hidden, true);
});

test('all current page entry points use the shared help assets', () => {
  for (const directory of ['tournament-management', 'ring-assignment', 'head-table', 'competitors']) {
    const html = fs.readFileSync(path.join(__dirname, '..', directory, 'index.html'), 'utf8');
    assert.ok(html.includes('href="/assets/help-tooltips.css"'), directory);
    assert.ok(html.includes('src="/assets/help-tooltips.js" defer'), directory);
    assert.ok(html.includes('data-help-source='), directory);
    assert.ok(html.includes('data-help-root'), directory);
    assert.ok(html.includes('data-help-page='), directory);
  }
});

test('completed integrated pages explain each primary, next-step and maintenance action', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'tournament-management', 'index.html'), 'utf8');
  for (const id of [
    'createEventBtn', 'modifyEventBtn', 'activateEventBtn', 'goToImportBtn', 'deleteEventBtn',
    'resetEventBtn', 'saveMetadataBtn', 'importBtn', 'clearImportBtn', 'importNextBtn',
    'gbBuildBtn', 'gbAddBtn', 'gbSaveBtn', 'gbDoneBtn', 'raRefreshBtn', 'raLayoutBtn',
    'htRefreshBtn', 'htAssignmentBtn', 'clRefreshBtn', 'clSearchBtn', 'clFiltersBtn',
    'clApplyFiltersBtn', 'clClearFiltersBtn', 'clSortName'
  ]) {
    const tag = html.match(new RegExp(`<button\\b[^>]*\\bid="${id}"[^>]*>`));
    assert.ok(tag, id);
    assert.match(tag[0], /(?:data-help|title)="[^"]+"/, id);
  }
  assert.equal((html.match(/\bdata-help-root\b/g) || []).length, 1);
  assert.equal((html.match(/\bdata-help-page=/g) || []).length, 6);
});
