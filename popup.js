document.addEventListener('DOMContentLoaded', () => {
  // Tab switching functionality
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', e => {
      const targetTab = e.target.getAttribute('data-tab')

      // Remove active class from all tabs and panes
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'))

      // Add active class to clicked tab and corresponding pane
      e.target.classList.add('active')
      document.getElementById(`${targetTab}-tab`).classList.add('active')

      // Load history when history tab is selected
      if (targetTab === 'history') {
        loadSnoozeHistory()
      }
    })
  })

  // Quick snooze buttons
  document.getElementById('snooze-4-hours').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]) {
        chrome.runtime.sendMessage({
          action: 'snooze',
          type: '4-hours',
          tab: tabs[0],
        })
        window.close()
      }
    })
  })

  document.getElementById('snooze-tomorrow-9am').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]) {
        chrome.runtime.sendMessage({
          action: 'snooze',
          type: 'tomorrow-9am',
          tab: tabs[0],
        })
        window.close()
      }
    })
  })

  document.getElementById('snooze-one-month').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]) {
        chrome.runtime.sendMessage({
          action: 'snooze',
          type: 'one-month',
          tab: tabs[0],
        })
        window.close()
      }
    })
  })

  // Custom date scheduling
  document.getElementById('schedule-custom').addEventListener('click', () => {
    const dateInput = document.getElementById('custom-date')
    const selectedDate = dateInput.value

    if (!selectedDate) {
      alert('Please select a date and time')
      return
    }

    const targetDate = new Date(selectedDate)

    if (targetDate <= new Date()) {
      alert('Please select a future date and time')
      return
    }

    chrome.runtime.sendMessage({
      action: 'snoozeTab',
      type: 'custom',
      date: targetDate.toISOString(),
    })

    window.close()
  })

  // Handle recurring type change to show/hide weekly days selector
  document.getElementById('recurring-type').addEventListener('change', () => {
    const recurringType = document.getElementById('recurring-type').value
    const weeklyDays = document.getElementById('weekly-days')

    if (recurringType === 'weekly') {
      weeklyDays.style.display = 'block'
      // Default select current day of week
      const currentDay = new Date().getDay()
      const currentDayCheckbox = document.querySelector(`#weekly-days input[value="${currentDay}"]`)
      if (currentDayCheckbox) {
        currentDayCheckbox.checked = true
      }
    } else {
      weeklyDays.style.display = 'none'
      // Clear all checkboxes when switching away from weekly
      document.querySelectorAll('#weekly-days input[type="checkbox"]').forEach(cb => {
        cb.checked = false
      })
    }
  })

  // Recurring schedule
  document.getElementById('schedule-recurring').addEventListener('click', () => {
    const recurringType = document.getElementById('recurring-type').value
    const recurringTime = document.getElementById('recurring-time').value

    // Get selected days for weekly recurring
    let selectedDays = []
    if (recurringType === 'weekly') {
      const dayCheckboxes = document.querySelectorAll('#weekly-days input[type="checkbox"]:checked')
      selectedDays = Array.from(dayCheckboxes).map(cb => parseInt(cb.value))

      if (selectedDays.length === 0) {
        alert('Please select at least one day of the week')
        return
      }
    }

    chrome.runtime.sendMessage({
      action: 'snoozeTab',
      type: 'recurring',
      recurringType: recurringType,
      recurringTime: recurringTime,
      selectedDays: selectedDays,
    })

    window.close()
  })

  // Set minimum date to now
  const now = new Date()
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset())
  document.getElementById('custom-date').min = now.toISOString().slice(0, 16)

  // Set default custom date to 1 hour from now
  const defaultDate = new Date(Date.now() + 60 * 60 * 1000)
  defaultDate.setMinutes(defaultDate.getMinutes() - defaultDate.getTimezoneOffset())
  document.getElementById('custom-date').value = defaultDate.toISOString().slice(0, 16)

  // Handle keyboard shortcuts display based on OS
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
  if (!isMac) {
    document.querySelectorAll('.shortcut').forEach(el => {
      el.textContent = el.textContent.replace('⇧⌥', 'Ctrl+Shift+')
    })
  }

  // Load history initially if history tab is active
  if (document.querySelector('.tab[data-tab="history"]').classList.contains('active')) {
    loadSnoozeHistory()
  }

  // Set up periodic updates for history tab
  setInterval(() => {
    const historyTab = document.getElementById('history-tab')
    if (historyTab && historyTab.classList.contains('active')) {
      loadSnoozeHistory()
    }
  }, 10000) // Update every 10 seconds

  // Export/Import event listeners
  document.getElementById('export-history').addEventListener('click', exportHistory)
  document.getElementById('import-history').addEventListener('click', () => {
    document.getElementById('import-file').click()
  })
  document.getElementById('import-file').addEventListener('change', importHistory)
})

// Load snooze history
function loadSnoozeHistory() {
  chrome.storage.local.get(null, result => {
    const snoozeItems = Object.keys(result)
      .filter(key => key.startsWith('snooze-'))
      .map(key => ({ key, ...result[key] }))
      .sort((a, b) => a.scheduledFor - b.scheduledFor)

    const historyList = document.getElementById('history-list')
    const emptyState = document.getElementById('empty-state')

    if (snoozeItems.length === 0) {
      historyList.innerHTML = ''
      emptyState.style.display = 'block'
    } else {
      emptyState.style.display = 'none'
      historyList.innerHTML = snoozeItems.map(item => createHistoryItem(item)).join('')

      // Add event listeners for history items
      document.querySelectorAll('.history-item-title').forEach(title => {
        title.addEventListener('click', e => {
          const url = e.target.getAttribute('data-url')
          chrome.tabs.create({ url, active: true })
        })
      })

      document.querySelectorAll('.remove-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          const key = e.target.getAttribute('data-key')
          removeSnoozeItem(key)
        })
      })
    }
  })
}

// Create HTML for history item
function createHistoryItem(item) {
  const timeUntil = getTimeUntilReopen(item.scheduledFor)
  const truncatedTitle = item.title.length > 40 ? item.title.substring(0, 40) + '...' : item.title
  const truncatedUrl = item.url.length > 50 ? item.url.substring(0, 50) + '...' : item.url

  return `
    <div class="history-item">
      <div class="history-item-header">
        <div class="history-item-title" data-url="${escapeHtml(item.url)}">${escapeHtml(truncatedTitle)}</div>
        <button class="remove-btn" data-key="${escapeHtml(item.key)}">×</button>
      </div>
      <div class="history-item-url">${escapeHtml(truncatedUrl)}</div>
      <div class="history-item-time">${timeUntil}</div>
      ${
        item.recurring
          ? `<div class="history-item-recurring">Recurring ${escapeHtml(item.recurringType)}${
              item.selectedDays && item.recurringType === 'weekly'
                ? ` (${item.selectedDays
                    .map(day => {
                      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
                      return dayNames[day]
                    })
                    .sort((a, b) => {
                      const order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
                      return order.indexOf(a) - order.indexOf(b)
                    })
                    .join(', ')})`
                : ''
            }</div>`
          : ''
      }
    </div>
  `
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

// Calculate time until reopen
function getTimeUntilReopen(scheduledFor) {
  const now = Date.now()
  const timeDiff = scheduledFor - now

  if (timeDiff <= 0) {
    return 'Opening soon...'
  }

  const minutes = Math.floor(timeDiff / (1000 * 60))
  const hours = Math.floor(timeDiff / (1000 * 60 * 60))
  const days = Math.floor(timeDiff / (1000 * 60 * 60 * 24))

  if (days > 0) {
    return `in ${days} day${days !== 1 ? 's' : ''}`
  } else if (hours > 0) {
    return `in ${hours} hour${hours !== 1 ? 's' : ''}`
  } else if (minutes > 0) {
    return `in ${minutes} minute${minutes !== 1 ? 's' : ''}`
  } else {
    return 'in less than a minute'
  }
}

// Remove snooze item
function removeSnoozeItem(key) {
  chrome.storage.local.remove([key], () => {
    // Also remove the corresponding alarm
    chrome.alarms.clear(key)
    // Reload the history
    loadSnoozeHistory()
  })
}

// Export history to JSON
function exportHistory() {
  chrome.storage.local.get(null, result => {
    const snoozeData = {}
    Object.keys(result)
      .filter(key => key.startsWith('snooze-'))
      .forEach(key => {
        snoozeData[key] = result[key]
      })

    const dataStr = JSON.stringify(snoozeData, null, 2)
    const dataBlob = new Blob([dataStr], { type: 'application/json' })
    const url = URL.createObjectURL(dataBlob)

    const link = document.createElement('a')
    link.href = url
    link.download = `snooze-tabby-history-${new Date().toISOString().split('T')[0]}.json`
    link.click()

    URL.revokeObjectURL(url)
  })
}

// Import history from JSON
function importHistory(event) {
  const file = event.target.files[0]
  if (!file) return

  const reader = new FileReader()
  reader.onload = e => {
    try {
      const importData = JSON.parse(e.target.result)

      // Validate the data structure
      const validKeys = Object.keys(importData).filter(
        key => key.startsWith('snooze-') && importData[key].url && importData[key].title && importData[key].scheduledFor
      )

      if (validKeys.length === 0) {
        alert('Invalid file format. Please select a valid Snooze Tabby export file.')
        return
      }

      // Store the data
      chrome.storage.local.set(importData, () => {
        // Recreate alarms for future snoozes
        validKeys.forEach(key => {
          const item = importData[key]
          if (item.scheduledFor > Date.now()) {
            chrome.alarms.create(key, { when: item.scheduledFor })
          }
        })

        alert(`Successfully imported ${validKeys.length} snooze item(s)`)
        loadSnoozeHistory()
      })
    } catch (error) {
      alert("Error reading file. Please make sure it's a valid JSON file.")
    }
  }

  reader.readAsText(file)
  event.target.value = '' // Reset file input
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'snoozeResult') {
    if (request.success) {
      window.close()
    } else {
      alert('Error: ' + request.error)
    }
  }
})
