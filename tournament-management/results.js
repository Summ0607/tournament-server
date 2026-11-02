(function (root) {
  function create({ document, request, selectedEvent }) {
    const node = (id) => document.getElementById(id);
    const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    let token = 0, scope = '';
    async function load(keepSource = false) {
      const current = ++token, event = selectedEvent();
      const source = keepSource && scope === event ? node('resultSource').value : 'live';
      if (scope !== event) node('resultSource').innerHTML = '';
      scope = event;
      node('resultCards').innerHTML = ''; node('resultSummary').textContent = '';
      node('resultSource').disabled = true;
      node('resultNotice').textContent = event ? 'Loading results...' : 'Select a tournament above.';
      node('resultNotice').setAttribute('data-state', 'info');
      if (!event) { node('resultSource').innerHTML = ''; return; }
      try {
        const data = await request(`/api/tournament-results?eventName=${encodeURIComponent(event)}&source=${encodeURIComponent(source || 'live')}`);
        if (current !== token || event !== selectedEvent()) return;
        node('resultSource').innerHTML = data.sources.map((row) => `<option value="${esc(row.id)}">${esc(row.label)}</option>`).join('');
        node('resultSource').value = data.source.id; node('resultSource').disabled = false;
        node('resultNotice').textContent = `${data.source.simulation ? 'SIMULATION' : 'Live results'} — ${data.disciplines.join(', ') || 'No completed disciplines'}. Individual medals only. Ties: highest belt rank, then lowest association/member number. Missing or invalid G/D member numbers follow valid numbers. Remaining ties share a rank; top five ranks shown, including ties.${data.correctedAges ? ` ${data.correctedAges} packet ages differ from the saved tournament-age roster; roster ages used.` : ''}`;
        node('resultSummary').textContent = `${data.divisionCount} completed divisions · ${data.competitorCount} competitors · Medals: 1st ${data.medals.first}, 2nd ${data.medals.second}, 3rd ${data.medals.third}`;
        node('resultCards').innerHTML = data.categories.map((category) => `<section class="result-card"><h2>${esc(category.name)} <span>(${category.eligibleCount} eligible)</span></h2><div class="table-wrap"><table aria-label="${esc(category.name)} standings"><thead><tr><th>#</th><th>Competitor</th><th>Association ID</th><th>Rank</th><th>School</th><th>Points</th></tr></thead><tbody>${category.rows.map((row) => `<tr><td>${row.position}</td><td>${esc(row.name)}</td><td>${esc(row.associationNumber)}</td><td>${esc(row.rank)}</td><td>${esc(row.school)}</td><td>${row.points}</td></tr>`).join('') || '<tr><td colspan="6">No medal points recorded for this category.</td></tr>'}</tbody></table></div></section>`).join('');
      } catch (error) {
        if (current === token) {
          node('resultNotice').textContent = error.message; node('resultNotice').setAttribute('data-state', 'error');
          node('resultSource').disabled = !node('resultSource').innerHTML;
        }
      }
    }
    node('resultSource').addEventListener('change', () => load(true));
    node('resultRefresh').addEventListener('click', () => load(true));
    return { load, leave: () => { ++token; } };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
  else root.TournamentResultsWorkspace = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
