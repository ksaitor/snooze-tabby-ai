// Handle keyboard shortcuts
chrome.commands.onCommand.addListener(command => {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]) {
      switch (command) {
        case 'snooze-4-hours':
          snoozeTab(tabs[0], 4 * 60 * 60 * 1000) // 4 hours in milliseconds
          break
        case 'snooze-tomorrow-9am':
          snoozeTomorrowAt9AM(tabs[0])
          break
        case 'snooze-one-month':
          snoozeTab(tabs[0], 30 * 24 * 60 * 60 * 1000) // 30 days in milliseconds
          break
        case 'snooze-next-monday':
          snoozeNextMonday(tabs[0])
          break
      }
    }
  })
})

// Handle startup - check for missed tabs when browser starts
chrome.runtime.onStartup.addListener(() => {
  checkForMissedTabs()
  ensurePeriodicCheck()
  cleanupOrphanedAlarms()
  restoreWokenBadge()
})

// Tab group that collects woken tabs so they don't steal focus
const WOKEN_GROUP_TITLE = 'Woken up 💤'
const WOKEN_GROUP_COLOR = 'purple'

// Storage key for the persisted group id. Deliberately does NOT start with
// "snooze-" so it's invisible to the snooze-key scans in checkForMissedTabs()
// and cleanupOrphanedAlarms().
const WOKEN_GROUP_ID_STORAGE_KEY = 'wokenGroupId'

// Remembered id of the shared group, so repeat wake-ups skip straight to a
// merge target. Also persisted to storage so it survives a worker restart.
let wokenGroupId = null
// Wake-ups run one at a time; otherwise simultaneous alarms each miss the
// group the others are still creating and we end up with duplicates
let wokenGroupQueue = Promise.resolve()

// Tabs whose snooze- storage key is currently being handled, so the
// periodic/startup sweep and a firing alarm can't both open the same tab.
const processingSnoozeKeys = new Set()

// Update the in-memory id synchronously (so onUpdated/onCreated listeners
// see it immediately) and persist it for recovery after a worker restart.
function setWokenGroupId(id) {
  wokenGroupId = id
  return chrome.storage.local.set({ [WOKEN_GROUP_ID_STORAGE_KEY]: id })
}

async function getPersistedWokenGroupId() {
  const data = await chrome.storage.local.get(WOKEN_GROUP_ID_STORAGE_KEY)
  const value = data[WOKEN_GROUP_ID_STORAGE_KEY]
  return value === undefined ? null : value
}

// Recover a group left half-created if the worker died between
// chrome.tabs.group() and chrome.tabGroups.update() in createWokenGroup:
// the persisted id resolves to a real, still-untitled group.
async function recoverOrphanGroup() {
  const persistedId = wokenGroupId !== null ? wokenGroupId : await getPersistedWokenGroupId()
  if (persistedId === null) return null

  let group
  try {
    group = await chrome.tabGroups.get(persistedId)
  } catch (err) {
    return null // Group is gone
  }

  if (group.title === WOKEN_GROUP_TITLE) {
    return group
  }

  if (group.title !== '') {
    // Some other, non-empty title: the user renamed it. Not ours anymore.
    return null
  }

  // Set the in-memory id before retitling so our own update below doesn't
  // trigger a pointless (though harmless) consolidation via onUpdated.
  wokenGroupId = persistedId
  await chrome.tabGroups.update(group.id, {
    title: WOKEN_GROUP_TITLE,
    color: WOKEN_GROUP_COLOR,
  })
  return { ...group, title: WOKEN_GROUP_TITLE, color: WOKEN_GROUP_COLOR }
}

// Make exactly one "Woken up" group exist, merging any duplicates (e.g. one
// created at startup racing with Chrome's asynchronous session restore of
// the previous group) into a single, deterministically-chosen target.
// Must only ever run while serialized on wokenGroupQueue.
async function consolidateWokenGroups() {
  const titledGroups = await chrome.tabGroups.query({ title: WOKEN_GROUP_TITLE })

  if (titledGroups.length === 0) {
    const recovered = await recoverOrphanGroup()
    if (recovered) {
      await setWokenGroupId(recovered.id)
      return recovered
    }
    await setWokenGroupId(null)
    return null
  }

  // Prefer the group we already know about so the target stays stable across
  // consolidation runs; otherwise fall back to the first result.
  const knownId = wokenGroupId !== null ? wokenGroupId : await getPersistedWokenGroupId()
  const target = titledGroups.find(group => group.id === knownId) || titledGroups[0]

  for (const group of titledGroups) {
    if (group.id === target.id) continue
    try {
      const strayTabs = await chrome.tabs.query({ groupId: group.id })
      if (strayTabs.length > 0) {
        // Chrome pulls the tabs into the target's window; the source group
        // dissolves automatically once it's empty.
        await chrome.tabs.group({ tabIds: strayTabs.map(tab => tab.id), groupId: target.id })
      }
    } catch (err) {
      // Best-effort: e.g. "tabs cannot be edited right now" while the user is
      // dragging a tab. Leave the stray group for the next consolidation pass.
      console.error('Failed to merge woken group', group.id, 'into', target.id, ':', err)
    }
  }

  await setWokenGroupId(target.id)
  return target
}

// Locate the single "Woken up" group, wherever it lives, or null if there is
// none. Always queries + consolidates rather than trusting the cached id:
// wake-ups are infrequent, so correctness beats the saved lookup.
async function findWokenGroup() {
  return consolidateWokenGroups()
}

// Put a woken tab into a brand new group and label it
async function createWokenGroup(tabId) {
  const groupId = await chrome.tabs.group({ tabIds: tabId })
  // Persist before titling: if the worker dies right here, the next lookup
  // finds this untitled group via recoverOrphanGroup() instead of orphaning
  // it. Setting the in-memory id first also keeps our own title update from
  // triggering a pointless consolidation via the onUpdated listener below.
  await setWokenGroupId(groupId)
  await chrome.tabGroups.update(groupId, {
    title: WOKEN_GROUP_TITLE,
    color: WOKEN_GROUP_COLOR,
  })
  return groupId
}

// A group can appear with our title from outside the normal flow — most
// notably Chrome's session restore re-creating the old "Woken up" group a
// few seconds after startup, after checkForMissedTabs() already made a new
// one. Heal by folding it into the active group. Consolidation never
// retitles/updates groups (only moves tabs), so this cannot loop.
function handleWokenGroupAppearance(group) {
  if (group.title !== WOKEN_GROUP_TITLE || group.id === wokenGroupId) return
  const result = wokenGroupQueue.then(() => consolidateWokenGroups())
  // Keep the queue alive even if this consolidation fails
  wokenGroupQueue = result.catch(err => console.error('Failed to consolidate woken groups:', err))
}

chrome.tabGroups.onUpdated.addListener(handleWokenGroupAppearance)
chrome.tabGroups.onCreated?.addListener(handleWokenGroupAppearance)

// Open a woken tab in the background and collect it into the woken group
function openWokenTab(url) {
  const result = wokenGroupQueue.then(() => openWokenTabInGroup(url))
  // Keep the queue alive even if this wake-up fails
  wokenGroupQueue = result.catch(() => {})
  return result
}

async function openWokenTabInGroup(url) {
  let wokenGroup = null
  try {
    wokenGroup = await findWokenGroup()
  } catch (err) {
    // Lookup is best-effort; worst case we start a new group below
    console.error('Failed to look up woken group:', err)
  }

  const tab = await chrome.tabs.create({
    url: url,
    active: false, // Don't steal focus from whatever the user is doing
    // Open in the group's window so it can actually join that group
    ...(wokenGroup ? { windowId: wokenGroup.windowId } : {}),
  })

  try {
    if (wokenGroup) {
      await chrome.tabs.group({ tabIds: tab.id, groupId: wokenGroup.id })
    } else {
      await createWokenGroup(tab.id)
    }
  } catch (err) {
    // Grouping is best-effort; the tab is already open
    console.error('Failed to group woken tab:', err)
    await setWokenGroupId(null)

    // The group may have disappeared between lookup and grouping; start a new one
    if (wokenGroup) {
      try {
        await createWokenGroup(tab.id)
      } catch (retryErr) {
        console.error('Failed to create woken group:', retryErr)
      }
    }
  }

  return tab
}

// Increment the badge counter of woken tabs (cleared when popup opens)
async function incrementWokenBadge(count = 1) {
  try {
    const { wokenCount = 0 } = await chrome.storage.local.get('wokenCount')
    const newCount = wokenCount + count
    await chrome.storage.local.set({ wokenCount: newCount })
    await chrome.action.setBadgeBackgroundColor({ color: '#007bff' })
    await chrome.action.setBadgeText({ text: String(newCount) })
  } catch (err) {
    console.error('Failed to update badge:', err)
  }
}

// Restore badge from storage after browser restart
async function restoreWokenBadge() {
  try {
    const { wokenCount = 0 } = await chrome.storage.local.get('wokenCount')
    if (wokenCount > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: '#007bff' })
      await chrome.action.setBadgeText({ text: String(wokenCount) })
    }
  } catch (err) {
    console.error('Failed to restore badge:', err)
  }
}

// Popup clears the badge when opened
chrome.runtime.onMessage.addListener(request => {
  if (request.action === 'clearWokenBadge') {
    chrome.storage.local.set({ wokenCount: 0 })
    chrome.action.setBadgeText({ text: '' })
  }
})

// Handle installation - also check for missed tabs
chrome.runtime.onInstalled.addListener(() => {
  checkForMissedTabs()
  ensurePeriodicCheck()
  cleanupOrphanedAlarms()
})

// Ensure periodic check alarm is set up
function ensurePeriodicCheck() {
  chrome.alarms
    .get('periodic-check')
    .then(alarm => {
      if (!alarm) {
        chrome.alarms
          .create('periodic-check', { periodInMinutes: 15 })
          .then(() => console.log('Periodic check alarm created'))
          .catch(err => console.error('Failed to create periodic check alarm:', err))
      }
    })
    .catch(err => {
      console.error('Error checking periodic alarm:', err)
      // Create it anyway
      chrome.alarms
        .create('periodic-check', { periodInMinutes: 15 })
        .then(() => console.log('Periodic check alarm created'))
        .catch(err => console.error('Failed to create periodic check alarm:', err))
    })
}

// Clean up orphaned alarms (alarms without corresponding storage data)
function cleanupOrphanedAlarms() {
  chrome.alarms
    .getAll()
    .then(alarms => {
      const snoozeAlarms = alarms.filter(alarm => alarm.name.startsWith('snooze-'))

      if (snoozeAlarms.length > 0) {
        const alarmNames = snoozeAlarms.map(alarm => alarm.name)
        chrome.storage.local.get(alarmNames, data => {
          const orphanedAlarms = alarmNames.filter(name => !data[name])

          orphanedAlarms.forEach(alarmName => {
            chrome.alarms
              .clear(alarmName)
              .then(() => {
                console.log(`Cleaned up orphaned alarm: ${alarmName}`)
              })
              .catch(err => {
                console.error(`Failed to clean up alarm ${alarmName}:`, err)
              })
          })
        })
      }
    })
    .catch(err => {
      console.error('Error cleaning up orphaned alarms:', err)
    })
}

// Handle periodic checks
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'periodic-check') {
    checkForMissedTabs()
  } else if (alarm.name.startsWith('snooze-')) {
    // Guard against checkForMissedTabs() picking up the same overdue key
    // before this alarm's own storage read below completes.
    if (processingSnoozeKeys.has(alarm.name)) return
    processingSnoozeKeys.add(alarm.name)

    chrome.storage.local.get([alarm.name], result => {
      const tabData = result[alarm.name]
      if (!tabData) {
        processingSnoozeKeys.delete(alarm.name)
        return
      }

      // Reopen the tab gently: in the background, grouped, with badge + notification
      openWokenTab(tabData.url)
        .then(() => {
          incrementWokenBadge()
          showNotification(`Tab woke up: ${tabData.title}`)
        })
        .catch(err => {
          console.error('Failed to reopen snoozed tab:', err)
          showNotification(`Failed to reopen tab: ${tabData.title}`)
        })
        .finally(() => {
          // Clean up storage only after the open attempt settles, so a crash
          // mid-open doesn't lose the tab; check if it's a recurring snooze.
          if (tabData.recurring) {
            scheduleRecurringSnooze(tabData, alarm.name)
          } else {
            chrome.storage.local.remove([alarm.name])
          }
          processingSnoozeKeys.delete(alarm.name)
        })
    })
  }
})

// Check for tabs that should have been opened during downtime
async function checkForMissedTabs() {
  try {
    const data = await chrome.storage.local.get(null)
    const now = Date.now()
    const missedTabs = []

    Object.keys(data).forEach(key => {
      if (key.startsWith('snooze-') && data[key].scheduledFor <= now) {
        missedTabs.push({ key, ...data[key] })
      }
    })

    if (missedTabs.length > 0) {
      console.log(`Found ${missedTabs.length} missed tabs, reopening...`)

      // missedTabs.length also includes entries the firing-alarm path already
      // claimed (skipped below via processingSnoozeKeys) and invalid entries
      // that get removed without ever being opened; only count what this
      // sweep itself actually attempted to open, for an accurate badge/notification.
      let openedCount = 0

      for (const tabData of missedTabs) {
        try {
          // Validate tab data
          if (!tabData.url || !tabData.title) {
            console.warn('Invalid tab data, skipping:', tabData)
            await chrome.storage.local.remove([tabData.key])
            continue
          }

          // Guard against a firing alarm handling this same key concurrently
          if (processingSnoozeKeys.has(tabData.key)) {
            continue
          }
          processingSnoozeKeys.add(tabData.key)

          try {
            // Open the missed tab gently in the woken group
            try {
              await openWokenTab(tabData.url)
              openedCount++
            } catch (err) {
              console.error('Failed to open tab:', err)
              showNotification(`Failed to open tab: ${tabData.title}`)
            }

            // Handle recurring tabs
            if (tabData.recurring) {
              await scheduleRecurringSnooze(tabData, tabData.key)
            } else {
              // The alarm may still be pending (e.g. delayInMinutes rounded
              // up); clear it so it can't fire later against data we're
              // about to remove.
              try {
                await chrome.alarms.clear(tabData.key)
              } catch (err) {
                console.error('Failed to clear alarm:', err)
              }
              // Clean up storage
              try {
                await chrome.storage.local.remove([tabData.key])
              } catch (err) {
                console.error('Failed to clean up storage:', err)
              }
            }
          } finally {
            processingSnoozeKeys.delete(tabData.key)
          }
        } catch (err) {
          console.error('Error processing missed tab:', err)
        }
      }

      // Show notification about reopened tabs (only for the tabs this sweep opened)
      if (openedCount > 0) {
        incrementWokenBadge(openedCount)
        showNotification(`${openedCount} tab(s) reopened from snooze`)
      }
    }
  } catch (err) {
    console.error('Error checking for missed tabs:', err)
  }
}

// Snooze tab function
function snoozeTab(tab, delayMs) {
  const alarmName = `snooze-${Date.now()}`
  const when = Date.now() + delayMs

  // Store tab data
  chrome.storage.local
    .set({
      [alarmName]: {
        url: tab.url,
        title: tab.title,
        timestamp: Date.now(),
        scheduledFor: when,
        recurring: false,
      },
    })
    .then(() => {
      // Create alarm with delay instead of absolute time for better persistence
      return chrome.alarms.create(alarmName, { delayInMinutes: delayMs / (1000 * 60) })
    })
    .then(() => {
      // Close the tab
      return chrome.tabs.remove(tab.id)
    })
    .then(() => {
      // Show notification
      showNotification(`Tab snoozed until ${new Date(when).toLocaleString()}`)
    })
    .catch(err => {
      console.error('Error snoozing tab:', err)
      showNotification('Failed to snooze tab')
    })
}

// Snooze until tomorrow 9AM
function snoozeTomorrowAt9AM(tab) {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)

  const alarmName = `snooze-${Date.now()}`

  chrome.storage.local
    .set({
      [alarmName]: {
        url: tab.url,
        title: tab.title,
        timestamp: Date.now(),
        scheduledFor: tomorrow.getTime(),
        recurring: false,
      },
    })
    .then(() => {
      // Use delayInMinutes for better persistence
      const delayMs = tomorrow.getTime() - Date.now()
      return chrome.alarms.create(alarmName, { delayInMinutes: delayMs / (1000 * 60) })
    })
    .then(() => {
      return chrome.tabs.remove(tab.id)
    })
    .then(() => {
      showNotification(`Tab snoozed until tomorrow at 9:00 AM`)
    })
    .catch(err => {
      console.error('Error snoozing tab until tomorrow:', err)
      showNotification('Failed to snooze tab')
    })
}

// Snooze until next Monday 9AM
function snoozeNextMonday(tab) {
  const nextMonday = new Date()
  const currentDay = nextMonday.getDay()

  // Calculate days until next Monday (1 = Monday, 0 = Sunday)
  // If today is Monday, schedule for next Monday (7 days)
  let daysUntilMonday = (1 - currentDay + 7) % 7
  if (daysUntilMonday === 0) {
    daysUntilMonday = 7 // If today is Monday, schedule for next Monday
  }

  nextMonday.setDate(nextMonday.getDate() + daysUntilMonday)
  nextMonday.setHours(9, 0, 0, 0)

  const alarmName = `snooze-${Date.now()}`

  chrome.storage.local
    .set({
      [alarmName]: {
        url: tab.url,
        title: tab.title,
        timestamp: Date.now(),
        scheduledFor: nextMonday.getTime(),
        recurring: false,
      },
    })
    .then(() => {
      // Use delayInMinutes for better persistence
      const delayMs = nextMonday.getTime() - Date.now()
      return chrome.alarms.create(alarmName, { delayInMinutes: delayMs / (1000 * 60) })
    })
    .then(() => {
      return chrome.tabs.remove(tab.id)
    })
    .then(() => {
      showNotification(`Tab snoozed until next Monday at 9:00 AM`)
    })
    .catch(err => {
      console.error('Error snoozing tab until next Monday:', err)
      showNotification('Failed to snooze tab')
    })
}

// Schedule custom snooze
function scheduleCustomSnooze(tab, targetDate) {
  const alarmName = `snooze-${Date.now()}`

  chrome.storage.local
    .set({
      [alarmName]: {
        url: tab.url,
        title: tab.title,
        timestamp: Date.now(),
        scheduledFor: targetDate.getTime(),
        recurring: false,
      },
    })
    .then(() => {
      // Use delayInMinutes for better persistence
      const delayMs = targetDate.getTime() - Date.now()
      return chrome.alarms.create(alarmName, { delayInMinutes: delayMs / (1000 * 60) })
    })
    .then(() => {
      return chrome.tabs.remove(tab.id)
    })
    .then(() => {
      showNotification(`Tab snoozed until ${targetDate.toLocaleString()}`)
    })
    .catch(err => {
      console.error('Error scheduling custom snooze:', err)
      showNotification('Failed to snooze tab')
    })
}

function getMonthlyDate(year, month, day, recurringTime) {
  const lastDayOfMonth = new Date(year, month + 1, 0).getDate()
  const nextDate = new Date(year, month, Math.min(day, lastDayOfMonth))

  if (recurringTime) {
    const [hours, minutes] = recurringTime.split(':').map(Number)
    nextDate.setHours(hours, minutes, 0, 0)
  }

  return nextDate
}

function getYearlyDate(year, month, day, recurringTime) {
  const lastDayOfMonth = new Date(year, month, 0).getDate()
  const nextDate = new Date(year, month - 1, Math.min(day, lastDayOfMonth))

  if (recurringTime) {
    const [hours, minutes] = recurringTime.split(':').map(Number)
    nextDate.setHours(hours, minutes, 0, 0)
  }

  return nextDate
}

function getNextRecurringDate(
  recurringType,
  recurringTime,
  selectedDays = [],
  monthlyDay,
  monthlyInterval = 1,
  yearlyMonth,
  yearlyDay,
  now = new Date()
) {
  let nextDate = new Date(now)

  switch (recurringType) {
    case 'daily':
      nextDate.setDate(nextDate.getDate() + 1)
      break
    case 'weekly':
      if (selectedDays.length > 0) {
        // Find the next occurrence of any selected day
        const currentDay = nextDate.getDay()
        let daysToAdd = 1

        // Check if any selected day is today or in the next 6 days
        for (let i = 1; i <= 7; i++) {
          const checkDay = (currentDay + i) % 7
          if (selectedDays.includes(checkDay)) {
            daysToAdd = i
            break
          }
        }
        nextDate.setDate(nextDate.getDate() + daysToAdd)
      } else {
        // Fallback to next week same day
        nextDate.setDate(nextDate.getDate() + 7)
      }
      break
    case 'monthly':
      if (Number.isInteger(monthlyDay) && monthlyDay >= 1 && monthlyDay <= 31) {
        const interval = Math.max(1, Number.isInteger(monthlyInterval) ? monthlyInterval : 1)
        nextDate = getMonthlyDate(now.getFullYear(), now.getMonth() + interval, monthlyDay, recurringTime)
        // If we overshot (e.g., the calculated date is still in the past due to
        // edge-of-month clamping), push forward one more interval.
        if (nextDate <= now) {
          nextDate = getMonthlyDate(nextDate.getFullYear(), nextDate.getMonth() + interval, monthlyDay, recurringTime)
        }
        return nextDate
      }
      nextDate.setMonth(nextDate.getMonth() + 1)
      break
    case 'yearly':
      if (
        Number.isInteger(yearlyMonth) &&
        yearlyMonth >= 1 &&
        yearlyMonth <= 12 &&
        Number.isInteger(yearlyDay) &&
        yearlyDay >= 1 &&
        yearlyDay <= 31
      ) {
        nextDate = getYearlyDate(nextDate.getFullYear(), yearlyMonth, yearlyDay, recurringTime)
        if (nextDate <= now) {
          nextDate = getYearlyDate(now.getFullYear() + 1, yearlyMonth, yearlyDay, recurringTime)
        }
        return nextDate
      }
      nextDate.setFullYear(nextDate.getFullYear() + 1)
      break
  }

  if (recurringTime) {
    const [hours, minutes] = recurringTime.split(':')
    nextDate.setHours(parseInt(hours), parseInt(minutes), 0, 0)
  }

  return nextDate
}

// Schedule the next occurrence using the existing storage key so recurring
// schedules do not leave already-fired records behind.
async function scheduleRecurringSnooze(tabData, alarmName) {
  const nextDate = getNextRecurringDate(
    tabData.recurringType,
    tabData.recurringTime,
    tabData.selectedDays,
    tabData.monthlyDay,
    tabData.monthlyInterval,
    tabData.yearlyMonth,
    tabData.yearlyDay
  )

  try {
    await chrome.storage.local.set({
      [alarmName]: {
        ...tabData,
        scheduledFor: nextDate.getTime(),
      },
    })

    // Use delayInMinutes for better persistence
    const delayMs = nextDate.getTime() - Date.now()
    await chrome.alarms.create(alarmName, { delayInMinutes: delayMs / (1000 * 60) })
  } catch (err) {
    console.error('Error scheduling recurring snooze:', err)
  }
}

// Show notification
function showNotification(message) {
  chrome.notifications?.create(
    {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon128.png'),
      title: 'Snooze Tabby',
      message: message,
    },
    () => {
      if (chrome.runtime.lastError) {
        console.error('Notification error:', chrome.runtime.lastError.message)
      }
    }
  )
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'snooze') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]) {
        switch (request.type) {
          case '4-hours':
            snoozeTab(tabs[0], 4 * 60 * 60 * 1000)
            break
          case 'tomorrow-9am':
            snoozeTomorrowAt9AM(tabs[0])
            break
          case 'one-month':
            snoozeTab(tabs[0], 30 * 24 * 60 * 60 * 1000)
            break
          case 'next-monday':
            snoozeNextMonday(tabs[0])
            break
        }
      }
    })
  } else if (request.action === 'snoozeTab' && request.type === 'custom') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]) {
        scheduleCustomSnooze(tabs[0], new Date(request.date))
      }
    })
  } else if (request.action === 'snoozeTab' && request.type === 'recurring') {
    handleRecurringRequest(request, sendResponse)
    return true
  }
})

async function handleRecurringRequest(request, sendResponse) {
  try {
    const tab = request.tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
    if (!tab) {
      throw new Error('Could not find the active tab')
    }

    await scheduleRecurringTab(
      tab,
      request.recurringType,
      request.recurringTime,
      request.selectedDays,
      request.monthlyDay,
      request.monthlyInterval,
      request.yearlyMonth,
      request.yearlyDay
    )
    sendResponse({ success: true })

    try {
      await chrome.tabs.remove(tab.id)
    } catch (err) {
      console.error('Recurring snooze was scheduled, but the tab could not be closed:', err)
      showNotification('Recurring snooze saved, but the tab could not be closed')
    }
  } catch (err) {
    console.error('Error scheduling recurring tab:', err)
    showNotification('Failed to schedule recurring tab')
    sendResponse({ success: false, error: err.message })
  }
}

// Schedule recurring tab
async function scheduleRecurringTab(tab, recurringType, recurringTime, selectedDays = [], monthlyDay, monthlyInterval, yearlyMonth, yearlyDay) {
  if (recurringType === 'monthly' && (!Number.isInteger(monthlyDay) || monthlyDay < 1 || monthlyDay > 31)) {
    throw new Error('Please select a day of the month from 1 to 31')
  }

  if (
    recurringType === 'yearly' &&
    (!Number.isInteger(yearlyMonth) ||
      yearlyMonth < 1 ||
      yearlyMonth > 12 ||
      !Number.isInteger(yearlyDay) ||
      yearlyDay < 1 ||
      yearlyDay > 31)
  ) {
    throw new Error('Please select a valid yearly date and time')
  }

  const alarmName = `snooze-${Date.now()}`
  const nextDate = getNextRecurringDate(
    recurringType,
    recurringTime,
    selectedDays,
    monthlyDay,
    monthlyInterval,
    yearlyMonth,
    yearlyDay
  )

  await chrome.storage.local.set({
    [alarmName]: {
      url: tab.url,
      title: tab.title,
      timestamp: Date.now(),
      scheduledFor: nextDate.getTime(),
      recurring: true,
      recurringType: recurringType,
      recurringTime: recurringTime,
      selectedDays: selectedDays,
      monthlyDay: monthlyDay,
      monthlyInterval: monthlyInterval,
      yearlyMonth: yearlyMonth,
      yearlyDay: yearlyDay,
    },
  })

  try {
    // Use delayInMinutes for better persistence
    const delayMs = nextDate.getTime() - Date.now()
    await chrome.alarms.create(alarmName, { delayInMinutes: delayMs / (1000 * 60) })
  } catch (err) {
    // Do not leave an unscheduled item in History if alarm creation fails.
    await chrome.storage.local.remove(alarmName)
    throw err
  }

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const selectedDayNames = selectedDays
    .map(day => dayNames[day])
    .sort((a, b) => {
      const order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      return order.indexOf(a) - order.indexOf(b)
    })
    .join(', ')
  const message =
    recurringType === 'weekly'
      ? `Tab set to recur weekly on ${selectedDayNames} at ${recurringTime || 'current time'}`
      : recurringType === 'monthly'
        ? `Tab set to recur every ${monthlyInterval || 1} month(s) on day ${monthlyDay} at ${recurringTime || 'current time'}`
        : recurringType === 'yearly'
          ? `Tab set to recur yearly on ${yearlyMonth}/${yearlyDay} at ${recurringTime || 'current time'}`
        : `Tab set to recur ${recurringType} at ${recurringTime || 'current time'}`
  showNotification(message)

  return { alarmName, scheduledFor: nextDate.getTime() }
}
