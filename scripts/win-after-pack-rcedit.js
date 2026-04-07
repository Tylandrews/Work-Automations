/**
 * Apply Windows .exe icon and version resources after files are copied, using the
 * `rcedit` package (normalizePath + argv array). electron-builder's bundled rcedit
 * often fails with "Unable to commit changes" (AV locks, path quirks).
 */
const path = require('path')
const fs = require('fs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

module.exports = async (context) => {
    if (context.electronPlatformName !== 'windows') return

    const { appOutDir, packager } = context
    const appInfo = packager.appInfo
    const winOpts = packager.platformSpecificBuildOptions || {}

    const exeName = `${appInfo.productFilename}.exe`
    const exePath = path.join(appOutDir, exeName)
    if (!fs.existsSync(exePath)) {
        console.warn('win-after-pack-rcedit: exe not found:', exePath)
        return
    }

    const projectRoot = path.join(__dirname, '..')
    const iconPath = path.join(projectRoot, 'build', 'icons', 'icon.ico')
    if (!fs.existsSync(iconPath)) {
        console.warn('win-after-pack-rcedit: build/icons/icon.ico missing, skip')
        return
    }

    const versionString = {
        FileDescription: appInfo.productName,
        ProductName: appInfo.productName,
        LegalCopyright: appInfo.copyright || '',
        InternalName: String(appInfo.productFilename),
        OriginalFilename: ''
    }
    if (appInfo.companyName) {
        versionString.CompanyName = appInfo.companyName
    }
    if (winOpts.legalTrademarks) {
        versionString.LegalTrademarks = winOpts.legalTrademarks
    }

    const options = {
        icon: iconPath,
        'file-version': appInfo.shortVersion || appInfo.buildVersion,
        'product-version': appInfo.shortVersionWindows || appInfo.getVersionInWeirdWindowsForm(),
        'version-string': versionString
    }
    if (winOpts.requestedExecutionLevel && winOpts.requestedExecutionLevel !== 'asInvoker') {
        options['requested-execution-level'] = winOpts.requestedExecutionLevel
    }

    const rcedit = require('rcedit')
    let lastErr
    const maxAttempts = 8
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await rcedit(exePath, options)
            console.log('win-after-pack-rcedit: applied exe icon and version resources')
            return
        } catch (err) {
            lastErr = err
            const msg = err && err.message ? err.message : String(err)
            console.warn(`win-after-pack-rcedit: attempt ${attempt}/${maxAttempts} failed:`, msg)
            if (attempt < maxAttempts) {
                await sleep(500 * attempt)
            }
        }
    }
    throw lastErr
}
