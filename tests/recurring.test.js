const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const projectRoot = path.resolve(__dirname, '..')

function createBackgroundHarness() {
  const messageListeners = []
  const storage = {}
  const alarms = {}
  const removedTabs = []

  const chrome = {
    action: {
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async () => {},
    },
    alarms: {
      create: async (name, options) => {
        alarms[name] = options
      },
      get: async () => null,
      getAll: async () => [],
      onAlarm: { addListener: () => {} },
    },
    commands: { onCommand: { addListener: () => {} } },
    notifications: { create: () => {} },
    runtime: {
      getURL: value => value,
      lastError: null,
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: listener => messageListeners.push(listener) },
      onStartup: { addListener: () => {} },
    },
    storage: {
      local: {
        get: async keys => {
          if (keys === null) return { ...storage }
          const requestedKeys = Array.isArray(keys) ? keys : [keys]
          return Object.fromEntries(requestedKeys.filter(key => key in storage).map(key => [key, storage[key]]))
        },
        remove: async keys => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key]
        },
        set: async values => Object.assign(storage, values),
      },
    },
    tabGroups: {
      get: async () => {
        throw new Error('No group')
      },
      query: async () => [],
      update: async () => ({}),
      onUpdated: { addListener: () => {} },
      onCreated: { addListener: () => {} },
    },
    tabs: {
      query: async () => [],
      remove: async tabId => removedTabs.push(tabId),
    },
  }

  const source = fs.readFileSync(path.join(projectRoot, 'background.js'), 'utf8')
  const api = new Function('chrome', `${source}; return { getNextRecurringDate, scheduleRecurringSnooze };`)(chrome)

  return { alarms, api, messageListeners, removedTabs, storage }
}

function createPopupHarness(storage) {
  const historyList = { innerHTML: '' }
  const emptyState = { style: {} }
  const escapeHtml = value =>
    String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;')

  const document = {
    addEventListener: () => {},
    createElement: () => {
      let text = ''
      return {
        get innerHTML() {
          return escapeHtml(text)
        },
        set textContent(value) {
          text = value
        },
      }
    },
    getElementById: id => (id === 'history-list' ? historyList : emptyState),
    querySelectorAll: () => [],
  }

  const chrome = {
    runtime: { onMessage: { addListener: () => {} } },
    storage: {
      local: {
        get: (_keys, callback) => callback({ ...storage }),
      },
    },
  }

  const source = fs.readFileSync(path.join(projectRoot, 'popup.js'), 'utf8')
  const popup = new Function('chrome', 'document', `${source}; return { getRecurringDescription, loadSnoozeHistory };`)(
    chrome,
    document
  )

  return { historyList, popup }
}

test('a monthly recurring snooze is persisted, alarmed, and rendered in History', async () => {
  const background = createBackgroundHarness()

  // The recurring handler is the listener that keeps the message channel open.
  const request = {
    action: 'snoozeTab',
    type: 'recurring',
    tab: { id: 42, title: 'Monthly report', url: 'https://example.com/report' },
    recurringType: 'monthly',
    recurringTime: '09:00',
    selectedDays: [],
    monthlyDay: 15,
  }

  const response = await new Promise((resolve, reject) => {
    let handled = false
    for (const listener of background.messageListeners) {
      const result = listener(request, {}, resolve)
      if (result === true) handled = true
    }
    if (!handled) reject(new Error('Recurring message was not handled asynchronously'))
  })

  assert.deepEqual(response, { success: true })

  const entries = Object.entries(background.storage).filter(([key]) => key.startsWith('snooze-'))
  assert.equal(entries.length, 1)

  const [alarmName, item] = entries[0]
  assert.equal(item.recurring, true)
  assert.equal(item.recurringType, 'monthly')
  assert.equal(item.monthlyDay, 15)
  assert.ok(background.alarms[alarmName])
  assert.deepEqual(background.removedTabs, [42])

  const { historyList, popup } = createPopupHarness(background.storage)
  popup.loadSnoozeHistory()

  assert.match(historyList.innerHTML, /class="recurring-badge">Recurring</)
  assert.match(historyList.innerHTML, /Monthly · day 15 at 09:00/)
  assert.match(historyList.innerHTML, /Monthly report/)

  await background.api.scheduleRecurringSnooze(item, alarmName)

  const rescheduledEntries = Object.entries(background.storage).filter(([key]) => key.startsWith('snooze-'))
  assert.equal(rescheduledEntries.length, 1)
  assert.equal(rescheduledEntries[0][0], alarmName)
  assert.equal(rescheduledEntries[0][1].recurring, true)
})

test('a yearly recurring snooze uses the selected month, day, and time', () => {
  const { api } = createBackgroundHarness()
  const nextDate = api.getNextRecurringDate('yearly', '09:30', [], undefined, 1, 12, 25, new Date(2026, 7, 1, 12))

  assert.equal(nextDate.getFullYear(), 2026)
  assert.equal(nextDate.getMonth(), 11)
  assert.equal(nextDate.getDate(), 25)
  assert.equal(nextDate.getHours(), 9)
  assert.equal(nextDate.getMinutes(), 30)

  const leapDay = api.getNextRecurringDate('yearly', '09:00', [], undefined, 1, 2, 29, new Date(2027, 0, 1, 12))
  assert.equal(leapDay.getFullYear(), 2027)
  assert.equal(leapDay.getMonth(), 1)
  assert.equal(leapDay.getDate(), 28)

  const { popup } = createPopupHarness({})
  assert.equal(
    popup.getRecurringDescription({ recurringType: 'yearly', yearlyMonth: 12, yearlyDay: 25, recurringTime: '09:30' }),
    'Yearly · 12/25 at 09:30'
  )
})
