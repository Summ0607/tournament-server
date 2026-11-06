const DEFAULT_ACCOUNT_POLICY = Object.freeze({
  userIdMinLength: 3,
  userIdMaxLength: 64,
  passwordMinLength: 10,
  passwordMaxLength: 128,
  idleTimeoutMinutes: 30,
  absoluteTimeoutHours: 12,
  failureThreshold: 5,
  failureWindowMinutes: 15,
  cooldownMinutes: 5,
  allowConcurrentSessions: true,
  logoutAllSessions: false,
  revokeOnPasswordReset: true,
  revokeOnRoleChange: true
});

function validateAccountPolicy(input) {
  const fail = (message) => {
    throw Object.assign(new Error(message), { statusCode: 400 });
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Account policy is required.');
  const keys = Object.keys(DEFAULT_ACCOUNT_POLICY);
  if (Object.keys(input).some((key) => !keys.includes(key))) fail('Account policy contains an unknown setting.');
  const ranges = {
    userIdMinLength: [3, 64], userIdMaxLength: [3, 64],
    passwordMinLength: [10, 128], passwordMaxLength: [64, 128],
    idleTimeoutMinutes: [5, 120], absoluteTimeoutHours: [1, 24],
    failureThreshold: [3, 10], failureWindowMinutes: [1, 60], cooldownMinutes: [1, 60]
  };
  const policy = {};
  for (const key of keys) {
    if (ranges[key]) {
      const [min, max] = ranges[key];
      if (!Number.isSafeInteger(input[key]) || input[key] < min || input[key] > max) {
        fail(`${key} must be a whole number from ${min} to ${max}.`);
      }
    } else if (typeof input[key] !== 'boolean') fail(`${key} must be true or false.`);
    policy[key] = input[key];
  }
  if (policy.userIdMinLength > policy.userIdMaxLength) fail('User ID minimum cannot exceed its maximum.');
  if (policy.passwordMinLength > policy.passwordMaxLength) fail('Password minimum cannot exceed its maximum.');
  if (policy.idleTimeoutMinutes > policy.absoluteTimeoutHours * 60) {
    fail('Absolute session duration cannot be shorter than the idle timeout.');
  }
  return policy;
}

module.exports = { DEFAULT_ACCOUNT_POLICY, validateAccountPolicy };
