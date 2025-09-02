# Migration Guide: Integrate Automerge Repo Sync Server into an Existing Express App

This guide explains how to merge the functionality of this project (Automerge Repo Sync Server + dashboard) into another existing Express server that already has routes, WebSockets, and its own internals.

It is designed to be copy-paste friendly and safe to roll out incrementally.

---

## What you get

- WebSocket-based sync endpoint for Automerge Repo clients (`@automerge/automerge-repo`) using `NodeWSServerAdapter`.
- File-system-backed storage for documents using `NodeFSStorageAdapter`.
- Lightweight ops dashboard and metrics endpoint for visibility.
- CORS headers for HTTP routes (origin: `http://localhost:8000`).

---

## 1) Dependencies to install

Install the following into your target project (versions from this repo):

```bash
npm i --save \
  @automerge/automerge@^3.0.0 \
  @automerge/automerge-repo@^2.1.0 \
  @automerge/automerge-repo-network-websocket@^2.1.0 \
  @automerge/automerge-repo-storage-nodefs@^2.1.0 \
  ws@^8.7.0
```

Notes:
- Your app likely already has `express`. If not: `npm i express@^4.18.1`.
- No build tools are required for the dashboard; it loads React via CDN.

---

## 2) Files to copy (zip these and move into your project)

Copy the dashboard assets into your project so you can serve a small UI:

- `public/dashboard/index.html`
- `public/dashboard/main.js`

Place them under the same path in your project (recommended): `public/dashboard/`.

If your project already has a `public/` folder that is served by Express, reusing that is fine. Otherwise, you can mount a static route to this directory as shown below.

---

## 3) Environment and runtime configuration

- Data directory (document storage):
  - Uses `DATA_DIR`, defaults to `.amrg` in the process CWD if unset.
  - Ensure the process has read/write permissions.
- Port: integrate into your existing HTTP server; no separate port is required.

---

## 4) Code integration (minimal, safe to paste)

Below are drop-in snippets that you can adapt to your existing Express server. They assume you already create an `http.Server` via `app.listen(...)`.

### 4.1 Imports

```js
import fs from 'fs'
import os from 'os'
import { WebSocketServer } from 'ws'
import { Repo } from '@automerge/automerge-repo'
import { NodeWSServerAdapter } from '@automerge/automerge-repo-network-websocket'
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs'
```

### 4.2 Initialize storage dir and hostname

```js
const dataDir = process.env.DATA_DIR ?? '.amrg'
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
const hostname = os.hostname()
```

### 4.3 CORS middleware (HTTP only)

Place this before your existing routes/static.

```js
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'http://localhost:8000')
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
})
```

### 4.4 Serve dashboard assets

If you already serve a `public/` directory, make sure `public/dashboard/` is included. Otherwise:

```js
app.use(express.static('public'))

// Optional convenience redirect
app.get('/dashboard', (req, res) => {
  res.redirect('/dashboard/')
})
```

### 4.5 Automerge Repo + WebSocket wiring

Create a shared `WebSocketServer` that will piggyback on your existing HTTP server’s `upgrade` event. Track open sockets for metrics.

```js
// Create a WS server in noServer mode to hook into Node's HTTP upgrade
const wss = new WebSocketServer({ noServer: true })

const automergeRepo = new Repo({
  network: [new NodeWSServerAdapter(wss)],
  storage: new NodeFSStorageAdapter(dataDir),
  // A deterministic peer ID helps in logs/ops
  /** @type {import('@automerge/automerge-repo').PeerId} */
  peerId: `storage-server-${hostname}`,
  // Server does not share generously — clients must request docs by ID
  sharePolicy: async () => false,
})

// Optionally track active WS clients for metrics
const activeClients = new Set()
wss.on('connection', (socket) => {
  activeClients.add(socket)
  socket.on('close', () => activeClients.delete(socket))
})

// Attach to your existing HTTP server instance
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request)
  })
})
```

### 4.6 Metrics endpoint (JSON)

Add or merge this endpoint into your app. If you already have a metrics route, merge just the fields below.

```js
app.get('/metrics.json', (req, res) => {
  res.json({
    status: 'ok',
    hostname,
    port: server.address().port,
    dataDir,
    activeConnections: activeClients.size,
    documents: listDocuments(dataDir),
  })
})
```

Helper to scan the storage directory and summarize docs (rebuilds full IDs for sharded directories):

```js
import fs from 'fs'

function subtreeStats(dirPath) {
  let total = 0
  let latest = 0
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const item of items) {
      const fp = `${dirPath}/${item.name}`
      if (item.isDirectory()) {
        const { size, mtime } = subtreeStats(fp)
        total += size
        if (mtime > latest) latest = mtime
      } else {
        try {
          const st = fs.statSync(fp)
          total += st.size
          if (st.mtimeMs > latest) latest = st.mtimeMs
        } catch {}
      }
    }
    try {
      const stDir = fs.statSync(dirPath)
      if (stDir.mtimeMs > latest) latest = stDir.mtimeMs
    } catch {}
  } catch {}
  return { size: total, mtime: latest }
}

function listDocuments(rootDir) {
  const out = []
  const walk = (dir, segments) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    const subdirs = entries.filter((e) => e.isDirectory())
    const files = entries.filter((e) => e.isFile())

    if (files.length > 0 || subdirs.length === 0) {
      const id = segments.join('') || dir.replace(rootDir + '/', '')
      const { size, mtime } = subtreeStats(dir)
      out.push({ id, type: 'dir', sizeBytes: size, mtimeMs: mtime, mtimeISO: new Date(mtime).toISOString() })
      return
    }

    for (const d of subdirs) walk(`${dir}/${d.name}`, [...segments, d.name])
  }

  let top
  try { top = fs.readdirSync(rootDir, { withFileTypes: true }) } catch { top = [] }
  for (const e of top) {
    const p = `${rootDir}/${e.name}`
    if (e.isDirectory()) walk(p, [e.name])
    else if (e.isFile()) {
      try {
        const stat = fs.statSync(p)
        out.push({ id: e.name, type: 'file', sizeBytes: stat.size, mtimeMs: stat.mtimeMs, mtimeISO: new Date(stat.mtimeMs).toISOString() })
      } catch {}
    }
  }
  return out
}
```

### 4.7 Optional: readiness helpers

If you want lifecycle hooks similar to this repo’s `Server` class, add small helpers to expose readiness and a graceful `close()`.

---

## 5) Security and operations

- **CORS**: Currently allows `http://localhost:8000`. Adjust for production origins.
- **WebSocket origin checks**: For stricter control, validate `request.headers.origin` in `server.on('upgrade', ...)` and reject unwanted origins.
- **DATA_DIR**: Ensure the directory is on a persistent volume and backed up as needed.
- **Resource usage**: The dashboard shows doc size and last modified; integrate your own metrics system if required.

---

## 6) Testing checklist

- **Install deps**: see Section 1.
- **Start your app** and ensure no port conflicts.
- **Open dashboard**: `http://<host>:<port>/dashboard/` loads and lists documents (empty on first run).
- **Check metrics**: `GET /metrics.json` returns JSON with `status: "ok"` and expected fields.
- **Create/edit docs** with an Automerge client pointing to your server’s WS endpoint. Observe `activeConnections` and `documents` change.

---

## 7) Rollback plan

- Changes are additive and isolated:
  - Removing the WS upgrade handler and metrics/dashboard routes reverts the integration.
  - Deleting the `public/dashboard/` assets hides the dashboard.
  - Removing the CORS middleware reverts HTTP CORS behavior.

---

## 8) What to zip and how to apply

Ask your automation/LLM to:

1. Unpack the provided zip into the target project root, preserving paths.
2. Ensure `public/dashboard/` contains `index.html` and `main.js`.
3. Install dependencies (Section 1).
4. Apply the code changes in Section 4 to your existing Express server file where your `app` and `server` are created.
5. Restart the server and verify Section 6.

If you prefer a single module, you can also create `automerge-sync-integration.js` in your project containing the code from Sections 4.2–4.6 and import it from your main server file.
