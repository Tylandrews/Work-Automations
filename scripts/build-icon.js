/**
 * Generate Windows .ico (and other platform icons) from the BigFish logo
 * so the installed app shows the icon in taskbar and Start menu.
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const inputPng = path.join(projectRoot, 'Images', 'BigFish_Centered_Logo_Inverted.png');
const outputDir = path.join(projectRoot, 'build');

if (!fs.existsSync(inputPng)) {
  console.warn('build-icon: Images/BigFish_Centered_Logo_Inverted.png not found, skipping icon build.');
  process.exit(0);
}

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

try {
  execSync(
    `npx electron-icon-builder --input="${inputPng.replace(/\\/g, '/')}" --output=build --flatten`,
    { cwd: projectRoot, stdio: 'inherit', shell: true }
  );
  console.log('build-icon: Generated build/icons/icon.ico');
} catch (err) {
  console.warn('build-icon: electron-icon-builder failed. Install it with: npm i -D electron-icon-builder');
  process.exit(0);
}
