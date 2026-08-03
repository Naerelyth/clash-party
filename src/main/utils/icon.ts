import { exec, execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import axios from 'axios'
import { getIcon } from 'file-icon-info'
import { app } from 'electron'
import { getControledMihomoConfig } from '../config'
import { DEFAULT_MIHOMO_PORTS } from '../../shared/appConfig'
import { windowsDefaultIcon, darwinDefaultIcon, otherDevicesIcon } from './defaultIcon'
import {
  findConnectionPid,
  getProcessIdentity,
  type LinuxConnectionMetadata
} from './linux-process'

interface AsyncCacheEntry<T> {
  expiresAt: number
  value: Promise<T>
}

type AsyncCache<T> = Map<string, AsyncCacheEntry<T>>

const MAX_LINUX_METADATA_CACHE_SIZE = 512
const LINUX_METADATA_CACHE_MS = 30_000
const desktopFileCache = new Map<string, string | null>()
const connectionDesktopFileCache: AsyncCache<string | null> = new Map()
let desktopEntries:
  | { expiresAt: number; value: Promise<Map<string, Record<string, string>>> }
  | undefined
let iconThemeOrder: { expiresAt: number; value: Promise<string[]> } | undefined
const themeDirectoryCache: AsyncCache<string[]> = new Map()
const iconPathCache: AsyncCache<string | null> = new Map()
const iconDataCache: AsyncCache<string | null> = new Map()
const realPathCache: AsyncCache<string> = new Map()
const commandPathCache: AsyncCache<string | undefined> = new Map()
const launcherTargetCache: AsyncCache<string[]> = new Map()

function getCachedPromise<T>(
  cache: AsyncCache<T>,
  key: string,
  factory: () => Promise<T>,
  getTtl: (value: T) => number = () => LINUX_METADATA_CACHE_MS
): Promise<T> {
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  if (!cached && cache.size >= MAX_LINUX_METADATA_CACHE_SIZE) {
    cache.delete(cache.keys().next().value as string)
  }
  const value = factory()
  const entry = { expiresAt: Number.POSITIVE_INFINITY, value }
  cache.set(key, entry)
  void value.then(
    (resolved) => {
      entry.expiresAt = Date.now() + getTtl(resolved)
    },
    () => cache.delete(key)
  )
  return value
}

function normalizeExecutableName(value: string): string {
  return path
    .basename(value)
    .toLowerCase()
    .replace(/\.(?:appimage|desktop|exe)$/i, '')
    .replace(/(?:[-_.]?(?:stable|beta|dev|nightly))$/i, '')
}

function cacheDesktopFile(appPath: string, desktopFile: string | null): void {
  if (!desktopFile) {
    desktopFileCache.delete(appPath)
    return
  }
  if (!desktopFileCache.has(appPath) && desktopFileCache.size >= MAX_LINUX_METADATA_CACHE_SIZE) {
    desktopFileCache.delete(desktopFileCache.keys().next().value as string)
  }
  desktopFileCache.set(appPath, desktopFile)
}

export function isIOSApp(appPath: string): boolean {
  const appDir = appPath.endsWith('.app')
    ? appPath
    : appPath.includes('.app')
      ? appPath.substring(0, appPath.indexOf('.app') + 4)
      : path.dirname(appPath)

  return !fs.existsSync(path.join(appDir, 'Contents'))
}

function hasIOSAppIcon(appPath: string): boolean {
  try {
    const items = fs.readdirSync(appPath)
    return items.some((item) => {
      const lower = item.toLowerCase()
      const ext = path.extname(item).toLowerCase()
      return lower.startsWith('appicon') && (ext === '.png' || ext === '.jpg' || ext === '.jpeg')
    })
  } catch {
    return false
  }
}

function hasMacOSAppIcon(appPath: string): boolean {
  const resourcesDir = path.join(appPath, 'Contents', 'Resources')
  if (!fs.existsSync(resourcesDir)) {
    return false
  }

  try {
    const items = fs.readdirSync(resourcesDir)
    return items.some((item) => path.extname(item).toLowerCase() === '.icns')
  } catch {
    return false
  }
}

export function findBestAppPath(appPath: string): string | null {
  if (!appPath.includes('.app') && !appPath.includes('.xpc')) {
    return null
  }

  const parts = appPath.split(path.sep)
  const appPaths: string[] = []

  for (let i = 0; i < parts.length; i++) {
    if (parts[i].endsWith('.app') || parts[i].endsWith('.xpc')) {
      const fullPath = parts.slice(0, i + 1).join(path.sep)
      appPaths.push(fullPath)
    }
  }
  if (appPaths.length === 0) {
    return null
  }
  if (appPaths.length === 1) {
    return appPaths[0]
  }
  for (let i = appPaths.length - 1; i >= 0; i--) {
    const appDir = appPaths[i]
    if (isIOSApp(appDir)) {
      if (hasIOSAppIcon(appDir)) {
        return appDir
      }
    } else {
      if (hasMacOSAppIcon(appDir)) {
        return appDir
      }
    }
  }
  return appPaths[0]
}

async function getMacOSIconBuffer(appPath: string): Promise<Buffer> {
  if (!app.isPackaged) {
    const { fileIconToBuffer } = await import('file-icon')
    return Buffer.from(await fileIconToBuffer(appPath, { size: 512 }))
  }

  const fileIconPath = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    'file-icon',
    'file-icon'
  )

  return new Promise((resolve, reject) => {
    execFile(
      fileIconPath,
      [JSON.stringify([{ appOrPID: appPath, size: 512 }])],
      { encoding: null, maxBuffer: 100 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout)
      }
    )
  })
}

function getDesktopEntry(content: string): Record<string, string> {
  const headerStart = content.search(/^\s*\[Desktop Entry\]\s*$/m)
  if (headerStart === -1) return {}

  const headerEnd = content.indexOf('\n', headerStart)
  const remaining = headerEnd === -1 ? '' : content.slice(headerEnd + 1)
  const nextSection = remaining.search(/^\s*\[/m)
  const entry = nextSection === -1 ? remaining : remaining.slice(0, nextSection)
  const values: Record<string, string> = {}

  for (const line of entry.split(/\r?\n/)) {
    const match = line.match(/^\s*([^=\s]+)\s*=\s*(.*?)\s*$/)
    if (match) values[match[1]] = match[2]
  }

  return values
}

function getDesktopDirectories(): string[] {
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')
  return [
    process.env.XDG_DATA_HOME || path.join(process.env.HOME || '', '.local/share'),
    ...dataDirs
  ]
    .filter(Boolean)
    .map((dir) => path.join(dir, 'applications'))
}

function getDesktopEntries(): Promise<Map<string, Record<string, string>>> {
  if (desktopEntries && desktopEntries.expiresAt > Date.now()) return desktopEntries.value

  desktopFileCache.clear()
  const value = (async () => {
    const entries = new Map<string, Record<string, string>>()
    const desktopIds = new Set<string>()
    for (const directory of getDesktopDirectories()) {
      let files: string[]
      try {
        files = await fs.promises.readdir(directory)
      } catch {
        continue
      }

      const desktopFiles = files.filter((file) => {
        if (!file.endsWith('.desktop') || desktopIds.has(file)) return false
        desktopIds.add(file)
        return true
      })
      for (let index = 0; index < desktopFiles.length; index += 32) {
        const loaded = await Promise.all(
          desktopFiles.slice(index, index + 32).map(async (file) => {
            const desktopFile = path.join(directory, file)
            try {
              const content = await fs.promises.readFile(desktopFile, 'utf8')
              return [desktopFile, getDesktopEntry(content)] as const
            } catch {
              // Ignore unreadable desktop files.
              return null
            }
          })
        )
        for (const item of loaded) {
          if (item) entries.set(item[0], item[1])
        }
      }
    }
    return entries
  })()
  const entry = { expiresAt: Number.POSITIVE_INFINITY, value }
  desktopEntries = entry
  void value.then(
    (resolved) => {
      entry.expiresAt = Date.now() + (resolved.size > 0 ? LINUX_METADATA_CACHE_MS : 1000)
    },
    () => {
      if (desktopEntries === entry) desktopEntries = undefined
    }
  )
  return value
}

function getRealPath(filePath: string): Promise<string> {
  return getCachedPromise(realPathCache, filePath, async () => {
    try {
      return await fs.promises.realpath(filePath)
    } catch {
      return filePath
    }
  })
}

function resolveCommandPath(command: string): Promise<string | undefined> {
  if (path.isAbsolute(command)) return Promise.resolve(command)

  return getCachedPromise(
    commandPathCache,
    command,
    async () => {
      for (const directory of (process.env.PATH || '').split(path.delimiter)) {
        if (!directory) continue
        const candidate = path.join(directory, command)
        try {
          const stat = await fs.promises.stat(candidate)
          if (stat.isFile()) {
            await fs.promises.access(candidate, fs.constants.X_OK)
            return candidate
          }
        } catch {
          // Continue searching PATH.
        }
      }
      return undefined
    },
    (resolved) => (resolved ? LINUX_METADATA_CACHE_MS : 1000)
  )
}

function getLauncherTargets(execPath: string): Promise<string[]> {
  return getCachedPromise(launcherTargetCache, execPath, async () => {
    const launcherPath = await getRealPath(execPath)
    try {
      const stat = await fs.promises.stat(launcherPath)
      if (!stat.isFile() || stat.size > 256 * 1024) return []
    } catch {
      return []
    }

    let content: string
    try {
      content = await fs.promises.readFile(launcherPath, 'utf8')
    } catch {
      return []
    }

    // A launcher is normally a short shell script. Do not try to interpret arbitrary
    // shell code; recognize only direct `exec /path` and the common `$HERE/foo` form.
    if (!content.startsWith('#!') || content.includes('\0')) return []

    const targets = new Set<string>()
    const launcherDirectory = path.dirname(launcherPath)
    for (const match of content.matchAll(
      /\bexec\s+(?:-[^\s]+\s+)*(?:-a\s+\S+\s+)?["']?\$\{?HERE\}?\/([^\s"']+)/g
    )) {
      targets.add(path.join(launcherDirectory, match[1]))
    }
    for (const match of content.matchAll(/\bexec\s+(?:-[^\s]+\s+)*(?:-a\s+\S+\s+)?(\/[^\s"']+)/g)) {
      targets.add(match[1])
    }
    return [...targets]
  })
}

async function matchesDesktopEntry(
  appPath: string,
  desktopPath: string,
  desktopEntry: Record<string, string>
): Promise<boolean> {
  const execPath = getDesktopExecPath(desktopEntry.Exec)
  const appName = normalizeExecutableName(appPath)

  if (!execPath) {
    const desktopName = normalizeExecutableName(path.basename(desktopPath, '.desktop'))
    return !path.isAbsolute(appPath) && desktopName === appName
  }

  const resolvedExecPath = await resolveCommandPath(execPath)
  if (execPath === appPath) {
    return true
  }

  if (
    path.isAbsolute(appPath) &&
    resolvedExecPath &&
    (await getRealPath(appPath)) === (await getRealPath(resolvedExecPath))
  ) {
    return true
  }

  if (!path.isAbsolute(appPath)) return false
  const appRealPath = await getRealPath(appPath)
  for (const target of await getLauncherTargets(resolvedExecPath || execPath)) {
    if ((await getRealPath(target)) === appRealPath) return true
  }
  return false
}

function getDesktopExecPath(execLine?: string): string | undefined {
  if (!execLine) return undefined

  const tokens = Array.from(execLine.matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g), (match) =>
    match.slice(1).find(Boolean)
  ).filter((token): token is string => Boolean(token))

  if (tokens[0] !== 'env') return tokens[0]

  return tokens.slice(1).find((token) => !token.startsWith('-') && !token.includes('='))
}

async function matchesAppPath(
  appPath: string,
  desktopPath: string,
  desktopEntry: Record<string, string>,
  processName?: string
): Promise<boolean> {
  return (
    desktopEntry.Name === appPath ||
    desktopEntry.GenericName === appPath ||
    (Boolean(processName) && desktopEntry.StartupWMClass === processName) ||
    (Boolean(processName) && desktopEntry['X-GNOME-WMClass'] === processName) ||
    (await matchesDesktopEntry(appPath, desktopPath, desktopEntry))
  )
}

export async function findDesktopFile(
  appPath: string,
  processName?: string
): Promise<string | null> {
  const desktopEntryMap = await getDesktopEntries()
  const cacheKey = `${appPath}\0${processName || ''}`
  if (desktopFileCache.has(cacheKey)) return desktopFileCache.get(cacheKey) || null

  let matchedDesktopFile: string | null = null
  const entries = [...desktopEntryMap].filter(([, entry]) => entry.Hidden !== 'true')
  for (let index = 0; index < entries.length; index += 16) {
    const batch = entries.slice(index, index + 16)
    const matches = await Promise.all(
      batch.map(([desktopFile, entry]) => matchesAppPath(appPath, desktopFile, entry, processName))
    )
    const matchIndex = matches.indexOf(true)
    if (matchIndex !== -1) {
      matchedDesktopFile = batch[matchIndex][0]
      break
    }
  }

  cacheDesktopFile(cacheKey, matchedDesktopFile)
  return matchedDesktopFile
}

function decodeSystemdUnit(value: string): string {
  return value.replace(/\\x([\da-f]{2})/gi, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  )
}

function getCgroupAppId(cgroup: string): string | undefined {
  // Ported from Resources' process_data::cgroup::sanitize_cgroup. The lazy
  // launcher group mirrors Rust regex's ungreedy mode.
  const match = cgroup.match(
    /\/(?:app|background)\.slice\/(?:app-|dbus-:)(?:([^-]+)-)??([^-]+?)(?:-\d+|@\d+)?\.(?:scope|service)(?:\s|$)/
  )
  return match ? decodeSystemdUnit(match[2]) : undefined
}

async function findDesktopFileByCgroup(cgroup: string): Promise<string | null> {
  const appId = getCgroupAppId(cgroup)
  if (!appId) return null
  for (const [desktopFile, entry] of await getDesktopEntries()) {
    const id = path.basename(desktopFile, '.desktop')
    const flatpakId = entry['X-Flatpak']
    if (entry.Hidden !== 'true' && (appId === id || flatpakId === appId)) {
      return desktopFile
    }
  }
  return null
}

async function resolveDesktopFileForConnection(
  metadata: LinuxConnectionMetadata,
  processName: string | undefined,
  procRoot: string
): Promise<string | null> {
  const pid = await findConnectionPid(metadata, procRoot)
  if (pid !== undefined) {
    let currentPid = pid
    for (let depth = 0; depth < 16 && currentPid > 1; depth++) {
      const identity = await getProcessIdentity(currentPid, procRoot)
      if (!identity) break
      const byCgroup = await findDesktopFileByCgroup(identity.cgroup)
      if (byCgroup) return byCgroup
      if (identity.appImagePath) {
        const byAppImage = await findDesktopFile(identity.appImagePath)
        if (byAppImage) return byAppImage
      }
      const byExecutable = await findDesktopFile(identity.executablePath)
      if (byExecutable) return byExecutable
      currentPid = identity.parentPid
    }
  }
  return metadata.processPath ? findDesktopFile(metadata.processPath, processName) : null
}

export function findDesktopFileForConnection(
  metadata: LinuxConnectionMetadata,
  processName?: string,
  procRoot = '/proc'
): Promise<string | null> {
  const cacheKey = [
    procRoot,
    metadata.network,
    metadata.sourceIP || '',
    metadata.sourcePort,
    metadata.uid ?? '',
    metadata.processPath || '',
    processName || ''
  ].join('\0')
  const cached = connectionDesktopFileCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  if (!cached && connectionDesktopFileCache.size >= MAX_LINUX_METADATA_CACHE_SIZE) {
    connectionDesktopFileCache.delete(connectionDesktopFileCache.keys().next().value as string)
  }
  const resolved = resolveDesktopFileForConnection(metadata, processName, procRoot)
  const cacheEntry = { expiresAt: Number.POSITIVE_INFINITY, value: resolved }
  connectionDesktopFileCache.set(cacheKey, cacheEntry)
  void resolved.then(
    (desktopFile) => {
      cacheEntry.expiresAt = Date.now() + (desktopFile ? 5000 : 250)
    },
    () => connectionDesktopFileCache.delete(cacheKey)
  )
  return resolved
}

export async function getDesktopEntryNameFromFile(desktopFile: string): Promise<string | null> {
  const desktopEntry = (await getDesktopEntries()).get(desktopFile)
  if (!desktopEntry) return null

  const locale = (process.env.LC_MESSAGES || process.env.LANG || '').split('.')[0]
  const localizedName = locale
    ? desktopEntry[`Name[${locale}]`] || desktopEntry[`Name[${locale.split('_')[0]}]`]
    : undefined

  return localizedName || desktopEntry.Name || null
}

function getIniSection(content: string, section: string): Record<string, string> {
  const escapedSection = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const start = content.search(new RegExp(`^\\s*\\[${escapedSection}\\]\\s*$`, 'm'))
  if (start === -1) return {}
  const remaining = content.slice(content.indexOf('\n', start) + 1)
  const end = remaining.search(/^\s*\[/m)
  const values: Record<string, string> = {}
  for (const line of (end === -1 ? remaining : remaining.slice(0, end)).split(/\r?\n/)) {
    const match = line.match(/^\s*([^=\s]+)\s*=\s*(.*?)\s*$/)
    if (match) values[match[1]] = match[2]
  }
  return values
}

function getDataRoots(): string[] {
  return [
    process.env.XDG_DATA_HOME || path.join(process.env.HOME || '', '.local/share'),
    ...(process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')
  ].filter(Boolean)
}

function getIconRoots(): string[] {
  const roots = getDataRoots().map((directory) => path.join(directory, 'icons'))
  roots.push(path.join(process.env.HOME || '', '.icons'))
  return roots
}

async function getCurrentIconTheme(): Promise<string> {
  const gsettingsTheme = await new Promise<string>((resolve) => {
    execFile(
      'gsettings',
      ['get', 'org.gnome.desktop.interface', 'icon-theme'],
      { encoding: 'utf8', timeout: 1000 },
      (error, stdout) => resolve(error ? '' : stdout.trim().replace(/^['"]|['"]$/g, ''))
    )
  })
  if (gsettingsTheme) return gsettingsTheme

  for (const version of ['4.0', '3.0']) {
    try {
      const settings = await fs.promises.readFile(
        path.join(
          process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config'),
          `gtk-${version}`,
          'settings.ini'
        ),
        'utf8'
      )
      const theme = getIniSection(settings, 'Settings')['gtk-icon-theme-name']
      if (theme) return theme
    } catch {
      // Try the next GTK settings source.
    }
  }
  return 'hicolor'
}

async function getThemeIndex(theme: string): Promise<Record<string, string>> {
  for (const root of getIconRoots()) {
    try {
      const content = await fs.promises.readFile(path.join(root, theme, 'index.theme'), 'utf8')
      return getIniSection(content, 'Icon Theme')
    } catch {
      // Try the same theme in the next XDG data directory.
    }
  }
  return {}
}

function getIconThemeOrder(): Promise<string[]> {
  if (iconThemeOrder && iconThemeOrder.expiresAt > Date.now()) return iconThemeOrder.value

  const value = (async () => {
    const themes: string[] = []
    const visit = async (theme: string): Promise<void> => {
      if (!theme || themes.includes(theme)) return
      themes.push(theme)
      for (const inherited of ((await getThemeIndex(theme)).Inherits || '').split(',')) {
        await visit(inherited.trim())
      }
    }
    await visit(await getCurrentIconTheme())
    await visit('hicolor')
    return themes
  })()
  const entry = { expiresAt: Number.POSITIVE_INFINITY, value }
  iconThemeOrder = entry
  void value.then(
    () => {
      entry.expiresAt = Date.now() + LINUX_METADATA_CACHE_MS
    },
    () => {
      if (iconThemeOrder === entry) iconThemeOrder = undefined
    }
  )
  return value
}

function getThemeAppDirectories(root: string, theme: string): Promise<string[]> {
  const cacheKey = `${root}\0${theme}`
  return getCachedPromise(themeDirectoryCache, cacheKey, async () => {
    const themeRoot = path.join(root, theme)
    try {
      const content = await fs.promises.readFile(path.join(themeRoot, 'index.theme'), 'utf8')
      const themeEntry = getIniSection(content, 'Icon Theme')
      const directories = [themeEntry.Directories, themeEntry.ScaledDirectories]
        .filter(Boolean)
        .flatMap((value) => value.split(','))
        .map((value) => value.trim())
        .map((directory) => ({ directory, entry: getIniSection(content, directory) }))
        .filter(({ directory, entry }) => {
          return entry.Context === 'Applications' || /(^|\/)apps(?:@\dx)?(\/|$)/.test(directory)
        })
        .sort((a, b) => {
          const score = (entry: Record<string, string>): number => {
            const size = Number(entry.Size) || 64
            const min = Number(entry.MinSize) || size
            const max = Number(entry.MaxSize) || size
            return 64 < min ? min - 64 : 64 > max ? 64 - max : 0
          }
          return score(a.entry) - score(b.entry)
        })
      if (directories.length > 0) {
        return directories.map(({ directory }) => path.join(themeRoot, directory))
      }
    } catch {
      // Fall back to common layouts for themes without a usable index.
    }

    const sizes = [
      'scalable',
      '512x512',
      '256x256',
      '128x128',
      '64x64',
      '48x48',
      '32x32',
      '24x24',
      '22x22',
      '16x16',
      'symbolic'
    ]
    return sizes.flatMap((size) => [
      path.join(themeRoot, size, 'apps'),
      path.join(themeRoot, 'apps', size)
    ])
  })
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file)
    return true
  } catch {
    return false
  }
}

async function resolveIconPath(iconName: string): Promise<string | null> {
  if (path.isAbsolute(iconName) && (await fileExists(iconName))) {
    return iconName
  }

  const themes = await getIconThemeOrder()
  const cacheKey = `${themes.join('\0')}\0${iconName}`
  return getCachedPromise(
    iconPathCache,
    cacheKey,
    async () => {
      const iconExtension = path.extname(iconName).toLowerCase()
      const isImageExtension = ['.png', '.svg', '.xpm', '.jpg', '.jpeg'].includes(iconExtension)
      const baseIconName = isImageExtension ? iconName.slice(0, -iconExtension.length) : iconName
      const extensions = isImageExtension ? [iconExtension.slice(1)] : ['png', 'svg', 'xpm']
      for (const theme of themes) {
        for (const root of getIconRoots()) {
          for (const directory of await getThemeAppDirectories(root, theme)) {
            for (const ext of extensions) {
              const candidate = path.join(directory, `${baseIconName}.${ext}`)
              if (await fileExists(candidate)) return candidate
            }
          }
        }
      }
      for (const directory of [
        ...getIconRoots(),
        ...getDataRoots().map((root) => path.join(root, 'pixmaps'))
      ]) {
        for (const ext of extensions) {
          const candidate = path.join(directory, `${baseIconName}.${ext}`)
          if (await fileExists(candidate)) return candidate
        }
      }
      return null
    },
    (resolved) => (resolved ? LINUX_METADATA_CACHE_MS : 1000)
  )
}

function getIconMimeType(iconPath: string): string {
  switch (path.extname(iconPath).toLowerCase()) {
    case '.svg':
      return 'image/svg+xml'
    case '.xpm':
      return 'image/x-xpixmap'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    default:
      return 'image/png'
  }
}

export async function getIconDataURL(
  appPath: string,
  processName?: string,
  metadata?: LinuxConnectionMetadata
): Promise<string> {
  if (!appPath && !(process.platform === 'linux' && metadata)) {
    return otherDevicesIcon
  }
  if (appPath === 'mihomo') {
    appPath = app.getPath('exe')
  }

  if (process.platform === 'darwin') {
    if (!appPath.includes('.app') && !appPath.includes('.xpc')) {
      return darwinDefaultIcon
    }
    const targetPath = findBestAppPath(appPath)
    if (!targetPath) {
      return darwinDefaultIcon
    }
    const iconBuffer = await getMacOSIconBuffer(targetPath)
    const base64Icon = Buffer.from(iconBuffer).toString('base64')
    return `data:image/png;base64,${base64Icon}`
  }

  if (process.platform === 'win32') {
    if (fs.existsSync(appPath) && /\.(exe|dll)$/i.test(appPath)) {
      try {
        let targetPath = appPath
        let tempLinkPath: string | null = null

        if (/[\u4e00-\u9fff]/.test(appPath)) {
          const tempDir = os.tmpdir()
          const randomName = crypto.randomBytes(8).toString('hex')
          const fileExt = path.extname(appPath)
          tempLinkPath = path.join(tempDir, `${randomName}${fileExt}`)

          try {
            await new Promise<void>((resolve) => {
              exec(`mklink "${tempLinkPath}" "${appPath}"`, (error) => {
                if (!error && tempLinkPath && fs.existsSync(tempLinkPath)) {
                  targetPath = tempLinkPath
                }
                resolve()
              })
            })
          } catch {
            // ignore mklink errors
          }
        }

        try {
          const iconBuffer = await new Promise<Buffer>((resolve, reject) => {
            getIcon(targetPath, (b64d) => {
              try {
                resolve(Buffer.from(b64d, 'base64'))
              } catch (error) {
                reject(error)
              }
            })
          })

          return `data:image/png;base64,${iconBuffer.toString('base64')}`
        } finally {
          if (tempLinkPath && fs.existsSync(tempLinkPath)) {
            try {
              fs.unlinkSync(tempLinkPath)
            } catch {
              // ignore cleanup errors
            }
          }
        }
      } catch {
        return windowsDefaultIcon
      }
    } else {
      return windowsDefaultIcon
    }
  } else if (process.platform === 'linux') {
    const desktopFile = metadata
      ? await findDesktopFileForConnection(metadata, processName)
      : await findDesktopFile(appPath, processName)
    if (desktopFile) {
      const iconName = (await getDesktopEntries()).get(desktopFile)?.Icon
      if (iconName) {
        const iconPath = await resolveIconPath(iconName)
        if (iconPath) {
          return (
            (await getCachedPromise(
              iconDataCache,
              iconPath,
              async () => {
                try {
                  const iconBuffer = await fs.promises.readFile(iconPath)
                  return `data:${getIconMimeType(iconPath)};base64,${iconBuffer.toString('base64')}`
                } catch {
                  return null
                }
              },
              (resolved) => (resolved ? LINUX_METADATA_CACHE_MS : 1000)
            )) || ''
          )
        }
      }
    }

    return ''
  }

  return ''
}

export async function getImageDataURL(url: string): Promise<string> {
  const { 'mixed-port': port = DEFAULT_MIHOMO_PORTS.mixed } = await getControledMihomoConfig()
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    ...(port !== 0 && {
      proxy: {
        protocol: 'http',
        host: '127.0.0.1',
        port
      }
    })
  })
  const mimeType = res.headers['content-type']
  const dataURL = `data:${mimeType};base64,${Buffer.from(res.data).toString('base64')}`
  return dataURL
}
