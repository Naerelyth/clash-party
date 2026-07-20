import { join } from 'path'
import { BrowserWindow, Menu, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import windowStateKeeper from 'electron-window-state'
import icon from '../../resources/icon.png?asset'
import { getAppConfig } from './config'
import { quitWithoutCore } from './core/manager'
import { hideDockIcon, showDockIcon } from './resolve/tray'
import { mainWindowLogger } from './utils/logger'

export let mainWindow: BrowserWindow | null = null
let quitTimeout: NodeJS.Timeout | null = null
let createWindowPromise: Promise<void> | null = null
let initialRendererReady = false

// 主窗口 renderer 崩溃自动恢复的防抖，避免崩溃循环时无限重建
const MAIN_WINDOW_CRASH_WINDOW = 60 * 1000
const MAIN_WINDOW_MAX_CRASH_RECOVERIES = 3
let mainWindowCrashTimestamps: number[] = []

type AutoQuitWithoutCoreMode = NonNullable<IAppConfig['autoQuitWithoutCoreMode']>

export async function createWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) return
  if (createWindowPromise) return createWindowPromise

  createWindowPromise = createWindowWithRecovery().finally(() => {
    createWindowPromise = null
  })
  return createWindowPromise
}

export function markInitialRendererReady(): void {
  initialRendererReady = true
}

async function createWindowWithRecovery(): Promise<void> {
  const maxCreateAttempts = 3
  for (let attempt = 1; attempt <= maxCreateAttempts; attempt++) {
    try {
      await createWindowInternal()
      return
    } catch (error) {
      const crashRecoveryExhausted =
        mainWindowCrashTimestamps.length > MAIN_WINDOW_MAX_CRASH_RECOVERIES
      if (attempt === maxCreateAttempts || crashRecoveryExhausted) throw error

      const failedWindow = mainWindow
      mainWindow = null
      if (failedWindow && !failedWindow.isDestroyed()) failedWindow.destroy()
      await mainWindowLogger.warn(
        `Main window creation failed (attempt ${attempt}/${maxCreateAttempts}), recreating`,
        error
      )
      await new Promise((resolve) => setTimeout(resolve, attempt * 250))
    }
  }
}

async function createWindowInternal(): Promise<void> {
  const {
    useWindowFrame = false,
    silentStart = false,
    autoQuitWithoutCore = false,
    autoQuitWithoutCoreDelay = 60,
    autoQuitWithoutCoreMode = 'core'
  } = await getAppConfig()
  const mainWindowState = windowStateKeeper({
    defaultWidth: 800,
    defaultHeight: 600,
    file: 'window-state.json'
  })

  Menu.setApplicationMenu(null)
  mainWindow = new BrowserWindow({
    minWidth: 800,
    minHeight: 600,
    width: mainWindowState.width,
    height: mainWindowState.height,
    x: mainWindowState.x,
    y: mainWindowState.y,
    show: false,
    frame: useWindowFrame,
    fullscreenable: false,
    titleBarStyle: useWindowFrame ? 'default' : 'hidden',
    titleBarOverlay: useWindowFrame
      ? false
      : {
          height: 49
        },
    autoHideMenuBar: true,
    // Win 显式指定 icon，避免异常/恢复路径下任务栏与窗口图标依赖默认 exe
    ...(process.platform === 'linux' || process.platform === 'win32' ? { icon: icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      spellcheck: false,
      sandbox: false,
      devTools: true
    }
  })

  mainWindowState.manage(mainWindow)
  setupWindowEvents(mainWindow, {
    silentStart,
    autoQuitWithoutCore,
    autoQuitWithoutCoreDelay,
    autoQuitWithoutCoreMode
  })

  if (is.dev) {
    mainWindow.webContents.openDevTools()
  }

  const windowToLoad = mainWindow
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    await windowToLoad.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    await windowToLoad.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

interface WindowConfig {
  silentStart: boolean
  autoQuitWithoutCore: boolean
  autoQuitWithoutCoreDelay: number
  autoQuitWithoutCoreMode: AutoQuitWithoutCoreMode
}

function setupWindowEvents(window: BrowserWindow, config: WindowConfig): void {
  const { silentStart, autoQuitWithoutCore, autoQuitWithoutCoreDelay, autoQuitWithoutCoreMode } =
    config

  window.on('ready-to-show', () => {
    if (autoQuitWithoutCore && !window.isVisible()) {
      scheduleQuitWithoutCore(autoQuitWithoutCoreDelay, autoQuitWithoutCoreMode)
    }

    // 开发模式下始终显示窗口
    if (!silentStart || is.dev) {
      clearQuitTimeout()
      window.show()
      window.focusOnWebView()
    }
  })

  // renderer 崩溃时外壳仍在（isDestroyed() 为 false）、did-fail-load 不触发，会白屏；销毁并按需重建
  window.webContents.on('render-process-gone', (_event, details) => {
    mainWindowLogger.error('Main window render process gone', details.reason).catch(() => {})

    if (mainWindow !== window || window.isDestroyed()) return

    const wasVisible = window.isVisible()

    mainWindow = null
    window.destroy()

    const now = Date.now()
    mainWindowCrashTimestamps = mainWindowCrashTimestamps.filter(
      (timestamp) => now - timestamp < MAIN_WINDOW_CRASH_WINDOW
    )
    mainWindowCrashTimestamps.push(now)

    if (mainWindowCrashTimestamps.length > MAIN_WINDOW_MAX_CRASH_RECOVERIES) {
      mainWindowLogger
        .error(
          `Main window renderer crashed ${mainWindowCrashTimestamps.length} times within ${MAIN_WINDOW_CRASH_WINDOW}ms, stop auto-recovery`
        )
        .catch(() => {})
      return
    }

    // 可见时立即重建，否则留待下次 showMainWindow()，避免后台崩溃突然弹窗
    if (wasVisible || !initialRendererReady) {
      void createWindow()
        .then(() => {
          if (wasVisible) {
            clearQuitTimeout()
            mainWindow?.show()
            mainWindow?.focusOnWebView()
          }
        })
        .catch((error) => mainWindowLogger.error('Failed to recover main window', error))
    }
  })

  window.webContents.on('unresponsive', () => {
    mainWindowLogger.error('Main window unresponsive').catch(() => {})
  })

  window.on('show', () => {
    showDockIcon()
  })

  window.on('close', async (event) => {
    event.preventDefault()
    window.hide()

    const {
      autoQuitWithoutCore = false,
      autoQuitWithoutCoreDelay = 60,
      autoQuitWithoutCoreMode = 'core',
      useDockIcon = true
    } = await getAppConfig()

    if (!useDockIcon) {
      hideDockIcon()
    }

    if (autoQuitWithoutCore) {
      scheduleQuitWithoutCore(autoQuitWithoutCoreDelay, autoQuitWithoutCoreMode)
    }
  })

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
  })

  if (process.platform === 'linux') {
    let restoreTimeout: NodeJS.Timeout | null = null
    const clearRestoreTimeout = () => {
      if (restoreTimeout) {
        clearTimeout(restoreTimeout)
        restoreTimeout = null
      }
    }

    window.on('minimize', () => {
      window.setMinimumSize(0, 0)
    })

    window.on('restore', () => {
      clearRestoreTimeout()
      restoreTimeout = setTimeout(() => {
        window.setMinimumSize(800, 600)
      }, 100)
    })

    window.on('maximize', () => {
      window.setMinimumSize(0, 0)
    })

    window.on('unmaximize', () => {
      clearRestoreTimeout()
      restoreTimeout = setTimeout(() => {
        window.setMinimumSize(800, 600)

        // 可选：作为兜底，如果恢复后发现尺寸依旧异常，强行拉回正常尺寸
        const bounds = window.getBounds()
        if (bounds.width < 800 || bounds.height < 600) {
          window.setSize(Math.max(bounds.width, 800), Math.max(bounds.height, 600))
        }
      }, 100)
    })
  }

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
}

function scheduleQuitWithoutCore(
  delaySeconds: number,
  mode: AutoQuitWithoutCoreMode = 'core'
): void {
  clearQuitTimeout()
  quitTimeout = setTimeout(async () => {
    if (mode === 'tray') {
      if (mainWindow && !mainWindow.isVisible()) {
        mainWindow.destroy()
        hideDockIcon()
      }
      return
    }

    await quitWithoutCore()
  }, delaySeconds * 1000)
}

export function clearQuitTimeout(): void {
  if (quitTimeout) {
    clearTimeout(quitTimeout)
    quitTimeout = null
  }
}

export function triggerMainWindow(force?: boolean): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    showMainWindow()
    return
  }

  getAppConfig()
    .then(({ triggerMainWindowBehavior = 'toggle' }) => {
      if (force === true || triggerMainWindowBehavior === 'toggle') {
        if (mainWindow?.isVisible()) {
          closeMainWindow()
        } else {
          showMainWindow()
        }
      } else {
        showMainWindow()
      }
    })
    .catch(showMainWindow)
}

export function showMainWindow(): void {
  clearQuitTimeout()

  if (mainWindow && !mainWindow.isDestroyed()) {
    // 兜底：renderer 已崩溃但 render-process-gone 尚未触发时，先 reload 再显示，避免白屏
    if (mainWindow.webContents.isCrashed()) {
      mainWindow.webContents.reload()
    }
    mainWindow.show()
    mainWindow.focusOnWebView()
    return
  }

  void createWindow().then(() => {
    clearQuitTimeout()
    mainWindow?.show()
    mainWindow?.focusOnWebView()
  })
}

export function closeMainWindow(): void {
  mainWindow?.close()
}
