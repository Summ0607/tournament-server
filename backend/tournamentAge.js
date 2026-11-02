function validDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) throw new Error('A valid tournament date (YYYY-MM-DD) is required.');
  const [, y, m, d] = match.map(Number), date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) throw new Error('Invalid tournament date.');
  return value;
}
function ageOnDate(dob, date) {
  validDate(date);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob || '');
  const birth = iso ? [iso[0], iso[2], iso[3], iso[1]] : /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dob || '');
  if (!birth) throw new Error('A valid birth date is required for conversion.');
  const [, m, d, y] = birth.map(Number), check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) throw new Error('Invalid birth date.');
  const [year, month, day] = date.split('-').map(Number);
  const age = year - y - (month < m || month === m && day < d ? 1 : 0);
  if (age < 0 || age > 120) throw new Error('Age must be between 0 and 120.');
  return age;
}
function storedAge(person, date) {
  validDate(date);
  if (!Number.isInteger(person.age) || person.age < 0 || person.age > 120 || person.ageAsOf !== date) {
    throw new Error('Tournament age is missing or stale. Reimport or correct age for the tournament date.');
  }
  return person.age;
}
const birthKeys = ['dob', 'dobIso', 'dateOfBirth', 'birthDate'];
function assertNoBirthDates(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (birthKeys.some((name) => name.toLowerCase() === key.toLowerCase())) {
      throw Object.assign(new Error('Birth dates cannot be saved. Refresh and reimport to calculate tournament age.'), { statusCode: 400 });
    }
    assertNoBirthDates(child);
  }
}
function lockAgeDate(directory, date) {
  validDate(date);
  const fs = require('fs'), path = require('path');
  const file = path.join(directory, 'age-context.json');
  if (fs.existsSync(file)) {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).date !== date) throw new Error('Age data is bound to another tournament date.');
  } else require('./atomicJsonFile').writeJsonAtomicSync(file, { date });
}
module.exports = { ageOnDate, validDate, storedAge, lockAgeDate, assertNoBirthDates };
