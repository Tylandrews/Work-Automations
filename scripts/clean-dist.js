/**
 * Remove dist folder so electron-builder can run clean.
 * If files are locked (e.g. app is running), print a clear message and exit with code 1.
 */
const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(distDir)) {
  process.exit(0);
}

try {
  fs.rmSync(distDir, { recursive: true, force: true });
  console.log('clean: Removed dist folder.');
  process.exit(0);
} catch (err) {
  if (err.code === 'EBUSY' || err.code === 'EPERM' || err.errno === -4082) {
    console.error('');
    console.error('Could not remove dist: a file is in use (often the app is still running).');
    console.error('  → Close "Call Log" completely, then run again:');
    console.error('    npm run build-win:fresh');
    console.error('');
    process.exit(1);
  }
  throw err;
}
