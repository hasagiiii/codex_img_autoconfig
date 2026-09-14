const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'darwin') {
  throw new Error('macOS builds must run on macOS. Use a macOS runner or machine.');
}

const projectRoot = path.resolve(__dirname, '..');
const builder = path.join(projectRoot, 'node_modules', '.bin', 'electron-builder');
const outputDirectory = path.join(projectRoot, 'dist');

if (!fs.existsSync(builder)) {
  throw new Error('electron-builder was not found. Run npm install first.');
}

const publish = process.argv.includes('--publish');
const args = ['--mac', 'dmg', 'zip', '--x64', '--arm64'];
if (publish) {
  if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN is required when --publish is used.');
  args.push('--publish', 'always');
}

const result = spawnSync(builder, args, {
  cwd: projectRoot,
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  stdio: 'inherit'
});

if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`electron-builder failed with exit code ${result.status}.`);

const artifacts = fs.readdirSync(outputDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(dmg|zip)$/i.test(entry.name))
  .map((entry) => path.join(outputDirectory, entry.name));
if (!artifacts.length) throw new Error(`Build completed, but no dmg or zip was found in ${outputDirectory}.`);

console.log('Build completed:');
for (const artifact of artifacts) console.log(`  ${artifact}`);
