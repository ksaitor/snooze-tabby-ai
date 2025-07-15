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

  // Recurring schedule
  document.getElementById('schedule-recurring').addEventListener('click', () => {
    const recurringType = document.getElementById('recurring-type').value
    const recurringTime = document.getElementById('recurring-time').value

    chrome.runtime.sendMessage({
      action: 'snoozeTab',
      type: 'recurring',
      recurringType: recurringType,
      recurringTime: recurringTime,
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
      ${item.recurring ? `<div class="history-item-recurring">Recurring ${escapeHtml(item.recurringType)}</div>` : ''}
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
