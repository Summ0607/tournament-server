(function (root) {
  const rules = typeof module !== 'undefined' && module.exports ? require('../assets/visual-definitions') : root.VisualDefinitionRules;
  function create({ document, request, confirm }) {
    const node = (id) => document.getElementById(id);
    let saved = null, baseline = '', loading = false, writing = false, token = 0, built = false;
    const fieldId = (field) => `vd-${field.key}`;
    function values() {
      return Object.fromEntries(rules.fields.map((field) => [field.key,
        field.type === 'number' ? Number(node(fieldId(field)).value) : node(fieldId(field)).value]));
    }
    function dirty() { return Boolean(saved && JSON.stringify(values()) !== baseline); }
    function notice(text, error = false) {
      node('vdNotice').textContent = text;
      node('vdNotice').setAttribute('data-state', error ? 'error' : 'info');
    }
    function controls() {
      rules.fields.forEach((field) => {
        node(fieldId(field)).disabled = loading || writing || !saved;
        if (field.type === 'color') node(`${fieldId(field)}-picker`).disabled = loading || writing || !saved;
      });
      node('vdSave').disabled = loading || writing || !saved;
      node('vdDefaults').disabled = loading || writing || !saved;
      node('vdReload').disabled = loading || writing;
    }
    function updatePreview() {
      try {
        node('vdPreview').srcdoc = rules.preview(values());
        node('vdPreview').hidden = false;
        node('vdPreviewError').textContent = '';
      } catch (error) {
        node('vdPreview').hidden = true;
        node('vdPreviewError').textContent = error.message;
      }
      node('vdDirty').textContent = dirty() ? 'Unsaved definitions' : '';
    }
    function populate(next) {
      rules.fields.forEach((field) => {
        node(fieldId(field)).value = next[field.key];
        if (field.type === 'color') node(`${fieldId(field)}-picker`).value = next[field.key];
      });
      updatePreview();
    }
    function build() {
      const groups = [...new Set(rules.fields.map((field) => field.group))];
      node('vdFields').innerHTML = groups.map((group) => `<fieldset class="vd-card"><legend>${group}</legend><div class="vd-fields">` +
        rules.fields.filter((field) => field.group === group).map((field) => {
          const id = fieldId(field);
          const input = field.type === 'font' ? `<select id="${id}"><option value="segoe">Segoe UI / Arial</option><option value="system">System font</option><option value="arial">Arial</option></select>`
            : field.type === 'layout' ? `<select id="${id}"><option value="full-window">Full window</option><option value="inset">Inset frame</option></select>`
            : field.type === 'color' ? `<div class="vd-color"><input id="${id}-picker" type="color" aria-label="${field.label} color picker"><input id="${id}" type="text" pattern="#[0-9a-fA-F]{6}" maxlength="7" required aria-label="${field.label} hex code"></div>`
            : `<input id="${id}" type="number" min="${field.min}" max="${field.max}" step="1" required>`;
          return `<div><label for="${id}">${field.label}</label>${input}</div>`;
        }).join('') + '</div></fieldset>').join('');
      for (const field of rules.fields) {
        node(fieldId(field)).addEventListener('input', () => {
          if (field.type === 'color' && /^#[0-9a-f]{6}$/i.test(node(fieldId(field)).value)) {
            node(`${fieldId(field)}-picker`).value = node(fieldId(field)).value;
          }
          updatePreview();
        });
        if (field.type === 'color') node(`${fieldId(field)}-picker`).addEventListener('input', () => {
          node(fieldId(field)).value = node(`${fieldId(field)}-picker`).value;
          updatePreview();
        });
      }
    }
    async function load() {
      if (!built) { build(); built = true; }
      const current = ++token;
      loading = true; saved = null; node('vdPreview').hidden = true; controls(); notice('Loading saved visual definitions...');
      try {
        const result = await request('/api/visual-definitions');
        if (current !== token) return;
        saved = { revision: result.revision, values: rules.validate(result.values) };
        populate(saved.values);
        baseline = JSON.stringify(values());
        updatePreview();
        notice('Typography, style and dimensions apply to Tournament Management on refresh. Colors remain reference-only.');
      } catch (error) { if (current === token) notice(error.message, true); }
      finally { if (current === token) { loading = false; controls(); } }
    }
    node('vdForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!saved || loading || writing) return;
      let next;
      try { next = rules.validate(values()); }
      catch (error) { notice(error.message, true); return; }
      writing = true; controls(); notice('Saving definitions...');
      try {
        const result = await request('/api/visual-definitions', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ revision: saved.revision, values: next }) });
        saved = { revision: result.revision, values: rules.validate(result.values) };
        populate(saved.values); baseline = JSON.stringify(values()); updatePreview();
        notice('Definitions saved. Refresh Tournament Management to apply typography, style and dimensions. Colors are unchanged.');
      } catch (error) { notice(error.message, true); }
      finally { writing = false; controls(); }
    });
    node('vdDefaults').addEventListener('click', () => {
      if (saved && !loading && !writing && confirm('Replace this draft with the starting reference definitions? Nothing is saved until Save Definitions.')) populate(rules.defaults());
    });
    node('vdReload').addEventListener('click', () => {
      if (!loading && !writing && (!dirty() || confirm('Discard unsaved visual definitions and reload saved values?'))) return load();
    });
    return { load, dirty, busy: () => writing, leave: () => { ++token; loading = false; saved = null; baseline = ''; } };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
  else root.VisualDefinitions = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
