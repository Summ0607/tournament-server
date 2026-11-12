const DEFAULT_VOLUNTEER_TYPES = [
  ['setup', 'Setup'],
  ['teardown', 'Teardown'],
  ['judging', 'Judging'],
  ['security', 'Security'],
  ['operations', 'Operations'],
  ['awards', 'Awards'],
  ['medical', 'Medical']
];

const ADDITIONAL_VOLUNTEER_TYPES = DEFAULT_VOLUNTEER_TYPES.slice(4);

module.exports = { DEFAULT_VOLUNTEER_TYPES, ADDITIONAL_VOLUNTEER_TYPES };
