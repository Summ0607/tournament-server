const rules = require('../assets/competition-settings');
const { ageOnDate, storedAge } = require('./tournamentAge');

function compareStanding(a, b) {
  const priority = b.points - a.points || rules.rankCodes.indexOf(b.rank) - rules.rankCodes.indexOf(a.rank);
  if (priority) return priority;
  const numberOf = (person) => {
    const match = /^[GD](\d+)$/i.exec(String(person.associationNumber).trim());
    return match ? BigInt(match[1]) : null;
  };
  const left = numberOf(a), right = numberOf(b);
  if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function aggregate({ packets, roster, settings, date, simulation }) {
  const people = new Map(), medals = { first: 0, second: 0, third: 0 };
  const mapping = { weapons: 'W', hyungs: 'H', sparring: 'S' };
  const medalNames = { '1st': '1st Place', '2nd': '2nd Place', '3rd': '3rd Place', 'Co-3rd': '3rd Place' };
  const pointRows = new Map(settings['medal-points'].map((row) => [row.name, row.points]));
  const types = new Map(settings['competition-types'].map((row) => [row.code, row]));
  const members = new Map(roster.map((row) => [String(row.id), row]));
  const disciplines = new Set();
  let correctedAges = 0;
  for (const packet of packets) {
    for (const participant of packet.participants) {
      const id = String(participant.participantId), member = members.get(id);
      if (!member) throw new Error(`Result competitor ${id} is missing from the source roster.`);
      if (!people.has(id)) {
        const corrected = simulation && participant.age !== member.age;
        const age = storedAge(member, date);
        if (!Number.isInteger(age) || age < 0 || age > 120) throw new Error(`Invalid result age for ${id}.`);
        if (corrected) correctedAges++;
        const gender = member.gender === 'Female' ? 'F' : member.gender === 'Male' ? 'M' : member.gender;
        if (!['F', 'M'].includes(gender)) throw new Error(`Unsupported gender for ${id}.`);
        people.set(id, { id, name: participant.name, associationNumber: member.associationNumber || '',
          rank: participant.rankCode, school: participant.studio, gender, age, points: 0 });
      }
    }
    for (const [key, discipline] of Object.entries(packet.disciplines)) {
      if (discipline.status !== 'COMPLETED') continue;
      const type = types.get(mapping[key]);
      if (!type) throw new Error(`Competition Settings must define ${mapping[key] || key} to score these results.`);
      if (type.isTeam) continue;
      disciplines.add(type.name);
      let thirdCount = 0;
      for (const award of packet.overallAwards[key] || []) {
        const person = people.get(String(award.participantId));
        if (!person || !packet.participants.some((p) => String(p.participantId) === person.id)) throw new Error('Award recipient is missing from its division.');
        const name = medalNames[award.place];
        if (!name) throw new Error(`Unsupported medal placement: ${award.place}.`);
        const isThird = name === '3rd Place';
        const medal = isThird && thirdCount++ > 0 ? '3rd Place (2)' : name;
        if (!pointRows.has(medal)) throw new Error(`Medal Points must define ${medal}.`);
        person.points += pointRows.get(medal);
        medals[isThird ? 'third' : name === '1st Place' ? 'first' : 'second']++;
      }
    }
  }
  const categories = settings['grand-champion-categories'].map((category) => {
    const eligible = [...people.values()].filter((person) => person.gender === category.gender && person.age >= category.minAge &&
      person.age <= category.maxAge && rules.rankCodes.includes(person.rank) &&
      rules.rankCodes.indexOf(person.rank) >= rules.rankCodes.indexOf(category.minRank) &&
      rules.rankCodes.indexOf(person.rank) <= rules.rankCodes.indexOf(category.maxRank));
    const ranked = eligible.filter((person) => person.points > 0).sort((a, b) => compareStanding(a, b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    let position = 0;
    const rows = ranked.map((person, i) => {
      if (!i || compareStanding(person, ranked[i - 1]) !== 0) position = i + 1;
      return { ...person, position };
    }).filter((person) => person.position <= 5);
    return { id: category.id, name: category.name, eligibleCount: eligible.length, rows };
  });
  return { divisionCount: packets.length, competitorCount: people.size, medals, disciplines: [...disciplines], correctedAges, categories };
}
module.exports = { ageOnDate, aggregate };
