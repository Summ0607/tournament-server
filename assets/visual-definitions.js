(function (root) {
  const colors = {
    'Sidebar': {
      sidebarBackground: ['Background', '#212c38'], sidebarText: ['Link text', '#dae3e9'],
      sidebarHeading: ['Section headings', '#8c96a6'], sidebarActive: ['Current page / hover background', '#2d4d4e'],
      sidebarActiveText: ['Current page / hover text', '#ffffff']
    },
    'Page': {
      pageBackground: ['Page background', '#f4f4f6'], panelBackground: ['Cards, tables and forms', '#ffffff'],
      border: ['Borders', '#dcdee4'], text: ['Text', '#1e242d'], secondaryText: ['Secondary text', '#5c6472']
    },
    'Buttons and links': {
      primary: ['Primary buttons', '#456789'], link: ['Links / button hover', '#37526d'],
      buttonText: ['Button text', '#ffffff'], secondary: ['Secondary buttons', '#6d7481']
    },
    'Tables and labels': {
      tableHeading: ['Table headings', '#edf0f3'], rowHover: ['Row hover', '#fafcfc'],
      headingHover: ['Sortable heading hover', '#e2e7ea'], sortedHeading: ['Sorted column heading', '#dae1ea']
    },
    'Messages': {
      successBackground: ['Success background', '#e7f3ea'], successText: ['Success text', '#2c5c37'],
      errorBackground: ['Error background', '#fbe9e5'], errorText: ['Error text / delete buttons', '#b3432b'],
      warningBackground: ['Warning background', '#fff3dc'], warningText: ['Warning text', '#7a5a12']
    }
  };
  const fonts = { system: 'system-ui, "Segoe UI", sans-serif', segoe: '"Segoe UI", Arial, sans-serif', arial: 'Arial, sans-serif' };
  const fields = Object.entries(colors).flatMap(([group, entries]) => Object.entries(entries)
    .map(([key, [label, value]]) => ({ group, key, label, value, type: 'color' })));
  fields.push({ group: 'Typography', key: 'fontFamily', label: 'Font family', value: 'segoe', type: 'font' });
  for (const [group, key, label, value, min, max] of [
    ['Typography', 'bodySize', 'Body text (px)', 12, 11, 20],
    ['Typography', 'secondarySize', 'Secondary text (px)', 11, 10, 18],
    ['Typography', 'pageTitleSize', 'Page title (px)', 18, 14, 32],
    ['Typography', 'sectionTitleSize', 'Section heading (px)', 14, 12, 24],
    ['Typography', 'navSize', 'Navigation text (px)', 13, 11, 18],
    ['Typography', 'lineHeight', 'Text line height (%)', 140, 120, 180],
    ['Typography', 'headingWeight', 'Heading weight (400 normal, 700 bold)', 600, 400, 700],
    ['Typography', 'navWeight', 'Navigation weight (400 normal, 700 bold)', 400, 400, 700],
    ['Spacing and dimensions', 'sidebarWidth', 'Sidebar width (px)', 220, 140, 300],
    ['Spacing and dimensions', 'contentWidth', 'Form / card maximum width (px)', 800, 320, 1400],
    ['Spacing and dimensions', 'pagePadding', 'Page padding (px)', 16, 0, 40],
    ['Spacing and dimensions', 'cardPadding', 'Card padding (px)', 12, 4, 32],
    ['Spacing and dimensions', 'sectionGap', 'Space between sections (px)', 12, 4, 32],
    ['Spacing and dimensions', 'controlHeight', 'Control / button height (px)', 28, 24, 48],
    ['Spacing and dimensions', 'radius', 'Corner radius (px)', 5, 0, 16]
  ]) fields.push({ group, key, label, value, min, max, type: 'number' });
  fields.push({ group: 'Layout', key: 'layout', label: 'Application layout', value: 'full-window', type: 'layout' });
  function defaults() { return Object.fromEntries(fields.map((field) => [field.key, field.value])); }
  function validate(values) {
    if (!values || typeof values !== 'object' || Array.isArray(values) ||
        Object.keys(values).length !== fields.length || Object.keys(values).some((key) => !fields.some((field) => field.key === key))) {
      throw new Error('Provide all visual definition fields, with no unknown fields.');
    }
    return Object.fromEntries(fields.map((field) => {
      const value = values[field.key];
      const valid = field.type === 'color' ? typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
        : field.type === 'font' ? Object.hasOwn(fonts, value)
        : field.type === 'layout' ? ['full-window', 'inset'].includes(value)
        : Number.isSafeInteger(value) && value >= field.min && value <= field.max;
      if (!valid) throw new Error(`Invalid ${field.label}${field.type === 'number' ? `; use a whole number from ${field.min} to ${field.max}` : ''}.`);
      return [field.key, field.type === 'color' ? value.toLowerCase() : value];
    }));
  }
  function preview(values) {
    const v = validate(values);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;background:${v.pageBackground};color:${v.text};font:${v.bodySize}px ${fonts[v.fontFamily]};line-height:${v.lineHeight / 100}}
      .shell{display:flex;min-height:480px;${v.layout === 'inset' ? `margin:16px;border:1px solid ${v.border};border-radius:${v.radius}px;overflow:hidden` : ''}}
      nav{flex:0 0 ${v.sidebarWidth}px;background:${v.sidebarBackground};color:${v.sidebarText};padding:12px;font-size:${v.navSize}px;font-weight:${v.navWeight}}
      nav p{color:${v.sidebarHeading};font-size:${v.secondarySize}px}nav div{padding:8px}nav .active{background:${v.sidebarActive};color:${v.sidebarActiveText}}
      main{padding:${v.pagePadding}px;flex:1;min-width:0}h1,h2{font-weight:${v.headingWeight}}h1{font-size:${v.pageTitleSize}px;margin:0 0 ${v.sectionGap}px}h2{font-size:${v.sectionTitleSize}px;margin:0 0 10px}
      .muted{color:${v.secondaryText};font-size:${v.secondarySize}px}.card{max-width:${v.contentWidth}px;padding:${v.cardPadding}px;background:${v.panelBackground};border:1px solid ${v.border};border-radius:${v.radius}px;margin-top:${v.sectionGap}px}
      input,button{font:inherit;min-height:${v.controlHeight}px;border-radius:${v.radius}px;padding:4px 8px}input{width:100%;border:1px solid ${v.border};margin:5px 0 10px;background:${v.panelBackground};color:${v.text}}
      button{background:${v.primary};color:${v.buttonText};border:0;cursor:pointer}button:hover{background:${v.link}}button.secondary{background:${v.secondary}}a{color:${v.link}}
      table{width:100%;border-collapse:collapse;margin-top:12px}th,td{text-align:left;border:1px solid ${v.border};padding:6px}th{background:${v.tableHeading}}th:hover{background:${v.headingHover}}th.sorted{background:${v.sortedHeading}}tbody tr:hover{background:${v.rowHover}}
      .msg{padding:8px;margin-top:8px;border-radius:${v.radius}px}.success{background:${v.successBackground};color:${v.successText}}.error{background:${v.errorBackground};color:${v.errorText}}.warning{background:${v.warningBackground};color:${v.warningText}}
      @media(max-width:520px){nav{flex-basis:120px}}
      </style></head><body><div class="shell"><nav><strong>Tournament Management</strong><p>ADMINISTRATION</p><div>Server Maintenance</div><div class="active">Visual Definitions</div></nav><main>
      <h1>Visual Definitions Preview</h1><p class="muted">Sample only. Existing screens are unchanged.</p><div class="card"><h2>Sample settings card</h2><label>Team name<input value="Example team"></label><button>Save</button> <button class="secondary">Cancel</button> <a href="#sample">Sample link</a>
      <table id="sample"><thead><tr><th class="sorted">Team</th><th>Discipline</th></tr></thead><tbody><tr><td>Example team</td><td>Team Sparring</td></tr></tbody></table>
      <div class="msg success">Success message</div><div class="msg warning">Warning message</div><div class="msg error">Error message</div></div></main></div></body></html>`;
  }
  function presentation(values) {
    const v = validate(values);
    return Object.fromEntries([
      ['--vd-font', fonts[v.fontFamily]], ['--vd-line-height', String(v.lineHeight / 100)],
      ['--vd-heading-weight', String(v.headingWeight)], ['--vd-nav-weight', String(v.navWeight)],
      ...['bodySize', 'secondarySize', 'pageTitleSize', 'sectionTitleSize', 'navSize', 'sidebarWidth',
        'contentWidth', 'pagePadding', 'cardPadding', 'sectionGap', 'controlHeight', 'radius']
        .map((key) => [`--vd-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, `${v[key]}px`])
    ]);
  }
  const api = { fields, defaults, validate, preview, presentation };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VisualDefinitionRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
