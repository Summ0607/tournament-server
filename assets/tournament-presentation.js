(function (root) {
  async function load({ document, request, rules }) {
    const status = document.getElementById('presentationNotice');
    try {
      const result = await request('/api/visual-definitions');
      const values = rules.validate(result.values);
      const shell = document.querySelector('.shell');
      for (const [key, value] of Object.entries(rules.presentation(values))) shell.style.setProperty(key, value);
      shell.setAttribute('data-visual-layout', values.layout);
      shell.classList.add('defined-presentation');
      status.hidden = true;
    } catch (error) {
      status.textContent = `Unable to apply visual definitions: ${error.message}. Existing presentation retained.`;
      status.hidden = false;
      console.error('Unable to apply tournament presentation:', error);
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { load };
  else {
    root.TournamentPresentation = { load };
    load({
      document: root.document, rules: root.VisualDefinitionRules,
      request: async (url) => {
        const response = await fetch(url);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
        return result;
      }
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
