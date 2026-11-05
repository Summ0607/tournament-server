const { publishAppRelease } = require('./appRelease');

function parseArguments(args) {
  const options = {};
  const names = { '--apk': 'apkFile', '--aapt2': 'aapt2', '--directory': 'directory' };
  for (let index = 0; index < args.length; index += 2) {
    const name = names[args[index]];
    const value = args[index + 1];
    if (!name || options[name] !== undefined || !value || value.startsWith('--')) {
      throw new Error('Usage: npm run publish:app -- --apk <absolute APK path> --aapt2 <absolute SDK aapt2 path> [--directory <absolute release directory>]');
    }
    options[name] = value;
  }
  if (!options.apkFile || !options.aapt2) {
    throw new Error('Both --apk and --aapt2 are required. No release was published.');
  }
  return options;
}

if (require.main === module) {
  try {
    const manifest = publishAppRelease(parseArguments(process.argv.slice(2)));
    console.log(`Published ${manifest.versionName} (${manifest.versionCode})`);
    console.log(`APK: ${manifest.filename}; size: ${manifest.sizeBytes}; SHA-256: ${manifest.sha256}`);
  } catch (error) {
    console.error('Unable to publish app update:', error.message);
    process.exitCode = 1;
  }
}

module.exports = { parseArguments };
