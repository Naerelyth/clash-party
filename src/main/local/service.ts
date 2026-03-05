import path from 'path'
import axios from 'axios'
import { app, dialog } from 'electron'
import { parse, stringify } from '../utils/yaml'
import { getAppConfig } from '../config/app'
import { atomicWriteFile } from '../utils/safeFile'
import { deepMerge } from '../utils/merge'
import {
  LOCAL_BUILTIN_OUTBOUNDS,
  LOCAL_GENERAL_CONFIG_KEYS,
  LOCAL_MODULES,
  LOCAL_SHARED_CONFIG_KEYS,
  type LocalDraft,
  type LocalPreview,
  type LocalObject,
  type LocalProxyGroupEditor,
  type LocalRuleChange,
  type LocalRuleEditor,
  type LocalSource,
  type LocalSubscriptionOptions
} from '../../shared/local-config'
import { cleanupLocalDraft, removedLocalResources } from './references'
import {
  getLocalState,
  commitLocalState,
  saveLocalState,
  compileAndWriteLocal,
  isLocalProfileActive,
  localWriteQueue
} from './store'
import { compileLocalConfig, type LocalSharedConfig } from './compiler'
import { patchLocalDraft } from './patch'
import { normalizeLocalProviderOptions } from './providers'
import { replaceLocalSource, resolveLocalDraft, setLocalSourceGroups } from './subscriptions'
import {
  addLocalNodes,
  readLocalNodes,
  removeLocalNode as removeLocalNodeFromDraft,
  updateLocalNode
} from './nodes'
import {
  addLocalGroup,
  readLocalGroups,
  reorderLocalGroups,
  updateLocalGroup,
  removeLocalGroup
} from './groups'
import {
  changeLocalRules,
  changeLocalRuleProvider,
  readLocalRules,
  readLocalRuleProviders
} from './rules'

const sharedModuleNames = ['dns', 'hosts', 'tun', 'sniffer'] as const
const sharedConfigKeys = new Set<string>(LOCAL_SHARED_CONFIG_KEYS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function getSharedConfig(): Promise<LocalSharedConfig> {
  const { getControledMihomoConfig } = await import('../config/controledMihomo')
  const config = await getControledMihomoConfig(true)
  return Object.fromEntries(
    LOCAL_SHARED_CONFIG_KEYS.filter((name) => config[name] !== undefined).map((name) => [
      name,
      structuredClone(config[name])
    ])
  ) as LocalSharedConfig
}

export async function inheritLocalGeneralSettings(): Promise<void> {
  const { getControledMihomoConfig } = await import('../config/controledMihomo')
  const controlledConfig = await getControledMihomoConfig(true)
  let standardConfig: Record<string, unknown> = controlledConfig as Record<string, unknown>
  try {
    const { getProfileConfig, getProfile } = await import('../config/profile')
    const { current } = await getProfileConfig(true)
    const profileConfig = current ? await getProfile(current) : undefined
    if (isRecord(profileConfig)) {
      standardConfig = { ...standardConfig, ...profileConfig }
    }
  } catch {
    // A missing or invalid standard profile must not block mode migration.
  }
  try {
    const { getRuntimeConfig } = await import('../core/factory')
    const runtimeConfig = await getRuntimeConfig()
    if (isRecord(runtimeConfig) && Object.keys(runtimeConfig).length) {
      standardConfig = runtimeConfig
    }
  } catch {
    // The standard runtime may not have been generated yet; controlled values are sufficient.
  }
  await localWriteQueue.run(async () => {
    const state = await getLocalState()
    const firstUse = state.revision === 0
    let draftGeneral: unknown
    let publishedGeneral: unknown
    try {
      draftGeneral = parse(state.draft.modules.general)
      publishedGeneral = parse(state.published.modules.general)
    } catch {
      return
    }
    if (!isRecord(draftGeneral) || !isRecord(publishedGeneral)) return

    const draftPreserved = { ...(state.draft.preserved || {}) }
    const publishedPreserved = { ...(state.published.preserved || {}) }
    let changed = false
    for (const key of LOCAL_GENERAL_CONFIG_KEYS) {
      const value = standardConfig[key]
      if (value === undefined) continue
      if (firstUse || draftGeneral[key] === undefined) {
        draftGeneral[key] = structuredClone(value)
        changed = true
      }
      if (firstUse || publishedGeneral[key] === undefined) {
        publishedGeneral[key] = structuredClone(value)
        changed = true
      }
    }
    for (const [key, value] of Object.entries(standardConfig)) {
      if (Object.hasOwn(LOCAL_MODULES, key) || sharedConfigKeys.has(key)) continue
      if (firstUse || draftPreserved[key] === undefined) {
        draftPreserved[key] = structuredClone(value)
        changed = true
      }
      if (firstUse || publishedPreserved[key] === undefined) {
        publishedPreserved[key] = structuredClone(value)
        changed = true
      }
    }
    if (!changed) return
    await saveLocalState({
      ...state,
      revision: state.revision + 1,
      draft: {
        ...state.draft,
        modules: { ...state.draft.modules, general: stringify(draftGeneral) },
        preserved: draftPreserved
      },
      published: {
        ...state.published,
        modules: { ...state.published.modules, general: stringify(publishedGeneral) },
        preserved: publishedPreserved
      }
    })
  })
}

function applySharedModules(draft: LocalDraft, shared: LocalSharedConfig): LocalDraft {
  const modules = { ...draft.modules }
  for (const name of sharedModuleNames) {
    if (shared[name] !== undefined) modules[name] = stringify(shared[name])
  }
  return { ...draft, modules }
}

export async function patchLocalModules(patch: Partial<IMihomoConfig>): Promise<void> {
  await localWriteQueue.run(async () => {
    const state = await getLocalState()
    const shared = await getSharedConfig()
    const sharedPatch = Object.fromEntries(
      Object.entries(patch).filter(([key]) => sharedConfigKeys.has(key))
    ) as LocalSharedConfig
    const otherPatch = Object.fromEntries(
      Object.entries(patch).filter(([key]) => !sharedConfigKeys.has(key))
    )
    deepMerge(shared, sharedPatch)
    if (sharedPatch.hosts) shared.hosts = sharedPatch.hosts
    if (sharedPatch.dns && Object.hasOwn(sharedPatch.dns, 'nameserver-policy')) {
      shared.dns = shared.dns || {}
      shared.dns['nameserver-policy'] = sharedPatch.dns['nameserver-policy'] ?? {}
    }
    const next = {
      ...state,
      revision: state.revision + 1,
      draft: applySharedModules(patchLocalDraft(state.draft, otherPatch), shared),
      published: applySharedModules(patchLocalDraft(state.published, otherPatch), shared)
    }
    const result = await commitLocalState(state, next, { shared })
    if (result.errors.length) throw new Error(result.errors.join('\n'))
  })
}

function extractProxies(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value))
    return value.filter((item): item is Record<string, unknown> => item && typeof item === 'object')
  if (
    value &&
    typeof value === 'object' &&
    Array.isArray((value as Record<string, unknown>).proxies)
  )
    return extractProxies((value as Record<string, unknown>).proxies)
  return []
}

async function fetchSubscriptionProxies(url: string): Promise<Record<string, unknown>[]> {
  if (!/^https?:$/i.test(new URL(url).protocol)) throw new Error('订阅地址必须使用 http(s)')
  const response = await axios.get<string>(url, { responseType: 'text', timeout: 30000 })
  const { yamlMaxAliasCount } = await getAppConfig()
  const proxies = extractProxies(parse(response.data, { maxAliasCount: yamlMaxAliasCount }))
  if (proxies.length === 0) throw new Error('订阅中没有找到 proxies 节点')
  return proxies
}
export async function previewLocalConfig(): Promise<LocalPreview> {
  const state = await getLocalState()
  const shared = await getSharedConfig()
  return compileLocalConfig(
    await resolveLocalDraft(applySharedModules(state.draft, shared)),
    shared
  )
}
export async function getLocalConfig() {
  const state = await getLocalState()
  const shared = await getSharedConfig()
  return {
    ...state,
    draft: applySharedModules(state.draft, shared),
    published: applySharedModules(state.published, shared)
  }
}

export async function inheritLocalSources(apply = false): Promise<void> {
  const { getProfileConfig } = await import('../config/profile')
  await localWriteQueue.run(async () => {
    const profiles = await getProfileConfig()
    const state = await getLocalState()
    const items = new Map(profiles.items.map((item) => [item.id, item]))
    const sync = (source: LocalSource): LocalSource => {
      const item = source.profileId ? items.get(source.profileId) : undefined
      return item ? { ...source, extra: item.extra, updated: item.updated } : source
    }
    const draftSources = state.draft.sources.map(sync)
    const publishedSources = state.published.sources.map(sync)
    if (
      JSON.stringify(draftSources) === JSON.stringify(state.draft.sources) &&
      JSON.stringify(publishedSources) === JSON.stringify(state.published.sources)
    )
      return
    const next = {
      ...state,
      draft: { ...state.draft, sources: draftSources },
      published: { ...state.published, sources: publishedSources }
    }
    if (apply && (await isLocalProfileActive())) {
      const result = await commitLocalState(state, next)
      if (result.errors.length) throw new Error(result.errors.join('\n'))
      return
    }
    await saveLocalState(next)
  })
}
export async function saveLocalDraft(draft: LocalDraft): Promise<LocalPreview> {
  return localWriteQueue.run(async () => {
    const state = await getLocalState()
    const shared = await getSharedConfig()
    let nextDraft = applySharedModules(draft, shared)
    const before = await resolveLocalDraft(state.draft)
    const after = await resolveLocalDraft(nextDraft)
    const removed = removedLocalResources(
      compileLocalConfig(before, shared),
      compileLocalConfig(after, shared),
      before,
      after
    )
    if (Object.values(removed).some((names) => names.size))
      nextDraft = cleanupLocalDraft(after, removed)
    await saveLocalState({ ...state, draft: nextDraft, published: structuredClone(nextDraft) })
    return compileLocalConfig(await resolveLocalDraft(nextDraft), shared)
  })
}
export async function publishLocalConfig(draft?: LocalDraft): Promise<LocalPreview> {
  return localWriteQueue.run(async () => {
    const state = await getLocalState()
    const shared = await getSharedConfig()
    const nextDraft = applySharedModules(draft || state.draft, shared)
    return commitLocalState(state, {
      ...state,
      revision: state.revision + 1,
      draft: nextDraft,
      published: structuredClone(nextDraft)
    })
  })
}
export async function exportLocalConfig(): Promise<LocalPreview & { path?: string }> {
  const preview = await previewLocalConfig()
  if (preview.errors.length) return preview
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出配置',
    defaultPath: path.join(app.getPath('documents'), 'mihomo-party-config.yaml'),
    filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }]
  })
  if (canceled || !filePath) return preview
  await atomicWriteFile(filePath, preview.yaml, { encoding: 'utf8' })
  return { ...preview, path: filePath }
}
export async function compileLocalRuntime(): Promise<LocalPreview> {
  const state = await getLocalState()
  const shared = await getSharedConfig()
  const next = {
    ...state,
    draft: applySharedModules(state.draft, shared),
    published: applySharedModules(state.published, shared)
  }
  return compileAndWriteLocal(next, true, shared)
}

export async function getLocalRulesEditor(): Promise<LocalRuleEditor> {
  const { draft } = await getLocalState()
  const preview = compileLocalConfig(await resolveLocalDraft(draft), await getSharedConfig())
  const subRules = parse(draft.modules['sub-rules'])
  return {
    rules: readLocalRules(draft),
    ruleProviders: readLocalRuleProviders(draft),
    outbounds: preview.references.outbounds,
    subRules: isRecord(subRules) ? Object.keys(subRules) : []
  }
}

export async function saveLocalRules(change: LocalRuleChange, expected: string[]): Promise<void> {
  await localWriteQueue.run(async () => {
    if (!isRecord(change) || !Array.isArray(expected)) throw new Error('规则参数无效')
    const state = await getLocalState()
    const result = await commitLocalState(state, {
      ...state,
      revision: state.revision + 1,
      draft: changeLocalRules(state.draft, change, expected),
      published: changeLocalRules(state.published, change, expected)
    })
    if (result.errors.length) throw new Error(result.errors.join('\n'))
  })
}

export async function saveLocalRuleProvider(
  name: string | undefined,
  nextName: string,
  value: LocalObject | null,
  expected?: LocalObject
): Promise<void> {
  await localWriteQueue.run(async () => {
    if (
      typeof nextName !== 'string' ||
      (value !== null && !isRecord(value)) ||
      (name !== undefined && (typeof name !== 'string' || !isRecord(expected)))
    )
      throw new Error('规则集参数无效')
    const state = await getLocalState()
    const result = await commitLocalState(state, {
      ...state,
      revision: state.revision + 1,
      draft: changeLocalRuleProvider(state.draft, name, nextName, value, expected),
      published:
        value === null &&
        name !== undefined &&
        !Object.hasOwn(readLocalRuleProviders(state.published), name)
          ? state.published
          : changeLocalRuleProvider(state.published, name, nextName, value)
    })
    if (result.errors.length) throw new Error(result.errors.join('\n'))
  })
}

export async function getLocalProxyGroup(name?: string): Promise<LocalProxyGroupEditor> {
  const state = await getLocalState()
  const groups = readLocalGroups(state.draft)
  const group =
    name === undefined
      ? { name: '', type: 'select', proxies: ['DIRECT'] }
      : groups.find((group) => group.name === name)
  if (!group) throw new Error(`找不到代理组：${name}`)
  const draft = await resolveLocalDraft(state.draft)
  const preview = compileLocalConfig(draft, await getSharedConfig())
  const config = parse(preview.yaml) as LocalObject
  const outboundDetails: LocalProxyGroupEditor['outboundDetails'] = {
    DIRECT: { type: 'Direct' },
    REJECT: { type: 'Reject' },
    'REJECT-DROP': { type: 'RejectDrop' },
    PASS: { type: 'Pass' },
    'PASS-RULE': { type: 'PassRule' },
    COMPATIBLE: { type: 'Compatible' }
  }
  const sources = new Map<string, string>()
  for (const source of draft.sources) {
    if (source.mode !== 'extract') continue
    for (const proxy of source.proxies) {
      if (typeof proxy.name === 'string')
        sources.set(`${source.prefix || ''}${proxy.name}`, source.name)
    }
  }
  for (const key of ['proxies', 'proxy-groups']) {
    const entries = config[key]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.name !== 'string') continue
      outboundDetails[entry.name] = {
        type: typeof entry.type === 'string' ? entry.type : 'unknown',
        ...(sources.has(entry.name) ? { source: sources.get(entry.name) } : {})
      }
    }
  }
  const providers = config['proxy-providers']
  const providerTypes = Object.fromEntries(
    Object.entries(isRecord(providers) ? providers : {}).map(([name, provider]) => [
      name,
      isRecord(provider) && typeof provider.type === 'string' ? provider.type : 'unknown'
    ])
  )
  return {
    group,
    outbounds: preview.references.outbounds.filter((outbound) => outbound !== name),
    groupNames: groups.map((group) => String(group.name)),
    proxyProviders: preview.references.proxyProviders,
    sources: draft.sources.map((source) => source.name),
    outboundDetails,
    providerTypes
  }
}

async function assertLocalNameAvailable(
  draft: LocalDraft,
  label: string,
  value: LocalObject,
  previousName?: string
): Promise<void> {
  if (typeof value.name !== 'string' || !value.name.trim()) throw new Error(`${label}名称不能为空`)
  const name = value.name.trim()
  if (LOCAL_BUILTIN_OUTBOUNDS.includes(name) || name === 'GLOBAL') {
    throw new Error(`不能使用内置出站或 GLOBAL 名称: ${name}`)
  }
  if (name === previousName) return
  const resolved = await resolveLocalDraft(draft)
  const { references } = compileLocalConfig(resolved)
  if (references.outbounds.includes(name))
    throw new Error(`${label}名称与已有节点或代理组冲突: ${name}`)
  if (references.proxyProviders.includes(name))
    throw new Error(`${label}名称与已有代理集合冲突: ${name}`)
}

export async function saveLocalProxyGroup(
  name: string,
  value: LocalObject,
  expected: LocalObject
): Promise<void> {
  await localWriteQueue.run(async () => {
    if (!isRecord(value) || !isRecord(expected)) throw new Error('代理组参数必须是对象')
    const state = await getLocalState()
    await assertLocalNameAvailable(state.draft, '代理组', value, name)
    const draft = updateLocalGroup(state.draft, name, value, expected)
    const published = updateLocalGroup(state.published, name, value)
    const result = await commitLocalState(state, {
      ...state,
      revision: state.revision + 1,
      draft,
      published
    })
    if (result.errors.length) throw new Error(result.errors.join('\n'))
  })
}

export async function createLocalProxyGroup(value: LocalObject): Promise<void> {
  await localWriteQueue.run(async () => {
    if (!isRecord(value)) throw new Error('代理组参数必须是对象')
    const state = await getLocalState()
    await assertLocalNameAvailable(state.draft, '代理组', value)
    const result = await commitLocalState(state, {
      ...state,
      revision: state.revision + 1,
      draft: addLocalGroup(state.draft, value),
      published: addLocalGroup(state.published, value)
    })
    if (result.errors.length) throw new Error(result.errors.join('\n'))
  })
}

export async function removeLocalProxyGroup(name: string, expected: LocalObject): Promise<void> {
  await localWriteQueue.run(async () => {
    if (typeof name !== 'string' || !isRecord(expected)) throw new Error('代理组参数无效')
    const state = await getLocalState()
    const result = await commitLocalState(state, {
      ...state,
      revision: state.revision + 1,
      draft: removeLocalGroup(state.draft, name, expected),
      published: removeLocalGroup(state.published, name)
    })
    if (result.errors.length) throw new Error(result.errors.join('\n'))
  })
}

export async function reorderLocalProxyGroups(names: string[]): Promise<void> {
  await localWriteQueue.run(async () => {
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
      throw new Error('代理组顺序必须是名称列表')
    }
    const state = await getLocalState()
    const draft = reorderLocalGroups(state.draft, names)
    const published = reorderLocalGroups(state.published, names)
    const result = await commitLocalState(state, {
      ...state,
      revision: state.revision + 1,
      draft,
      published
    })
    if (result.errors.length) throw new Error(result.errors.join('\n'))
  })
}

export async function getLocalNode(name?: string): Promise<LocalObject> {
  const state = await getLocalState()
  const node =
    name === undefined
      ? { name: '', type: 'ss' }
      : readLocalNodes(state.draft).find((item) => item.name === name)
  if (!node) throw new Error(`找不到节点：${name}`)
  return node
}

export async function createLocalNodes(values: LocalObject[]): Promise<void> {
  await localWriteQueue.run(async () => {
    if (!Array.isArray(values) || !values.length) throw new Error('节点参数不能为空')
    const state = await getLocalState()
    for (const value of values) {
      if (!isRecord(value)) throw new Error('节点参数必须是对象')
      await assertLocalNameAvailable(state.draft, '节点', value)
    }
    const result = await commitLocalState(state, {
      ...state,
      revision: state.revision + 1,
      draft: addLocalNodes(state.draft, values),
      published: addLocalNodes(state.published, values)
    })
    if (result.errors.length) throw new Error(result.errors.join('\n'))
  })
}

export async function saveLocalNode(
  name: string,
  value: LocalObject,
  expected: LocalObject
): Promise<void> {
  await localWriteQueue.run(async () => {
    if (typeof name !== 'string' || !isRecord(value) || !isRecord(expected)) {
      throw new Error('节点参数必须是对象')
    }
    const state = await getLocalState()
    await assertLocalNameAvailable(state.draft, '节点', value, name)
    const result = await commitLocalState(state, {
      ...state,
      revision: state.revision + 1,
      draft: updateLocalNode(state.draft, name, value, expected),
      published: updateLocalNode(state.published, name, value)
    })
    if (result.errors.length) throw new Error(result.errors.join('\n'))
  })
}

export async function removeLocalNode(name: string, expected: LocalObject): Promise<void> {
  await localWriteQueue.run(async () => {
    if (typeof name !== 'string' || !isRecord(expected)) throw new Error('节点参数无效')
    const state = await getLocalState()
    const result = await commitLocalState(state, {
      ...state,
      revision: state.revision + 1,
      draft: removeLocalNodeFromDraft(state.draft, name, expected),
      published: removeLocalNodeFromDraft(state.published, name)
    })
    if (result.errors.length) throw new Error(result.errors.join('\n'))
  })
}

export async function configureLocalSource(
  profileId: string,
  options?: LocalSubscriptionOptions
): Promise<void> {
  if (options && !['group', 'nodes'].includes(options.mode)) {
    throw new Error('未知订阅导入方式')
  }
  await localWriteQueue.run(async () => {
    const { getProfileItem } = await import('../config/profile')
    const item = await getProfileItem(profileId)
    if (!item) throw new Error('找不到订阅')
    const state = await getLocalState()
    const inferProviderSource = (draft: LocalDraft): LocalSource | undefined => {
      const providers = parse(draft.modules['proxy-providers'])
      if (isRecord(providers)) {
        const entry = Object.entries(providers).find(([name, value]) => {
          if (!isRecord(value)) return false
          return (
            name === options?.providerName?.trim() ||
            name === item.name ||
            (Boolean(item.url) && value.url === item.url)
          )
        })
        if (entry && isRecord(entry[1])) {
          const override = isRecord(entry[1].override) ? entry[1].override : {}
          return {
            id: `profile-${profileId}`,
            profileId,
            name: entry[0],
            mode: entry[1].type === 'inline' ? 'inline' : 'http',
            prefix:
              typeof override['additional-prefix'] === 'string'
                ? override['additional-prefix']
                : `[${entry[0]}] `,
            interval: Number(entry[1].interval) || 3600,
            url: typeof entry[1].url === 'string' ? entry[1].url : undefined,
            providerOptions: entry[1],
            proxies: []
          }
        }
      }
      const prefix = `[${item.name}] `
      const nodes = parse(draft.modules.proxies)
      if (Array.isArray(nodes)) {
        const proxies = nodes
          .filter(
            (node): node is LocalObject =>
              isRecord(node) && typeof node.name === 'string' && node.name.startsWith(prefix)
          )
          .map((node) => ({ ...node, name: String(node.name).slice(prefix.length) }))
        if (proxies.length) {
          return {
            id: `profile-${profileId}`,
            profileId,
            name: item.name,
            mode: 'extract',
            prefix,
            interval: 0,
            proxies
          }
        }
      }
      return undefined
    }
    const existing =
      state.draft.sources.find((source) => source.profileId === profileId) ||
      inferProviderSource(state.draft)
    const published =
      state.published.sources.find((source) => source.profileId === profileId) ||
      inferProviderSource(state.published)
    const previous = existing || published
    const names = new Set([
      ...state.draft.sources
        .filter((source) => source.profileId !== profileId)
        .map((source) => source.name),
      ...Object.keys(parse(state.draft.modules['proxy-providers']) || {})
    ])
    let name = options?.providerName?.trim() || previous?.name || item.name.trim() || '订阅'
    if (!previous && !options?.providerName?.trim()) {
      const base = name
      for (let suffix = 2; names.has(name); suffix++) name = `${base} (${suffix})`
    }
    const mode = options
      ? options.mode === 'nodes'
        ? 'extract'
        : item.type === 'remote'
          ? 'http'
          : 'inline'
      : previous?.mode || (item.type === 'remote' ? 'http' : 'inline')
    const source: LocalSource = {
      ...previous,
      id: previous?.id || `profile-${profileId}`,
      profileId,
      name,
      mode,
      prefix: options?.prefix ?? previous?.prefix ?? `[${name}] `,
      providerOptions:
        options?.providerOptions !== undefined
          ? normalizeLocalProviderOptions(options.providerOptions)
          : previous?.providerOptions,
      interval: previous?.interval ?? 3600,
      proxies: []
    }
    const sourceDraft = {
      ...state.draft,
      sources: [
        ...state.draft.sources.filter((candidate) => candidate.profileId !== profileId),
        source
      ]
    }
    if (!state.draft.sources.some((candidate) => candidate.profileId === profileId) && previous) {
      const providers = parse(sourceDraft.modules['proxy-providers'])
      if (isRecord(providers)) {
        delete providers[previous.name]
        sourceDraft.modules = { ...sourceDraft.modules, 'proxy-providers': stringify(providers) }
      }
    }
    const resolved = await resolveLocalDraft(sourceDraft)
    const nextSource = resolved.sources[0]
    const update = async (draft: LocalDraft): Promise<LocalDraft> => {
      const old =
        draft.sources.find((source) => source.profileId === profileId) ||
        (previous && inferProviderSource(draft))
      const base =
        old && !draft.sources.some((candidate) => candidate.profileId === profileId)
          ? {
              ...draft,
              sources: [
                ...draft.sources.filter((candidate) => candidate.profileId !== profileId),
                old
              ],
              modules: {
                ...draft.modules,
                'proxy-providers': (() => {
                  const providers = parse(draft.modules['proxy-providers'])
                  if (!isRecord(providers)) return draft.modules['proxy-providers']
                  delete providers[old.name]
                  return stringify(providers)
                })()
              }
            }
          : draft
      const oldResolved = old
        ? (await resolveLocalDraft({ ...base, sources: [old] })).sources[0]
        : undefined
      const next = replaceLocalSource(base, oldResolved, nextSource)
      return options?.targetGroups !== undefined
        ? setLocalSourceGroups(next, oldResolved || nextSource, nextSource, options.targetGroups)
        : next
    }
    const result = await commitLocalState(state, {
      ...state,
      revision: state.revision + 1,
      draft: await update(state.draft),
      published: await update(state.published)
    })
    if (result.errors.length) throw new Error(result.errors.join('\n'))
  })
}

export async function refreshLocalSource(id: string): Promise<LocalPreview> {
  return localWriteQueue.run(async () => {
    const state = await getLocalState()
    const source = state.draft.sources.find((item) => item.id === id)
    if (!source) throw new Error('找不到订阅来源')
    let proxies: Record<string, unknown>[]
    if (source.profileId) {
      const { getProfile } = await import('../config/profile')
      proxies = extractProxies(await getProfile(source.profileId))
    } else if (source.url) {
      proxies = await fetchSubscriptionProxies(source.url)
    } else {
      throw new Error(`订阅 ${source.name} 没有可刷新的地址`)
    }
    const draft = {
      ...state.draft,
      sources: state.draft.sources.map((item) =>
        item.id === id ? { ...item, proxies, updated: Date.now() } : item
      )
    }
    await saveLocalState({ ...state, draft, published: structuredClone(draft) })
    return compileLocalConfig(await resolveLocalDraft(draft), await getSharedConfig())
  })
}
export async function removeLocalSource(id: string): Promise<LocalPreview> {
  return localWriteQueue.run(async () => {
    const state = await getLocalState()
    const remove = (draft: LocalDraft): LocalDraft => ({
      ...draft,
      sources: draft.sources.filter((source) => source.id !== id)
    })
    return commitLocalState(state, {
      ...state,
      revision: state.revision + 1,
      draft: remove(state.draft),
      published: remove(state.published)
    })
  })
}

export async function detachLocalSource(profileId: string): Promise<void> {
  await withLocalProfileRemoval(profileId, async () => {})
}

export async function withLocalProfileRemoval<T>(
  profileId: string,
  remove: () => Promise<T>
): Promise<T> {
  return localWriteQueue.run(async () => {
    const state = await getLocalState()
    if (
      [...state.draft.sources, ...state.published.sources].some(
        (source) => source.profileId === profileId
      )
    ) {
      const detach = (draft: LocalDraft): LocalDraft => ({
        ...draft,
        sources: draft.sources.filter((source) => source.profileId !== profileId)
      })
      const result = await commitLocalState(state, {
        ...state,
        revision: state.revision + 1,
        draft: detach(state.draft),
        published: detach(state.published)
      })
      if (result.errors.length) throw new Error(result.errors.join('\n'))
    }
    // Detach before unlinking files. If file cleanup fails, retain the valid detached
    // configuration rather than restoring references to a potentially missing file.
    return remove()
  })
}
