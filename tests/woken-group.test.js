const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const projectRoot = path.resolve(__dirname, '..')

// Fake Chrome tabs/tabGroups/storage that mimics the one-group-per-window
// constraint plus the persistence semantics background.js relies on.
function createGroupHarness({ initialGroups = [], initialTabsByGroup = {}, lastFocusedWindowId = 1, initialStorage = {} } = {}) {
  const groups = new Map(initialGroups.map(group => [group.id, { ...group }]))
  const tabs = new Map()
  const storage = new Map(Object.entries(initialStorage))
  let nextTabId = 1
  let nextGroupId = 100

  // Seed tabs already sitting in existing groups (for merge tests).
  Object.entries(initialTabsByGroup).forEach(([groupId, urls]) => {
    const gid = Number(groupId)
    const group = groups.get(gid)
    urls.forEach(url => {
      const tab = { id: nextTabId++, url, windowId: group ? group.windowId : lastFocusedWindowId, groupId: gid }
      tabs.set(tab.id, tab)
    })
  })

  // Every async hop is a chance for a concurrent wake-up to interleave.
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))

  // Chrome dissolves a group automatically once it no longer contains tabs.
  function dissolveIfEmpty(groupId) {
    const stillHasTabs = [...tabs.values()].some(tab => tab.groupId === groupId)
    if (!stillHasTabs) {
      groups.delete(groupId)
    }
  }

  const tabGroupsOnUpdatedListeners = []
  const tabGroupsOnCreatedListeners = []
  const alarmListeners = []

  const chrome = {
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {} },
    alarms: {
      create: async () => {},
      clear: async () => {},
      get: async () => null,
      getAll: async () => [],
      onAlarm: { addListener: listener => alarmListeners.push(listener) },
    },
    commands: { onCommand: { addListener: () => {} } },
    notifications: { create: () => {} },
    runtime: {
      getURL: value => value,
      lastError: null,
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: () => {} },
      onStartup: { addListener: () => {} },
    },
    storage: {
      local: {
        // Chrome supports both the promise style and the older callback
        // style; background.js uses both, so the fake must too.
        get: (keys, callback) => {
          const run = async () => {
            await tick()
            if (keys === null || keys === undefined) {
              return Object.fromEntries(storage)
            }
            const list = Array.isArray(keys) ? keys : [keys]
            const result = {}
            for (const key of list) {
              if (storage.has(key)) result[key] = storage.get(key)
            }
            return result
          }
          if (typeof callback === 'function') {
            run().then(callback)
            return undefined
          }
          return run()
        },
        set: async items => {
          await tick()
          for (const [key, value] of Object.entries(items)) {
            storage.set(key, value)
          }
        },
        remove: async keys => {
          await tick()
          const list = Array.isArray(keys) ? keys : [keys]
          for (const key of list) storage.delete(key)
        },
      },
    },
    tabGroups: {
      get: async groupId => {
        await tick()
        if (!groups.has(groupId)) throw new Error(`No group with id: ${groupId}`)
        return { ...groups.get(groupId) }
      },
      query: async ({ title, windowId } = {}) => {
        await tick()
        return [...groups.values()]
          .filter(group => (title === undefined || group.title === title) && (windowId === undefined || group.windowId === windowId))
          .map(group => ({ ...group }))
      },
      update: async (groupId, properties) => {
        await tick()
        Object.assign(groups.get(groupId), properties)
        return { ...groups.get(groupId) }
      },
      onUpdated: { addListener: listener => tabGroupsOnUpdatedListeners.push(listener) },
      onCreated: { addListener: listener => tabGroupsOnCreatedListeners.push(listener) },
    },
    tabs: {
      create: async ({ url, windowId }) => {
        await tick()
        const tab = { id: nextTabId++, url, windowId: windowId ?? lastFocusedWindowId, groupId: -1 }
        tabs.set(tab.id, tab)
        return { ...tab }
      },
      group: async ({ tabIds, groupId }) => {
        await tick()
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
        const previousGroupIds = new Set(ids.map(id => tabs.get(id).groupId).filter(id => id !== -1))
        if (groupId === undefined) {
          groupId = nextGroupId++
          groups.set(groupId, { id: groupId, title: '', color: 'grey', windowId: tabs.get(ids[0]).windowId })
        } else if (!groups.has(groupId)) {
          throw new Error(`No group with id: ${groupId}`)
        }
        // Chrome pulls tabs into the group's window.
        for (const id of ids) Object.assign(tabs.get(id), { groupId, windowId: groups.get(groupId).windowId })
        // A source group dissolves once it no longer holds any tabs.
        for (const previousGroupId of previousGroupIds) {
          if (previousGroupId !== groupId) dissolveIfEmpty(previousGroupId)
        }
        return groupId
      },
      query: async ({ groupId } = {}) => {
        await tick()
        return [...tabs.values()].filter(tab => (groupId === undefined || tab.groupId === groupId)).map(tab => ({ ...tab }))
      },
      remove: async () => {},
    },
  }

  const source = fs.readFileSync(path.join(projectRoot, 'background.js'), 'utf8')
  const api = new Function(
    'chrome',
    `${source}; return { openWokenTab, checkForMissedTabs, WOKEN_GROUP_TITLE, WOKEN_GROUP_ID_STORAGE_KEY };`
  )(chrome)

  return {
    api,
    groups,
    tabs,
    storage,
    fireTabGroupsUpdated: group => tabGroupsOnUpdatedListeners.forEach(listener => listener(group)),
    fireTabGroupsCreated: group => tabGroupsOnCreatedListeners.forEach(listener => listener(group)),
    fireAlarm: alarm => alarmListeners.forEach(listener => listener(alarm)),
  }
}

test('tabs waking up at the same time all land in one Woken up group', async () => {
  const { api, groups, tabs } = createGroupHarness()

  // Simultaneous alarms: no awaiting between them, exactly as onAlarm fires them.
  await Promise.all([
    api.openWokenTab('https://example.com/one'),
    api.openWokenTab('https://example.com/two'),
    api.openWokenTab('https://example.com/three'),
  ])

  const wokenGroups = [...groups.values()].filter(group => group.title === api.WOKEN_GROUP_TITLE)
  assert.equal(wokenGroups.length, 1, 'expected a single Woken up group')
  assert.equal(wokenGroups[0].color, 'purple')

  const groupIds = [...tabs.values()].map(tab => tab.groupId)
  assert.deepEqual(groupIds, [wokenGroups[0].id, wokenGroups[0].id, wokenGroups[0].id])
})

test('a woken tab joins the existing group even when it lives in another window', async () => {
  const existing = { id: 7, title: 'Woken up 💤', color: 'purple', windowId: 2 }
  // The new tab would otherwise open in window 1, where there is no group.
  const { api, groups, tabs } = createGroupHarness({ initialGroups: [existing], lastFocusedWindowId: 1 })

  await api.openWokenTab('https://example.com/late')

  assert.equal([...groups.values()].filter(group => group.title === api.WOKEN_GROUP_TITLE).length, 1)
  assert.equal([...tabs.values()][0].groupId, 7)
})

test('a new group is created when the previous one was closed', async () => {
  const { api, groups } = createGroupHarness()

  await api.openWokenTab('https://example.com/first')
  const firstGroupId = [...groups.keys()][0]

  // User closes the group; the cached id is now stale.
  groups.delete(firstGroupId)
  await api.openWokenTab('https://example.com/second')

  const wokenGroups = [...groups.values()].filter(group => group.title === api.WOKEN_GROUP_TITLE)
  assert.equal(wokenGroups.length, 1)
  assert.notEqual(wokenGroups[0].id, firstGroupId)
})

test('a session-restored duplicate group is merged into the active one', async () => {
  const { api, groups, tabs, fireTabGroupsUpdated } = createGroupHarness()

  // Startup path: checkForMissedTabs()/an alarm creates group A first.
  await api.openWokenTab('https://example.com/a')
  const groupAId = [...groups.keys()][0]

  // Seconds later, Chrome's session restore re-creates the old titled group
  // B (with its own tab) in a separate, asynchronous step.
  const groupBId = 999
  groups.set(groupBId, { id: groupBId, title: api.WOKEN_GROUP_TITLE, color: 'purple', windowId: 1 })
  const strayTab = { id: 500, url: 'https://example.com/restored', windowId: 1, groupId: groupBId }
  tabs.set(strayTab.id, strayTab)

  // Fire the listener the way background.js registered it, and wait for the
  // consolidation it queues to settle.
  fireTabGroupsUpdated({ ...groups.get(groupBId) })
  await api.openWokenTab('https://example.com/settle-the-queue')

  const wokenGroups = [...groups.values()].filter(group => group.title === api.WOKEN_GROUP_TITLE)
  assert.equal(wokenGroups.length, 1, 'expected exactly one Woken up group after the merge')

  const groupIds = new Set([...tabs.values()].map(tab => tab.groupId))
  assert.deepEqual(groupIds, new Set([wokenGroups[0].id]), 'every tab should land in the single surviving group')
})

test('worker restart with two pre-existing titled groups merges into one on the next wake', async () => {
  const groupAId = 201
  const groupBId = 202
  const initialGroups = [
    { id: groupAId, title: 'Woken up 💤', color: 'purple', windowId: 1 },
    { id: groupBId, title: 'Woken up 💤', color: 'purple', windowId: 1 },
  ]
  // Fresh worker: no in-memory wokenGroupId, nothing persisted either.
  const { api, groups, tabs } = createGroupHarness({
    initialGroups,
    initialTabsByGroup: {
      [groupAId]: ['https://example.com/existing-a'],
      [groupBId]: ['https://example.com/existing-b'],
    },
  })

  await api.openWokenTab('https://example.com/new')

  const wokenGroups = [...groups.values()].filter(group => group.title === api.WOKEN_GROUP_TITLE)
  assert.equal(wokenGroups.length, 1, 'expected the two pre-existing groups to merge into one')

  const groupIds = new Set([...tabs.values()].map(tab => tab.groupId))
  assert.deepEqual(groupIds, new Set([wokenGroups[0].id]))
  assert.equal(tabs.size, 3, 'both pre-existing tabs and the new tab should all be accounted for')
})

test('an untitled orphan group from a killed worker is recovered and reused', async () => {
  const orphanId = 55
  const initialGroups = [{ id: orphanId, title: '', color: 'grey', windowId: 1 }]
  const { api, groups, tabs, storage } = createGroupHarness({
    initialGroups,
    initialTabsByGroup: { [orphanId]: ['https://example.com/half-created'] },
    // Simulate the persisted id surviving a worker restart with no in-memory state.
    initialStorage: { wokenGroupId: orphanId },
  })

  await api.openWokenTab('https://example.com/new')

  const wokenGroups = [...groups.values()].filter(group => group.title === api.WOKEN_GROUP_TITLE)
  assert.equal(wokenGroups.length, 1, 'expected no second group to be created')
  assert.equal(wokenGroups[0].id, orphanId, 'expected the orphan group to be reused, not replaced')
  assert.equal(tabs.size, 2)
  assert.equal(storage.get('wokenGroupId'), orphanId)
})

test('a firing alarm and the missed-tabs sweep cannot double-open the same snoozed tab', async () => {
  const key = 'snooze-123'
  const tabData = {
    url: 'https://example.com/overdue',
    title: 'Overdue tab',
    timestamp: 1,
    scheduledFor: 1, // Already due
    recurring: false,
  }
  const { api, tabs, storage, fireAlarm } = createGroupHarness({
    initialStorage: { [key]: tabData },
  })

  // Fire the alarm listener synchronously (mirrors chrome.alarms.onAlarm)
  // and run checkForMissedTabs() concurrently, exactly as could happen when
  // an alarm fires around the same time as the periodic/startup sweep.
  fireAlarm({ name: key })
  await api.checkForMissedTabs()

  // The alarm branch is fire-and-forget (callback-style storage.get), so its
  // chain of tab-create/group/storage-cleanup ticks may still be in flight;
  // poll (bounded) instead of guessing a fixed delay.
  for (let waited = 0; storage.has(key) && waited < 20; waited++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }

  const matchingTabs = [...tabs.values()].filter(tab => tab.url === tabData.url)
  assert.equal(matchingTabs.length, 1, 'expected exactly one tab to be opened for the overdue snooze')
  assert.equal(storage.has(key), false, 'expected the snooze- storage key to be removed')
})
