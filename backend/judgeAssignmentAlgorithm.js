const POSITIONS = ['center', 'corner', 'sktk'];
const minimums = (discipline) => ({ center: 1, corner: discipline === 'black-belt' ? 4 : 2, sktk: 1 });
const preferred = { center: 1, corner: 4, sktk: 2 };
function progressionOpportunity(judge, role) {
  const progression = judge.progression;
  if (!progression || progression.recertifying || progression.experienceCount >= progression.requiredExperience) return false;
  return judge.certification === 'SK_TK' && role === 'sktk' && progression.targetLevel === 'CORNER' ||
    judge.certification === 'CORNER' && role === 'corner' && progression.targetLevel === 'REGIONAL' ||
    judge.certification === 'REGIONAL' && role === 'center' && progression.targetLevel === 'INTERNATIONAL';
}
function allocate(judges, counts) {
  const source = 0, firstJudge = 1, firstRole = judges.length + 1, sink = firstRole + 3;
  const graph = Array.from({ length: sink + 1 }, () => []);
  function edge(from, to, capacity, cost) {
    const item = { to, capacity, cost, reverse: graph[to].length };
    graph[from].push(item);
    graph[to].push({ to: from, capacity: 0, cost: -cost, reverse: graph[from].length - 1 });
    return item;
  }
  const links = [];
  judges.forEach((judge, index) => {
    edge(source, firstJudge + index, 1, 0);
    POSITIONS.forEach((role, roleIndex) => {
      if (judge.roles[role]) {
        const priority = Number.isSafeInteger(judge.priority) ? judge.priority : 6;
        const preference = priority * (judges.length + 1) + Number(progressionOpportunity(judge, role));
        links.push({ judge, role, edge: edge(firstJudge + index, firstRole + roleIndex, 1, -preference) });
      }
    });
  });
  POSITIONS.forEach((role, index) => edge(firstRole + index, sink, counts[role], 0));
  let flow = 0;
  for (;;) {
    const distances = Array(graph.length).fill(Infinity), previous = [];
    distances[source] = 0;
    for (let pass = 0; pass < graph.length - 1; pass++) {
      let changed = false;
      graph.forEach((edges, from) => edges.forEach((item, index) => {
        if (item.capacity && distances[from] + item.cost < distances[item.to]) {
          distances[item.to] = distances[from] + item.cost; previous[item.to] = { from, index }; changed = true;
        }
      }));
      if (!changed) break;
    }
    if (!previous[sink]) break;
    for (let node = sink; node !== source;) {
      const step = previous[node], item = graph[step.from][step.index];
      item.capacity--; graph[node][item.reverse].capacity++; node = step.from;
    }
    flow++;
  }
  return { flow, assignments: links.filter((link) => !link.edge.capacity) };
}
function autoAssign(judges, rings, discipline) {
  const minimum = minimums(discipline);
  let selected, operating;
  const maximum = Math.min(rings.length, Math.floor(judges.length / Object.values(minimum).reduce((a, b) => a + b, 0)),
    ...POSITIONS.map((role) => Math.floor(judges.filter((judge) => judge.roles[role]).length / minimum[role])));
  for (let count = maximum; count >= 0; count--) {
    const counts = Object.fromEntries(POSITIONS.map((role) => [role, minimum[role] * count]));
    selected = allocate(judges, counts);
    if (selected.flow === Object.values(counts).reduce((a, b) => a + b, 0)) { operating = rings.slice(0, count); break; }
  }
  const assignments = Object.fromEntries(rings.map((ring) => [ring, { center: [], corner: [], sktk: [] }]));
  const used = new Set();
  for (const { judge, role } of selected.assignments) {
    const ring = operating.find((id) => assignments[id][role].length < minimum[role]);
    assignments[ring][role].push(judge.id); used.add(judge.id);
  }
  for (const role of ['corner', 'sktk']) {
    const extras = judges.filter((judge) => !used.has(judge.id) && judge.roles[role])
      .sort((a, b) => (b.priority ?? 6) - (a.priority ?? 6) ||
        Number(progressionOpportunity(b, role)) - Number(progressionOpportunity(a, role)) || a.id.localeCompare(b.id));
    for (let slot = minimum[role]; slot < preferred[role]; slot++) {
      for (const ring of operating) {
        const judge = extras.shift();
        if (judge) { assignments[ring][role].push(judge.id); used.add(judge.id); }
      }
    }
  }
  return { assignments, operatingRings: operating.length,
    reasons: Object.fromEntries(selected.assignments.map(({ judge, role }) => [judge.id,
      progressionOpportunity(judge, role) ? 'Qualified role provides needed progression experience.' : 'Qualified role fills required staffing.'])) };
}
module.exports = { POSITIONS, minimums, preferred, autoAssign, progressionOpportunity };
