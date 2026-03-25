const fs = require('fs')
const path = require('path')

const rawTag = String(process.argv[2] || '').trim()
if (!rawTag) {
  console.error('ERROR: Release tag argument is required (example: v3.0.2)')
  process.exit(1)
}

if (!/^v\d+\.\d+\.\d+$/.test(rawTag)) {
  console.error(`ERROR: Invalid release tag "${rawTag}". Expected format: vX.Y.Z`)
  process.exit(1)
}

const packageJsonPath = path.join(__dirname, '..', 'package.json')
if (!fs.existsSync(packageJsonPath)) {
  console.error('ERROR: package.json not found')
  process.exit(1)
}

let packageJson
try {
  packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
} catch (err) {
  console.error(`ERROR: Failed to read package.json: ${err.message}`)
  process.exit(1)
}

const packageVersion = String(packageJson.version || '').trim()
const expectedTag = `v${packageVersion}`

if (rawTag !== expectedTag) {
  console.error(`ERROR: Release tag (${rawTag}) does not match package.json version (${expectedTag})`)
  process.exit(1)
}

console.log(`✓ Release tag ${rawTag} matches package.json version ${packageVersion}`)
