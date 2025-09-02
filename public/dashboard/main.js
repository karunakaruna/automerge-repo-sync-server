// React dashboard that polls /metrics.json and displays document metadata
const { useEffect, useState, useMemo } = window.React
const rootEl = document.getElementById('root')

function useMetrics(intervalMs = 3000) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [authRequired, setAuthRequired] = useState(false)

  const load = async () => {
    try {
      setError(null)
      const res = await fetch('/metrics.json', { cache: 'no-store', credentials: 'same-origin' })
      if (res.status === 401) {
        setAuthRequired(true)
        setData(null)
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setData(json)
      setAuthRequired(false)
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const timer = setInterval(load, intervalMs)
    load()
    return () => clearInterval(timer)
  }, [intervalMs])

  return { data, error, loading, reload: load, authRequired, setAuthRequired }
}

const fmt = {
  bytes(n) {
    if (!Number.isFinite(n)) return '—'
    const units = ['B','KB','MB','GB','TB']
    let i = 0
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
  },
  dateISO(ms) {
    if (!Number.isFinite(ms)) return '—'
    try { return new Date(ms).toLocaleString() } catch { return '—' }
  }
}

function Stat({ label, children }) {
  return (
    window.React.createElement('div', { className: 'card stat' },
      window.React.createElement('div', { className: 'label' }, label),
      window.React.createElement('div', { className: 'value' }, children),
    )
  )
}

function DocsTable({ docs }) {
  if (!docs || docs.length === 0) return window.React.createElement('p', { className: 'muted' }, 'No documents found.')
  const rows = docs.slice().sort((a,b)=> b.mtimeMs - a.mtimeMs)
  return (
    window.React.createElement('div', { className: 'table-wrap' },
      window.React.createElement('table', { className: 'table' },
        window.React.createElement('thead', null,
          window.React.createElement('tr', null,
            window.React.createElement('th', null, 'Document ID'),
            window.React.createElement('th', null, 'Size'),
            window.React.createElement('th', null, 'Last Modified'),
          ),
        ),
        window.React.createElement('tbody', null,
          rows.map(doc => (
            window.React.createElement('tr', { key: doc.id },
              window.React.createElement('td', null,
                window.React.createElement('div', { className: 'id-wrap' },
                  window.React.createElement('code', { className: 'id' }, doc.id),
                  window.React.createElement('button', {
                    className: 'copy-btn',
                    title: 'Copy ID',
                    onClick: async (e) => {
                      try { await navigator.clipboard.writeText(doc.id) } catch {}
                    }
                  }, 'Copy')
                )
              ),
              window.React.createElement('td', null, fmt.bytes(doc.sizeBytes)),
              window.React.createElement('td', null, fmt.dateISO(doc.mtimeMs)),
            )
          ))
        )
      )
    )
  )
}

function App() {
  const { data, error, loading, reload, authRequired, setAuthRequired } = useMetrics(3000)
  const [password, setPassword] = useState("")
  const [authError, setAuthError] = useState("")

  const login = async (e) => {
    e?.preventDefault?.()
    setAuthError("")
    try {
      const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password })
      })
      if (!res.ok) {
        setAuthError('Invalid password')
        return
      }
      setPassword("")
      setAuthRequired(false)
      await reload()
    } catch (err) {
      setAuthError('Login failed')
    }
  }

  const logout = async () => {
    try { await fetch('/logout', { method: 'POST', credentials: 'same-origin' }) } catch {}
    await reload()
  }

  if (authRequired) {
    return (
      window.React.createElement('div', { className: 'login-wrap' },
        window.React.createElement('h1', null, 'Sync Server Login'),
        window.React.createElement('form', { onSubmit: login, className: 'login-form' },
          window.React.createElement('label', null, 'Password'),
          window.React.createElement('input', {
            type: 'password',
            value: password,
            onChange: (e) => setPassword(e.target.value),
            placeholder: 'Enter password',
            autoFocus: true
          }),
          window.React.createElement('button', { type: 'submit', disabled: !password }, 'Login'),
        ),
        authError ? window.React.createElement('p', { className: 'error' }, authError) : null,
      )
    )
  }
  const docs = data?.documents
  return (
    window.React.createElement(window.React.Fragment, null,
      window.React.createElement('header', null,
        window.React.createElement('h1', null, 'Sync Server Dashboard'),
        window.React.createElement('span', { className: 'muted' }, data?.hostname ? `host: ${data.hostname}` : '—'),
      ),
      window.React.createElement('div', { className: 'row' },
        window.React.createElement(Stat, { label: 'Status' }, loading ? 'loading…' : (error ? `error: ${error}` : 'ok')),
        window.React.createElement(Stat, { label: 'Active connections' }, data?.activeConnections ?? '—'),
        window.React.createElement(Stat, { label: 'Port' }, data?.port ?? '—'),
        window.React.createElement(Stat, { label: 'Data dir' }, data?.dataDir ? window.React.createElement('code', null, data.dataDir) : '—'),
      ),
      window.React.createElement('div', { className: 'toolbar' },
        window.React.createElement('button', { onClick: () => reload(), disabled: loading, title: 'Refresh now' }, 'Refresh'),
        ' ',
        window.React.createElement('a', { href: '/metrics.json', target: '_blank', rel: 'noreferrer' }, 'metrics.json'),
        ' · ',
        window.React.createElement('a', { href: '/', target: '_blank', rel: 'noreferrer' }, 'home'),
        ' · ',
        window.React.createElement('button', { onClick: () => logout(), title: 'Logout' }, 'Logout'),
      ),
      window.React.createElement('section', { className: 'docs' },
        window.React.createElement('h2', null, 'Documents'),
        window.React.createElement(DocsTable, { docs })
      )
    )
  )
}

window.ReactDOM.createRoot(rootEl).render(window.React.createElement(App))
