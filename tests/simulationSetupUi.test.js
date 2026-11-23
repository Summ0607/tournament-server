const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName.toLowerCase();
    this.children = [];
    this.handlers = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  prepend(node) {
    node.parent = this;
    this.children.unshift(node);
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  querySelector(selector) { return this.children.find((node) => node.tagName === selector) || null; }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this);
  }
  reportValidity() { return true; }
}

test('Simulation Setup previews ring capacity and creates an openable isolated workspace', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'simulation-setup', 'index.html'), 'utf8');
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], new Element()]));
  nodes.get('eventName').value = 'Regional Simulation';
  nodes.get('competitorCount').value = '600';
  const requests = [];
  const context = vm.createContext({
    document: {
      getElementById: (id) => nodes.get(id),
      createElement: (tag) => new Element(tag)
    },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      const creating = options.method === 'POST';
      return {
        ok: true,
        json: async () => creating ? {
          workspace: { id: 'sim-1', name: 'Regional Simulation', eventDate: '2040-01-15',
            competitorCount: 130, ringCount: 8, judgeCount: 180, volunteerCount: 80,
            judgeTargetCount: 68, judgingVolunteerCount: 58, supportVolunteerCount: 22 },
          url: 'http://127.0.0.1:3456/'
        } : { workspaces: [] }
      };
    }
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  await new Promise(setImmediate);

  nodes.get('competitorCount').value = '130';
  nodes.get('competitorCount').handlers.input();
  assert.equal(nodes.get('ringPreview').textContent, '8');
  assert.equal(nodes.get('judgeTargetPreview').textContent, '68');
  assert.equal(nodes.get('judgeCoverageBreakdown').textContent, '58 event volunteers + 10 competitors');
  assert.equal(nodes.get('supportPreview').textContent, '20-23');
  assert.equal(nodes.get('volunteerPreview').textContent, '78-81');

  const submit = nodes.get('setupForm').handlers.submit;
  await submit({ preventDefault() {} });
  const createRequest = requests.find((request) => request.options.method === 'POST');
  assert.equal(createRequest.url, '/api/simulation-workspaces');
  const payload = JSON.parse(createRequest.options.body);
  assert.equal(payload.competitorCount, 130);
  assert.equal(payload.name, 'Regional Simulation');
  assert.equal(nodes.get('notice').dataset.state, 'success');
  const openLink = nodes.get('workspaceList').children[0].children[1].children[0];
  assert.equal(openLink.href, 'http://127.0.0.1:3456/');
  assert.equal(openLink.target, '_blank');
  assert.match(nodes.get('workspaceList').children[0].children[0].children[1].textContent,
    /58 judging \+ 22 support/);
});
