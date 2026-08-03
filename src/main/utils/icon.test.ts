import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let packaged = false
const execFile = vi.fn()
const spawnSync = vi.fn()
const fileIconToBuffer = vi.fn()

function mockIconTheme(theme: string): void {
  execFile.mockImplementation((_file, _args, _options, callback) => {
    callback(null, `'${theme}'\n`, '')
  })
}

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return packaged
    },
    getPath: vi.fn(() => '')
  }
}))

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile,
  spawnSync
}))

vi.mock('file-icon', () => ({ fileIconToBuffer }))
vi.mock('file-icon-info', () => ({ getIcon: vi.fn() }))
vi.mock('../config', () => ({ getControledMihomoConfig: vi.fn() }))

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
const resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
let tempDir: string
let outerApp: string
let helperExecutable: string
const originalXdgDataHome = process.env.XDG_DATA_HOME
const originalXdgDataDirs = process.env.XDG_DATA_DIRS
const originalLang = process.env.LANG
const originalPath = process.env.PATH

beforeEach(() => {
  packaged = false
  execFile.mockReset()
  spawnSync.mockReset()
  mockIconTheme('Custom')
  fileIconToBuffer.mockReset()
  vi.resetModules()

  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: '/tmp/clash-party-resources'
  })

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clash-party-icon-'))
  outerApp = path.join(tempDir, 'Browser.app')
  helperExecutable = path.join(
    outerApp,
    'Contents',
    'Frameworks',
    'Browser Helper.app',
    'Contents',
    'MacOS',
    'Browser Helper'
  )
  fs.mkdirSync(path.join(outerApp, 'Contents', 'Resources'), { recursive: true })
  fs.mkdirSync(path.dirname(helperExecutable), { recursive: true })
  fs.writeFileSync(path.join(outerApp, 'Contents', 'Resources', 'Browser.icns'), '')
})

afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(tempDir, { recursive: true, force: true })
  if (platformDescriptor) {
    Object.defineProperty(process, 'platform', platformDescriptor)
  }
  if (resourcesPathDescriptor) {
    Object.defineProperty(process, 'resourcesPath', resourcesPathDescriptor)
  } else {
    delete process.resourcesPath
  }
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdgDataHome
  if (originalXdgDataDirs === undefined) delete process.env.XDG_DATA_DIRS
  else process.env.XDG_DATA_DIRS = originalXdgDataDirs
  if (originalLang === undefined) delete process.env.LANG
  else process.env.LANG = originalLang
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  vi.restoreAllMocks()
})

describe('getIconDataURL on macOS', () => {
  it('executes the unpacked file-icon helper in packaged builds', async () => {
    packaged = true
    execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, Buffer.from('packaged-icon'), Buffer.alloc(0))
    })

    const { getIconDataURL } = await import('./icon')
    const result = await getIconDataURL(helperExecutable)

    expect(execFile).toHaveBeenCalledWith(
      path.join(
        '/tmp/clash-party-resources',
        'app.asar.unpacked',
        'node_modules',
        'file-icon',
        'file-icon'
      ),
      [JSON.stringify([{ appOrPID: outerApp, size: 512 }])],
      { encoding: null, maxBuffer: 100 * 1024 * 1024 },
      expect.any(Function)
    )
    expect(fileIconToBuffer).not.toHaveBeenCalled()
    expect(result).toBe(`data:image/png;base64,${Buffer.from('packaged-icon').toString('base64')}`)
  })

  it('uses the file-icon module directly during development', async () => {
    fileIconToBuffer.mockResolvedValue(Buffer.from('development-icon'))

    const { getIconDataURL } = await import('./icon')
    const result = await getIconDataURL(helperExecutable)

    expect(fileIconToBuffer).toHaveBeenCalledWith(outerApp, { size: 512 })
    expect(execFile).not.toHaveBeenCalled()
    expect(result).toBe(
      `data:image/png;base64,${Buffer.from('development-icon').toString('base64')}`
    )
  })
})

describe('desktop entries on Linux', () => {
  it('resolves a shell launcher and GTK theme icon for the localized app name', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    process.env.XDG_DATA_HOME = path.join(tempDir, 'data')
    process.env.XDG_DATA_DIRS = ''
    process.env.LANG = 'zh_CN.UTF-8'

    const applicationsDir = path.join(process.env.XDG_DATA_HOME, 'applications')
    const executable = path.join(tempDir, 'opt', 'google', 'chrome', 'chrome')
    const launcher = path.join(tempDir, 'opt', 'google', 'chrome', 'google-chrome')
    const desktopLauncher = path.join(tempDir, 'bin', 'google-chrome-stable')
    const gnomeSoftwareExecutable = path.join(tempDir, 'bin', 'gnome-software')
    const iconPath = path.join(
      process.env.XDG_DATA_HOME,
      'icons',
      'Custom',
      'apps',
      'scalable',
      'google-chrome.symbolic.svg'
    )
    const gnomeSoftwareIconPath = path.join(
      process.env.XDG_DATA_HOME,
      'icons',
      'Custom',
      '48x48',
      'apps',
      'org.gnome.Software.svg'
    )
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.mkdirSync(path.dirname(launcher), { recursive: true })
    fs.mkdirSync(path.dirname(desktopLauncher), { recursive: true })
    fs.mkdirSync(applicationsDir, { recursive: true })
    fs.mkdirSync(path.dirname(iconPath), { recursive: true })
    fs.mkdirSync(path.dirname(gnomeSoftwareIconPath), { recursive: true })
    fs.writeFileSync(executable, '')
    fs.writeFileSync(gnomeSoftwareExecutable, '')
    fs.chmodSync(gnomeSoftwareExecutable, 0o755)
    fs.writeFileSync(
      launcher,
      '#!/bin/sh\nHERE="$(dirname "$0")"\nexec -a "$0" "$HERE/chrome" "$@"\n'
    )
    fs.symlinkSync(launcher, desktopLauncher)
    fs.writeFileSync(iconPath, '<svg xmlns="http://www.w3.org/2000/svg"/>')
    fs.writeFileSync(gnomeSoftwareIconPath, '<svg xmlns="http://www.w3.org/2000/svg"/>')
    process.env.PATH = path.dirname(gnomeSoftwareExecutable)
    fs.writeFileSync(
      path.join(applicationsDir, 'com.google.Chrome.desktop'),
      `[Desktop Entry]\nName=Google Chrome\nName[zh_CN]=谷歌浏览器\nNoDisplay=true\nExec=env DESKTOPINTEGRATION=1 "${desktopLauncher}" %U\nIcon=google-chrome.symbolic\n\n[Desktop Action NewWindow]\nName=New Window\n`
    )
    fs.writeFileSync(
      path.join(applicationsDir, 'org.gnome.Software.desktop'),
      '[Desktop Entry]\nName=Software\nExec=gnome-software %U\nIcon=org.gnome.Software\n'
    )
    const { findDesktopFile, getIconDataURL } = await import('./icon')
    const { getAppName } = await import('./appName')

    await expect(findDesktopFile(executable)).resolves.toBe(
      path.join(applicationsDir, 'com.google.Chrome.desktop')
    )
    await expect(getAppName(executable)).resolves.toBe('谷歌浏览器')
    await expect(getAppName(gnomeSoftwareExecutable)).resolves.toBe('Software')

    await expect(getIconDataURL(executable)).resolves.toBe(
      `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`
    )
    await expect(getIconDataURL(gnomeSoftwareExecutable)).resolves.toBe(
      `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`
    )
  })

  it('resolves a shared helper process through its socket owner and parent cgroup', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    process.env.XDG_DATA_HOME = path.join(tempDir, 'data')
    process.env.XDG_DATA_DIRS = ''

    const applicationsDir = path.join(process.env.XDG_DATA_HOME, 'applications')
    const desktopFile = path.join(applicationsDir, 'org.example.Browser.desktop')
    fs.mkdirSync(applicationsDir, { recursive: true })
    fs.writeFileSync(
      desktopFile,
      '[Desktop Entry]\nName=Example Browser\nExec=/usr/bin/example-browser\nIcon=example-browser\n'
    )

    const procRoot = path.join(tempDir, 'proc')
    fs.mkdirSync(path.join(procRoot, 'net'), { recursive: true })
    fs.writeFileSync(
      path.join(procRoot, 'net', 'tcp'),
      'sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode\n' +
        '0: 0100007F:C350 0100007F:01BB 01 00000000:00000000 00:00000000 00000000 1000 0 4242\n'
    )

    for (const pid of ['100', '123']) {
      fs.mkdirSync(path.join(procRoot, pid, 'fd'), { recursive: true })
      fs.writeFileSync(path.join(procRoot, pid, 'status'), 'Uid:\t1000\t1000\t1000\t1000\n')
      fs.writeFileSync(path.join(procRoot, pid, 'environ'), '')
    }
    fs.writeFileSync(path.join(procRoot, '123', 'stat'), '123 (WebKitNetworkProcess) S 100')
    fs.writeFileSync(path.join(procRoot, '123', 'cgroup'), '0::/user.slice\n')
    fs.symlinkSync('/usr/libexec/WebKitNetworkProcess', path.join(procRoot, '123', 'exe'))
    fs.symlinkSync('socket:[4242]', path.join(procRoot, '123', 'fd', '8'))
    fs.writeFileSync(path.join(procRoot, '100', 'stat'), '100 (example-browser) S 1')
    fs.writeFileSync(
      path.join(procRoot, '100', 'cgroup'),
      '0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-org.example.Browser-123.scope\n'
    )
    fs.symlinkSync('/usr/bin/example-browser', path.join(procRoot, '100', 'exe'))

    const metadata = {
      network: 'tcp',
      sourceIP: '127.0.0.1',
      sourcePort: '50000',
      processPath: '/usr/libexec/WebKitNetworkProcess',
      uid: 1000
    }
    const readdir = vi.spyOn(fs.promises, 'readdir')
    const { findConnectionPid } = await import('./linux-process')
    const pids = await Promise.all([
      findConnectionPid(metadata, procRoot),
      findConnectionPid({ ...metadata, processPath: '/another/helper' }, procRoot)
    ])

    expect(pids).toEqual([123, 123])
    expect(readdir.mock.calls.filter(([directory]) => directory === procRoot)).toHaveLength(1)

    const { findDesktopFileForConnection } = await import('./icon')
    const firstResolution = findDesktopFileForConnection(metadata, undefined, procRoot)
    const secondResolution = findDesktopFileForConnection(metadata, undefined, procRoot)

    expect(secondResolution).toBe(firstResolution)
    await expect(firstResolution).resolves.toBe(desktopFile)
  })

  it('prefers the current GTK theme inheritance across XDG roots before hicolor defaults', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    mockIconTheme('Current')
    const userDataDir = path.join(tempDir, 'user-data')
    const systemDataDir = path.join(tempDir, 'system-data')
    process.env.XDG_DATA_HOME = userDataDir
    process.env.XDG_DATA_DIRS = systemDataDir

    const executable = path.join(tempDir, 'bin', 'themed-app')
    const applicationsDir = path.join(userDataDir, 'applications')
    const defaultIcon = path.join(
      userDataDir,
      'icons',
      'hicolor',
      '64x64',
      'apps',
      'themed-app.png'
    )
    const themedIcon = path.join(
      systemDataDir,
      'icons',
      'Parent',
      'scalable',
      'apps',
      'themed-app.svg'
    )
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.mkdirSync(applicationsDir, { recursive: true })
    fs.mkdirSync(path.dirname(defaultIcon), { recursive: true })
    fs.mkdirSync(path.dirname(themedIcon), { recursive: true })
    fs.mkdirSync(path.join(systemDataDir, 'icons', 'Current'), { recursive: true })
    fs.writeFileSync(executable, '')
    fs.writeFileSync(defaultIcon, 'installed-default')
    fs.writeFileSync(themedIcon, '<svg id="current-theme"/>')
    fs.writeFileSync(
      path.join(applicationsDir, 'org.example.Themed.desktop'),
      `[Desktop Entry]\nName=Themed App\nExec=${executable}\nIcon=themed-app\n`
    )
    fs.writeFileSync(
      path.join(userDataDir, 'icons', 'hicolor', 'index.theme'),
      '[Icon Theme]\nName=Hicolor\nDirectories=64x64/apps\n\n[64x64/apps]\nSize=64\nContext=Applications\nType=Fixed\n'
    )
    fs.writeFileSync(
      path.join(systemDataDir, 'icons', 'Current', 'index.theme'),
      '[Icon Theme]\nName=Current\nInherits=Parent,hicolor\nDirectories=\n'
    )
    fs.writeFileSync(
      path.join(systemDataDir, 'icons', 'Parent', 'index.theme'),
      '[Icon Theme]\nName=Parent\nDirectories=scalable/apps\n\n[scalable/apps]\nSize=64\nMinSize=16\nMaxSize=512\nContext=Applications\nType=Scalable\n'
    )

    const { getIconDataURL } = await import('./icon')
    await expect(getIconDataURL(executable)).resolves.toBe(
      `data:image/svg+xml;base64,${Buffer.from('<svg id="current-theme"/>').toString('base64')}`
    )
  })

  it('falls back to pixmaps in XDG data directories', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    mockIconTheme('Missing')
    const dataDir = path.join(tempDir, 'data')
    process.env.XDG_DATA_HOME = dataDir
    process.env.XDG_DATA_DIRS = ''
    const executable = path.join(tempDir, 'bin', 'pixmap-app')
    const applicationsDir = path.join(dataDir, 'applications')
    const pixmap = path.join(dataDir, 'pixmaps', 'pixmap-app.svg')
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.mkdirSync(applicationsDir, { recursive: true })
    fs.mkdirSync(path.dirname(pixmap), { recursive: true })
    fs.writeFileSync(executable, '')
    fs.writeFileSync(pixmap, '<svg id="xdg-pixmap"/>')
    fs.writeFileSync(
      path.join(applicationsDir, 'org.example.Pixmap.desktop'),
      `[Desktop Entry]\nName=Pixmap App\nExec=${executable}\nIcon=pixmap-app\n`
    )

    const { getIconDataURL } = await import('./icon')
    await expect(getIconDataURL(executable)).resolves.toBe(
      `data:image/svg+xml;base64,${Buffer.from('<svg id="xdg-pixmap"/>').toString('base64')}`
    )
  })

  it('retries a missing themed icon after the short negative-cache TTL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'))
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const dataDir = path.join(tempDir, 'data')
    process.env.XDG_DATA_HOME = dataDir
    process.env.XDG_DATA_DIRS = ''

    const executable = path.join(tempDir, 'bin', 'late-icon-app')
    const applicationsDir = path.join(dataDir, 'applications')
    const themeRoot = path.join(dataDir, 'icons', 'Custom')
    const iconPath = path.join(themeRoot, '64x64', 'apps', 'late-icon-app.png')
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.mkdirSync(applicationsDir, { recursive: true })
    fs.mkdirSync(path.dirname(iconPath), { recursive: true })
    fs.writeFileSync(executable, '')
    fs.writeFileSync(
      path.join(applicationsDir, 'org.example.LateIcon.desktop'),
      `[Desktop Entry]\nName=Late Icon\nExec=${executable}\nIcon=late-icon-app\n`
    )
    fs.writeFileSync(
      path.join(themeRoot, 'index.theme'),
      '[Icon Theme]\nName=Custom\nDirectories=64x64/apps\n\n[64x64/apps]\nSize=64\nContext=Applications\nType=Fixed\n'
    )

    const { getIconDataURL } = await import('./icon')
    await expect(getIconDataURL(executable)).resolves.toBe('')

    fs.writeFileSync(iconPath, 'late-icon')
    vi.advanceTimersByTime(1001)

    await expect(getIconDataURL(executable)).resolves.toBe(
      `data:image/png;base64,${Buffer.from('late-icon').toString('base64')}`
    )
  })

  it('honors XDG desktop-entry overrides and avoids loose path matches', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const userDataDir = path.join(tempDir, 'user-data')
    const systemDataDir = path.join(tempDir, 'system-data')
    process.env.XDG_DATA_HOME = userDataDir
    process.env.XDG_DATA_DIRS = systemDataDir

    const userApplicationsDir = path.join(userDataDir, 'applications')
    const systemApplicationsDir = path.join(systemDataDir, 'applications')
    const executable = path.join(tempDir, 'opt', 'example', 'example')
    const unrelatedExecutable = path.join(tempDir, 'opt', 'mozilla', 'firefox', 'firefox')
    const unrelatedMountedExecutable = path.join(tempDir, '.mount_Example', 'usr', 'bin', 'firefox')
    const similarlyNamedMountedExecutable = path.join(
      tempDir,
      '.mount_ChatGPTPlugin1a2b3',
      'usr',
      'bin',
      'electron'
    )
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.mkdirSync(path.dirname(unrelatedExecutable), { recursive: true })
    fs.mkdirSync(path.dirname(unrelatedMountedExecutable), { recursive: true })
    fs.mkdirSync(path.dirname(similarlyNamedMountedExecutable), { recursive: true })
    fs.mkdirSync(userApplicationsDir, { recursive: true })
    fs.mkdirSync(systemApplicationsDir, { recursive: true })
    fs.writeFileSync(executable, '')
    fs.writeFileSync(unrelatedExecutable, '')
    fs.writeFileSync(unrelatedMountedExecutable, '')
    fs.writeFileSync(similarlyNamedMountedExecutable, '')

    fs.writeFileSync(
      path.join(userApplicationsDir, 'org.example.App.desktop'),
      '[Desktop Entry]\nHidden=true\n'
    )
    fs.writeFileSync(
      path.join(systemApplicationsDir, 'org.example.App.desktop'),
      `[Desktop Entry]\nName=System App\nExec=${executable}\nIcon=system-app\n`
    )
    fs.writeFileSync(
      path.join(userApplicationsDir, 'org.mozilla.Firefox.desktop'),
      '[Desktop Entry]\nName=Firefox\nExec=/usr/bin/not-firefox\nIcon=firefox\n'
    )
    fs.writeFileSync(
      path.join(userApplicationsDir, 'com.openai.ChatGPT.desktop'),
      `[Desktop Entry]\nName=ChatGPT\nExec=${path.join(tempDir, 'ChatGPT.AppImage')}\nIcon=chatgpt\n`
    )

    const { findDesktopFile, getIconDataURL } = await import('./icon')
    const { getAppName } = await import('./appName')

    await expect(findDesktopFile(executable)).resolves.toBeNull()
    await expect(getAppName(executable)).resolves.toBe('')
    await expect(getIconDataURL(executable)).resolves.toBe('')
    await expect(findDesktopFile(unrelatedExecutable)).resolves.toBeNull()
    await expect(findDesktopFile(unrelatedMountedExecutable)).resolves.toBeNull()
    await expect(findDesktopFile(similarlyNamedMountedExecutable)).resolves.toBeNull()
  })
})
