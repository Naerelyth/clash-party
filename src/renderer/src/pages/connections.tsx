import BasePage from '@renderer/components/base/base-page'
import {
  mihomoCloseAllConnections,
  mihomoCloseConnection,
  getIconDataURL,
  getAppName
} from '@renderer/utils/ipc'
import { Key, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Badge,
  Button,
  Divider,
  Input,
  Select,
  SelectItem,
  Tab,
  Tabs,
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem
} from '@heroui/react'
import { calcTraffic } from '@renderer/utils/calc'
import ConnectionItem from '@renderer/components/connections/connection-item'
import ConnectionTable, {
  CONNECTION_TABLE_COLUMNS,
  DEFAULT_CONNECTION_TABLE_COLUMN_KEYS
} from '@renderer/components/connections/connection-table'
import { Virtuoso } from 'react-virtuoso'
import dayjs from '@renderer/utils/dayjs'
import ConnectionDetailModal from '@renderer/components/connections/connection-detail-modal'
import { CgClose, CgTrash } from 'react-icons/cg'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { HiSortAscending, HiSortDescending } from 'react-icons/hi'
import { MdViewList, MdTableChart } from 'react-icons/md'
import { HiOutlineAdjustmentsHorizontal } from 'react-icons/hi2'
import { includesIgnoreCase } from '@renderer/utils/includes'
import { useTranslation } from 'react-i18next'
import { IoMdPause, IoMdPlay } from 'react-icons/io'
import { saveIconToCache, getIconFromCache } from '@renderer/utils/icon-cache'
import { cropAndPadTransparent } from '@renderer/utils/image'
import { platform } from '@renderer/utils/init'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'

let cachedConnections: IMihomoConnectionDetail[] = []
const MAX_QUEUE_SIZE = 100
// Windows/macOS keep their existing path-based cache limits. Linux entries are
// pruned against the retained connection list when each snapshot arrives.
const MAX_ICON_CACHE_SIZE = 256
const MAX_APP_NAME_CACHE_SIZE = 512
const MAX_LINUX_APP_ICON_CACHE_SIZE = 128
const RESOLUTION_RETRY_DELAY_MS = 2000
const CONNECTIONS_FILTER_KEY = 'connections-filter'

function getAppCacheKey(connection: IMihomoConnectionDetail): string {
  return platform === 'linux' ? connection.id : connection.metadata.processPath || ''
}

function putCacheRecord<T>(
  prev: Record<string, T>,
  key: string,
  value: T,
  max?: number
): Record<string, T> {
  const next: Record<string, T> = { ...prev, [key]: value }
  if (max === undefined) return next
  if (max <= 0) return {}
  const keys = Object.keys(next)
  const overflow = keys.length - max
  for (let i = 0, removed = 0; removed < overflow && i < keys.length; i++) {
    if (keys[i] !== key) {
      delete next[keys[i]]
      removed++
    }
  }
  return next
}

function setCappedMap<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  if (!map.has(key) && map.size >= max) {
    map.delete(map.keys().next().value as K)
  }
  map.set(key, value)
}

function retainRecord<T>(record: Record<string, T>, keys: Set<string>): Record<string, T> {
  const staleKeys = Object.keys(record).filter((key) => !keys.has(key))
  if (staleKeys.length === 0) return record
  const next = { ...record }
  staleKeys.forEach((key) => delete next[key])
  return next
}

function retainMapKeys<T>(map: Map<string, T>, keys: Set<string>): void {
  for (const key of map.keys()) {
    if (!keys.has(key)) map.delete(key)
  }
}

function deferResolutionRetry(map: Map<string, number>, key: string): void {
  map.set(key, Date.now() + RESOLUTION_RETRY_DELAY_MS)
}

const Connections: React.FC = () => {
  const { t } = useTranslation()
  const { controledMihomoConfig } = useControledMihomoConfig()
  const { 'find-process-mode': findProcessMode = 'always' } = controledMihomoConfig || {}
  const [filter, setFilter] = useState(() => localStorage.getItem(CONNECTIONS_FILTER_KEY) || '')
  const { appConfig, patchAppConfig } = useAppConfig()
  const appConfigValues: Partial<IAppConfig> = appConfig ?? {}
  const {
    connectionDirection = 'asc',
    connectionOrderBy = 'time',
    connectionViewMode = 'list',
    connectionTableColumns = DEFAULT_CONNECTION_TABLE_COLUMN_KEYS,
    connectionTableColumnWidths,
    connectionTableSortColumn,
    connectionTableSortDirection,
    displayIcon = true,
    displayAppName = true
  } = appConfigValues
  const [connectionsInfo, setConnectionsInfo] = useState<IMihomoConnectionsInfo>()
  const [allConnections, setAllConnections] = useState<IMihomoConnectionDetail[]>(cachedConnections)
  const [activeConnections, setActiveConnections] = useState<IMihomoConnectionDetail[]>([])
  const [closedConnections, setClosedConnections] = useState<IMihomoConnectionDetail[]>([])
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false)
  const [selected, setSelected] = useState<IMihomoConnectionDetail>()
  const [tab, setTab] = useState('active')
  const [isPaused, setIsPaused] = useState(false)
  const [viewMode, setViewMode] = useState<'list' | 'table'>(connectionViewMode)
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(new Set(connectionTableColumns))

  const [iconMap, setIconMap] = useState<Record<string, string>>({})
  const [appNameCache, setAppNameCache] = useState<Record<string, string>>({})
  const [firstItemRefreshTrigger, setFirstItemRefreshTrigger] = useState(0)

  const activeConnectionsRef = useRef(activeConnections)
  const allConnectionsRef = useRef(allConnections)

  const iconRequestQueue = useRef(new Map<string, IMihomoConnectionDetail['metadata']>())
  const processingIcons = useRef(new Set<string>())
  const iconRetryAfter = useRef(new Map<string, number>())
  const processedLinuxIcons = useRef(new Map<string, Promise<string>>())
  const processIconTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const processIconIdleCallback = useRef<number | null>(null)

  const appNameRequestQueue = useRef(new Map<string, IMihomoConnectionDetail['metadata']>())
  const processingAppNames = useRef(new Set<string>())
  const appNameRetryAfter = useRef(new Map<string, number>())
  const processAppNameTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const processOtherPathsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    activeConnectionsRef.current = activeConnections
    allConnectionsRef.current = allConnections
  }, [activeConnections, allConnections])

  useEffect(() => {
    localStorage.setItem(CONNECTIONS_FILTER_KEY, filter)
  }, [filter])

  useEffect(() => {
    setViewMode(connectionViewMode)
  }, [connectionViewMode])

  useEffect(() => {
    setVisibleColumns(new Set(connectionTableColumns))
  }, [connectionTableColumns])

  const selectedConnection = useMemo(() => {
    if (!selected) return undefined
    return (
      activeConnections.find((c) => c.id === selected.id) ||
      closedConnections.find((c) => c.id === selected.id) ||
      selected
    )
  }, [selected, activeConnections, closedConnections])

  const handleColumnWidthChange = useCallback(
    async (widths: Record<string, number>) => {
      await patchAppConfig({ connectionTableColumnWidths: widths })
    },
    [patchAppConfig]
  )

  const handleSortChange = useCallback(
    async (column: string, direction: 'asc' | 'desc') => {
      await patchAppConfig({
        connectionTableSortColumn: column,
        connectionTableSortDirection: direction
      })
    },
    [patchAppConfig]
  )

  const filteredConnections = useMemo(() => {
    const connections = tab === 'active' ? activeConnections : closedConnections

    const filtered =
      filter === ''
        ? connections
        : connections.filter((connection) => {
            const raw = JSON.stringify(connection)
            return includesIgnoreCase(raw, filter)
          })

    if (viewMode === 'list' && connectionOrderBy) {
      return [...filtered].sort((a, b) => {
        let comparison = 0
        switch (connectionOrderBy) {
          case 'time':
            comparison = dayjs(a.start).unix() - dayjs(b.start).unix()
            break
          case 'upload':
            comparison = a.upload - b.upload
            break
          case 'download':
            comparison = a.download - b.download
            break
          case 'uploadSpeed':
            comparison = (a.uploadSpeed || 0) - (b.uploadSpeed || 0)
            break
          case 'downloadSpeed':
            comparison = (a.downloadSpeed || 0) - (b.downloadSpeed || 0)
            break
        }
        return connectionDirection === 'asc' ? comparison : -comparison
      })
    }

    return filtered
  }, [
    activeConnections,
    closedConnections,
    tab,
    filter,
    connectionDirection,
    connectionOrderBy,
    viewMode
  ])

  const filteredConnectionsRef = useRef<IMihomoConnectionDetail[]>([])
  useEffect(() => {
    filteredConnectionsRef.current = filteredConnections
  }, [filteredConnections])

  const closeAllConnections = useCallback((): void => {
    tab === 'active' ? mihomoCloseAllConnections() : trashAllClosedConnection()
  }, [tab])

  const closeConnection = useCallback(
    (id: string): void => {
      tab === 'active' ? mihomoCloseConnection(id) : trashClosedConnection(id)
    },
    [tab]
  )

  const trashAllClosedConnection = (): void => {
    setClosedConnections((closedConns) => {
      const trashIds = new Set(closedConns.map((conn) => conn.id))
      setAllConnections((allConns) => {
        const filtered = allConns.filter((conn) => !trashIds.has(conn.id))
        cachedConnections = filtered
        return filtered
      })
      return []
    })
  }

  const trashClosedConnection = (id: string): void => {
    setAllConnections((allConns) => {
      const filtered = allConns.filter((conn) => conn.id !== id)
      cachedConnections = filtered
      return filtered
    })
    setClosedConnections((closedConns) => closedConns.filter((conn) => conn.id !== id))
  }

  const processAppNameQueue = useCallback(async () => {
    const limit = 3
    if (processingAppNames.current.size >= limit || appNameRequestQueue.current.size === 0) return
    const batchSize = platform === 'linux' ? limit - processingAppNames.current.size : limit

    const keysToProcess = Array.from(appNameRequestQueue.current.entries()).slice(0, batchSize)
    keysToProcess.forEach(([key]) => appNameRequestQueue.current.delete(key))

    const promises = keysToProcess.map(async ([key, metadata]) => {
      if (processingAppNames.current.has(key)) return
      processingAppNames.current.add(key)

      try {
        const appName =
          platform === 'linux'
            ? await getAppName(metadata.processPath, metadata.process, metadata)
            : await getAppName(metadata.processPath)
        if (appName) {
          appNameRetryAfter.current.delete(key)
          setAppNameCache((prev) =>
            putCacheRecord(
              prev,
              key,
              appName,
              platform === 'linux' ? undefined : MAX_APP_NAME_CACHE_SIZE
            )
          )
        } else if (platform === 'linux') {
          deferResolutionRetry(appNameRetryAfter.current, key)
        }
      } catch {
        if (platform === 'linux') deferResolutionRetry(appNameRetryAfter.current, key)
      } finally {
        processingAppNames.current.delete(key)
      }
    })

    await Promise.all(promises)

    if (appNameRequestQueue.current.size > 0) {
      processAppNameTimer.current = setTimeout(processAppNameQueue, 100)
    }
  }, [])

  const processIconQueue = useCallback(async () => {
    const limit = 5
    if (processingIcons.current.size >= limit || iconRequestQueue.current.size === 0) return
    const batchSize = platform === 'linux' ? limit - processingIcons.current.size : limit

    const keysToProcess = Array.from(iconRequestQueue.current.entries()).slice(0, batchSize)
    keysToProcess.forEach(([key]) => iconRequestQueue.current.delete(key))

    const promises = keysToProcess.map(async ([key, metadata]) => {
      if (processingIcons.current.has(key)) return
      processingIcons.current.add(key)

      try {
        const rawBase64 =
          platform === 'linux'
            ? await getIconDataURL(metadata.processPath, metadata.process, metadata)
            : await getIconDataURL(metadata.processPath)
        if (!rawBase64) {
          if (platform === 'linux') {
            deferResolutionRetry(iconRetryAfter.current, key)
          }
          return
        }
        iconRetryAfter.current.delete(key)

        const fullDataURL = rawBase64.startsWith('data:')
          ? rawBase64
          : `data:image/png;base64,${rawBase64}`

        let processedDataURL: string
        if (platform === 'linux') {
          let processed = processedLinuxIcons.current.get(fullDataURL)
          if (!processed) {
            processed = cropAndPadTransparent(fullDataURL).catch((error) => {
              processedLinuxIcons.current.delete(fullDataURL)
              throw error
            })
            setCappedMap(
              processedLinuxIcons.current,
              fullDataURL,
              processed,
              MAX_LINUX_APP_ICON_CACHE_SIZE
            )
          }
          processedDataURL = await processed
        } else if (platform !== 'darwin') {
          processedDataURL = await cropAndPadTransparent(fullDataURL)
        } else {
          processedDataURL = fullDataURL
        }

        if (platform !== 'linux') saveIconToCache(metadata.processPath, processedDataURL)

        setIconMap((prev) =>
          putCacheRecord(
            prev,
            key,
            processedDataURL,
            platform === 'linux' ? undefined : MAX_ICON_CACHE_SIZE
          )
        )

        const firstConnection = filteredConnectionsRef.current[0]
        if (firstConnection && getAppCacheKey(firstConnection) === key) {
          setFirstItemRefreshTrigger((prev) => prev + 1)
        }
      } catch {
        if (platform === 'linux') deferResolutionRetry(iconRetryAfter.current, key)
      } finally {
        processingIcons.current.delete(key)
      }
    })

    await Promise.all(promises)

    if (iconRequestQueue.current.size > 0) {
      if ('requestIdleCallback' in window) {
        processIconIdleCallback.current = requestIdleCallback(() => processIconQueue(), {
          timeout: 1000
        })
      } else {
        processIconTimer.current = setTimeout(processIconQueue, 50)
      }
    }
  }, [])

  useEffect(() => {
    if (
      findProcessMode === 'off' ||
      (platform === 'linux' ? !displayIcon && !displayAppName : !displayIcon)
    ) {
      return
    }

    if (processOtherPathsTimer.current) clearTimeout(processOtherPathsTimer.current)

    const visibleKeys = new Set<string>()
    const otherKeys = new Set<string>()

    const visibleConnections = filteredConnectionsRef.current.slice(0, 20)
    visibleConnections.forEach((c) => {
      visibleKeys.add(getAppCacheKey(c))
    })

    const collectPaths = (connections: IMihomoConnectionDetail[]) => {
      for (const c of connections) {
        const key = getAppCacheKey(c)
        if (!visibleKeys.has(key)) {
          otherKeys.add(key)
        }
      }
    }

    collectPaths(activeConnections)
    collectPaths(closedConnections)

    const loadIcon = (connection: IMihomoConnectionDetail, isVisible: boolean = false): void => {
      const key = getAppCacheKey(connection)
      if (iconMap[key] || processingIcons.current.has(key)) return
      if ((iconRetryAfter.current.get(key) || 0) > Date.now()) return

      if (iconRequestQueue.current.size >= MAX_QUEUE_SIZE) return

      const fromCache =
        platform === 'linux' ? null : getIconFromCache(connection.metadata.processPath)
      if (fromCache) {
        setIconMap((prev) => putCacheRecord(prev, key, fromCache, MAX_ICON_CACHE_SIZE))
        if (isVisible && filteredConnections[0] && getAppCacheKey(filteredConnections[0]) === key) {
          setFirstItemRefreshTrigger((prev) => prev + 1)
        }
        return
      }

      iconRequestQueue.current.set(key, connection.metadata)
    }

    const loadAppName = (connection: IMihomoConnectionDetail): void => {
      const key = getAppCacheKey(connection)
      if (key in appNameCache || processingAppNames.current.has(key)) return
      if ((appNameRetryAfter.current.get(key) || 0) > Date.now()) return
      if (appNameRequestQueue.current.size >= MAX_QUEUE_SIZE) return
      appNameRequestQueue.current.set(key, connection.metadata)
    }

    visibleConnections.forEach((connection) => {
      if (displayIcon) loadIcon(connection, true)
      if (displayAppName) loadAppName(connection)
    })

    if (otherKeys.size > 0) {
      const loadOtherPaths = () => {
        for (const connection of [...activeConnections, ...closedConnections]) {
          const key = getAppCacheKey(connection)
          if (visibleKeys.has(key)) continue
          if (displayIcon) loadIcon(connection, false)
          if (displayAppName) loadAppName(connection)
        }

        if (displayIcon && iconRequestQueue.current.size > 0) {
          processIconTimer.current = setTimeout(processIconQueue, 10)
        }
        if (displayAppName && appNameRequestQueue.current.size > 0) {
          processAppNameTimer.current = setTimeout(processAppNameQueue, 10)
        }
      }

      processOtherPathsTimer.current = setTimeout(loadOtherPaths, 100)
    }

    if (processIconTimer.current) clearTimeout(processIconTimer.current)
    if (processIconIdleCallback.current) cancelIdleCallback(processIconIdleCallback.current)
    if (processAppNameTimer.current) clearTimeout(processAppNameTimer.current)

    if (displayIcon) {
      processIconTimer.current = setTimeout(processIconQueue, 10)
    }
    if (displayAppName) {
      processAppNameTimer.current = setTimeout(processAppNameQueue, 10)
    }

    return (): void => {
      if (processIconTimer.current) clearTimeout(processIconTimer.current)
      if (processIconIdleCallback.current) cancelIdleCallback(processIconIdleCallback.current)
      if (processAppNameTimer.current) clearTimeout(processAppNameTimer.current)
      if (processOtherPathsTimer.current) clearTimeout(processOtherPathsTimer.current)
    }
  }, [
    activeConnections,
    closedConnections,
    iconMap,
    appNameCache,
    displayIcon,
    processIconQueue,
    processAppNameQueue,
    displayAppName,
    findProcessMode,
    filteredConnections
  ])

  useEffect(() => {
    const handler = (_e: unknown, ...args: unknown[]): void => {
      const info = args[0] as IMihomoConnectionsInfo
      setConnectionsInfo(info)

      if (!info.connections) return
      // O(n+m) merge using Map instead of O(n²) unionWith
      const allConnsMap = new Map(allConnectionsRef.current.map((c) => [c.id, c]))
      activeConnectionsRef.current.forEach((c) => allConnsMap.set(c.id, c))
      const allConns = Array.from(allConnsMap.values())

      const prevConnMap = new Map(activeConnectionsRef.current.map((c) => [c.id, c]))
      const activeConns = info.connections.map((conn) => {
        const preConn = prevConnMap.get(conn.id)
        return {
          ...conn,
          isActive: true,
          downloadSpeed: preConn ? conn.download - preConn.download : 0,
          uploadSpeed: preConn ? conn.upload - preConn.upload : 0
        }
      })
      // O(n+m) difference using Set instead of O(n²) differenceWith
      const activeIdSet = new Set(activeConns.map((c) => c.id))
      const closedConns = allConns
        .filter((c) => !activeIdSet.has(c.id))
        .map((conn) => ({
          ...conn,
          isActive: false,
          downloadSpeed: 0,
          uploadSpeed: 0
        }))

      const sliced = allConns.slice(-(activeConns.length + 200))
      if (platform === 'linux') {
        const liveKeys = new Set(
          [...activeConns, ...closedConns].map((connection) => connection.id)
        )
        setIconMap((prev) => retainRecord(prev, liveKeys))
        setAppNameCache((prev) => retainRecord(prev, liveKeys))
        retainMapKeys(iconRetryAfter.current, liveKeys)
        retainMapKeys(appNameRetryAfter.current, liveKeys)
      }
      setActiveConnections(activeConns)
      setClosedConnections(closedConns)
      setAllConnections(sliced)
      cachedConnections = sliced
    }

    if (!isPaused) {
      window.electron.ipcRenderer.on('mihomoConnections', handler)
    }

    return (): void => {
      window.electron.ipcRenderer.removeListener('mihomoConnections', handler)
    }
  }, [isPaused])

  const openConnectionDetail = useCallback((connection: IMihomoConnectionDetail): void => {
    setSelected(connection)
    setIsDetailModalOpen(true)
  }, [])
  const togglePause = useCallback(() => {
    setIsPaused((prev) => !prev)
  }, [])

  const renderConnectionItem = useCallback(
    (i: number, connection: IMihomoConnectionDetail) => {
      const cacheKey = getAppCacheKey(connection)
      const iconUrl = (displayIcon && findProcessMode !== 'off' && iconMap[cacheKey]) || ''
      const itemKey = i === 0 ? `${connection.id}-${firstItemRefreshTrigger}` : connection.id
      const displayName = displayAppName ? appNameCache[cacheKey] : undefined

      return (
        <ConnectionItem
          setSelected={setSelected}
          setIsDetailModalOpen={setIsDetailModalOpen}
          selected={selected}
          iconUrl={iconUrl}
          displayIcon={displayIcon && findProcessMode !== 'off'}
          displayName={displayName}
          close={closeConnection}
          index={i}
          key={itemKey}
          info={connection}
        />
      )
    },
    [
      displayIcon,
      iconMap,
      firstItemRefreshTrigger,
      selected,
      closeConnection,
      appNameCache,
      findProcessMode,
      displayAppName
    ]
  )

  return (
    <BasePage
      title={t('connections.title')}
      header={
        <div className="flex">
          <div className="flex items-center">
            <span className="mx-1 text-gray-400">
              ↑ {calcTraffic(connectionsInfo?.uploadTotal ?? 0)}{' '}
            </span>
            <span className="mx-1 text-gray-400">
              ↓ {calcTraffic(connectionsInfo?.downloadTotal ?? 0)}{' '}
            </span>
          </div>
          <Badge
            className="app-nodrag pointer-events-none mt-2"
            color="primary"
            variant="flat"
            showOutline={false}
            content={filteredConnections.length}
          >
            <Button
              className="app-nodrag ml-1"
              title={
                viewMode === 'list'
                  ? t('connections.table.switchToTable')
                  : t('connections.table.switchToList')
              }
              isIconOnly
              size="sm"
              variant="light"
              onPress={async () => {
                const newMode = viewMode === 'list' ? 'table' : 'list'
                setViewMode(newMode)
                await patchAppConfig({ connectionViewMode: newMode })
              }}
            >
              {viewMode === 'list' ? (
                <MdTableChart className="text-lg" />
              ) : (
                <MdViewList className="text-lg" />
              )}
            </Button>
            <Button
              className="app-nodrag ml-1"
              title={isPaused ? t('connections.resume') : t('connections.pause')}
              isIconOnly
              size="sm"
              variant="light"
              onPress={togglePause}
            >
              {isPaused ? <IoMdPlay className="text-lg" /> : <IoMdPause className="text-lg" />}
            </Button>
            <Button
              className="app-nodrag ml-1"
              title={t('connections.closeAll')}
              isIconOnly
              size="sm"
              variant="light"
              onPress={() => {
                if (filter === '') {
                  closeAllConnections()
                } else {
                  filteredConnections.forEach((conn) => {
                    closeConnection(conn.id)
                  })
                }
              }}
            >
              {tab === 'active' ? <CgClose className="text-lg" /> : <CgTrash className="text-lg" />}
            </Button>
          </Badge>
        </div>
      }
    >
      {isDetailModalOpen && selectedConnection && (
        <ConnectionDetailModal
          onClose={() => setIsDetailModalOpen(false)}
          connection={selectedConnection}
        />
      )}
      <div className="overflow-x-auto sticky top-0 z-40">
        <div className="flex p-2 gap-2">
          <Tabs
            size="sm"
            color={tab === 'active' ? 'primary' : 'danger'}
            selectedKey={tab}
            variant="underlined"
            className="w-fit h-8"
            onSelectionChange={(key: Key) => {
              setTab(key as string)
            }}
          >
            <Tab
              key="active"
              title={
                <Badge
                  color={tab === 'active' ? 'primary' : 'default'}
                  size="sm"
                  shape="circle"
                  variant="flat"
                  content={activeConnections.length}
                  showOutline={false}
                >
                  <span className="p-1">{t('connections.active')}</span>
                </Badge>
              }
            />
            <Tab
              key="closed"
              title={
                <Badge
                  color={tab === 'closed' ? 'danger' : 'default'}
                  size="sm"
                  shape="circle"
                  variant="flat"
                  content={closedConnections.length}
                  showOutline={false}
                >
                  <span className="p-1">{t('connections.closed')}</span>
                </Badge>
              }
            />
          </Tabs>
          <Input
            variant="flat"
            size="sm"
            value={filter}
            placeholder={t('connections.filter')}
            isClearable
            onValueChange={setFilter}
          />

          {viewMode === 'table' && (
            <Dropdown>
              <DropdownTrigger>
                <Button
                  size="sm"
                  variant="flat"
                  startContent={<HiOutlineAdjustmentsHorizontal className="text-2xl" />}
                >
                  {t('connections.table.columns')}
                </Button>
              </DropdownTrigger>
              <DropdownMenu
                aria-label="Column visibility"
                closeOnSelect={false}
                selectionMode="multiple"
                selectedKeys={visibleColumns}
                onSelectionChange={async (keys) => {
                  const newColumns =
                    keys === 'all'
                      ? CONNECTION_TABLE_COLUMNS.map((column) => column.key)
                      : Array.from(keys).map(String)
                  setVisibleColumns(new Set(newColumns))
                  await patchAppConfig({ connectionTableColumns: newColumns })
                }}
              >
                {CONNECTION_TABLE_COLUMNS.map((column) => (
                  <DropdownItem key={column.key}>{t(column.labelKey)}</DropdownItem>
                ))}
              </DropdownMenu>
            </Dropdown>
          )}

          {viewMode === 'list' && (
            <>
              <Select
                classNames={{ trigger: 'data-[hover=true]:bg-default-200' }}
                size="sm"
                className="w-45 min-w-32.75"
                aria-label={t('connections.orderBy')}
                selectedKeys={[connectionOrderBy]}
                disallowEmptySelection={true}
                onSelectionChange={async (v) => {
                  await patchAppConfig({
                    connectionOrderBy: v.currentKey as
                      | 'time'
                      | 'upload'
                      | 'download'
                      | 'uploadSpeed'
                      | 'downloadSpeed'
                  })
                }}
              >
                <SelectItem key="time">{t('connections.time')}</SelectItem>
                <SelectItem key="upload">{t('connections.uploadAmount')}</SelectItem>
                <SelectItem key="download">{t('connections.downloadAmount')}</SelectItem>
                <SelectItem key="uploadSpeed">{t('connections.uploadSpeed')}</SelectItem>
                <SelectItem key="downloadSpeed">{t('connections.downloadSpeed')}</SelectItem>
              </Select>
              <Button
                size="sm"
                isIconOnly
                className="bg-content2"
                onPress={() => {
                  patchAppConfig({
                    connectionDirection: connectionDirection === 'asc' ? 'desc' : 'asc'
                  })
                }}
              >
                {connectionDirection === 'asc' ? (
                  <HiSortAscending className="text-lg" />
                ) : (
                  <HiSortDescending className="text-lg" />
                )}
              </Button>
            </>
          )}
        </div>
        <Divider />
      </div>
      <div className="h-[calc(100vh-100px)] mt-px">
        {viewMode === 'list' ? (
          <Virtuoso data={filteredConnections} itemContent={renderConnectionItem} />
        ) : (
          <ConnectionTable
            connections={filteredConnections}
            onOpenDetail={openConnectionDetail}
            close={closeConnection}
            visibleColumns={visibleColumns}
            columnWidths={connectionTableColumnWidths}
            sortColumn={connectionTableSortColumn}
            sortDirection={connectionTableSortDirection}
            onColumnWidthChange={handleColumnWidthChange}
            onSortChange={handleSortChange}
          />
        )}
      </div>
    </BasePage>
  )
}

export default Connections
