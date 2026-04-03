/**
 * Generate NSIS Modern UI bitmaps (uncompressed BMP) for the Windows installer.
 * Matches Call Log dark theme (see styles.css [data-theme="dark"]) and BigFish logo.
 * Run via: npm run build:installer-assets (also invoked from prebuild).
 */
const path = require('path')
const fs = require('fs')
const Jimp = require('jimp')

const projectRoot = path.join(__dirname, '..')
const logoPath = path.join(projectRoot, 'Images', 'BigFish_Centered_Logo_Inverted.png')
const outDir = path.join(projectRoot, 'nsis', 'branding')

const ACCENT = Jimp.rgbaToInt(134, 163, 255, 255)

const gradientFill = (img, topRgb, bottomRgb) => {
  const h = img.bitmap.height
  const w = img.bitmap.width
  for (let y = 0; y < h; y++) {
    const k = h <= 1 ? 0 : y / (h - 1)
    const r = Math.round(topRgb.r + (bottomRgb.r - topRgb.r) * k)
    const g = Math.round(topRgb.g + (bottomRgb.g - topRgb.g) * k)
    const b = Math.round(topRgb.b + (bottomRgb.b - topRgb.b) * k)
    const color = Jimp.rgbaToInt(r, g, b, 255)
    for (let x = 0; x < w; x++) {
      img.setPixelColor(color, x, y)
    }
  }
}

const main = async () => {
  if (!fs.existsSync(logoPath)) {
    console.error('generate-nsis-installer-assets: logo not found:', logoPath)
    process.exit(1)
  }

  fs.mkdirSync(outDir, { recursive: true })

  const logo = await Jimp.read(logoPath)
  const top = { r: 11, g: 15, b: 22 }
  const bottom = { r: 16, g: 24, b: 38 }

  const sidebarW = 164
  const sidebarH = 314
  const sidebar = new Jimp(sidebarW, sidebarH)
  gradientFill(sidebar, top, bottom)

  for (let y = 0; y < sidebarH; y++) {
    for (let x = 0; x < 3; x++) {
      sidebar.setPixelColor(ACCENT, x, y)
    }
  }

  const logoSidebar = logo.clone()
  logoSidebar.scaleToFit(130, 88)
  const lx = Math.floor((sidebarW - logoSidebar.bitmap.width) / 2)
  const ly = 40
  sidebar.composite(logoSidebar, lx, ly)

  const font = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE)
  const titleY = ly + logoSidebar.bitmap.height + 14
  sidebar.print(
    font,
    0,
    titleY,
    {
      text: 'Call Log',
      alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
      alignmentY: Jimp.VERTICAL_ALIGN_TOP
    },
    sidebarW,
    120
  )

  const subY = titleY + 22
  sidebar.print(
    font,
    0,
    subY,
    {
      text: 'BigFish',
      alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
      alignmentY: Jimp.VERTICAL_ALIGN_TOP
    },
    sidebarW,
    80
  )

  const sidebarOut = path.join(outDir, 'installer-sidebar.bmp')
  await sidebar.writeAsync(sidebarOut)

  const headerW = 150
  const headerH = 57
  const header = new Jimp(headerW, headerH)
  gradientFill(header, bottom, top)

  const logoHeader = logo.clone()
  logoHeader.scaleToFit(42, 42)
  const hx = 8
  const hy = Math.floor((headerH - logoHeader.bitmap.height) / 2)
  header.composite(logoHeader, hx, hy)

  const textX = hx + logoHeader.bitmap.width + 10
  const textY = Math.floor((headerH - 16) / 2)
  header.print(font, textX, textY, 'Call Log')

  const headerOut = path.join(outDir, 'installer-header.bmp')
  await header.writeAsync(headerOut)

  console.log('generate-nsis-installer-assets:', sidebarOut)
  console.log('generate-nsis-installer-assets:', headerOut)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
