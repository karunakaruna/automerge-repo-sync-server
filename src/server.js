// @ts-check
import fs from "fs"
import express from "express"
import { WebSocketServer } from "ws"
import { Repo } from "@automerge/automerge-repo"
import { NodeWSServerAdapter } from "@automerge/automerge-repo-network-websocket"
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs"
import os from "os"
import crypto from "crypto"

export class Server {
  /** @type WebSocketServer */
  #socket

  /** @type ReturnType<import("express").Express["listen"]> */
  #server

  /** @type {((value: any) => void)[]} */
  #readyResolvers = []

  #isReady = false

  /** @type Repo */
  #repo

  /** @type {Set<import('ws').WebSocket>} */
  #clients = new Set()

  /** @type {string} */
  #dataDir

  /** @type {string} */
  #hostname

  constructor() {
    const dir = process.env.DATA_DIR !== undefined ? process.env.DATA_DIR : ".amrg"
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir)
    }
    this.#dataDir = dir

    var hostname = os.hostname()
    this.#hostname = hostname

    this.#socket = new WebSocketServer({ noServer: true })

    // Global resilience: don't crash on transient network timeouts or promise rejections
    const errMsg = (e) => {
      try {
        if (e && typeof e === "object" && "message" in e) return String(e.message)
        return String(e)
      } catch {
        return "(unknown error)"
      }
    }
    try {
      process.on("unhandledRejection", (err) => {
        const msg = errMsg(err)
        if (msg.includes("withTimeout")) {
          console.warn("[warn] Ignoring network timeout:", msg)
        } else {
          console.error("[unhandledRejection]", err)
        }
      })
      process.on("uncaughtException", (err) => {
        const msg = errMsg(err)
        if (msg.includes("withTimeout")) {
          console.warn("[warn] Ignoring network timeout (uncaught):", msg)
        } else {
          console.error("[uncaughtException]", err)
        }
      })
    } catch {}

    const PORT =
      process.env.PORT !== undefined ? parseInt(process.env.PORT) : 3030
    const AUTH_TOKEN = process.env.AUTH_TOKEN ?? ""
    const DOC_TOKEN_TTL_SECONDS = process.env.DOC_TOKEN_TTL_SECONDS
      ? Number(process.env.DOC_TOKEN_TTL_SECONDS)
      : 24 * 60 * 60
    const ACL_PATH = `${this.#dataDir}/.acl.json`
    const LABELS_PATH = `${this.#dataDir}/.labels.json`
    const OWNERS_PATH = `${this.#dataDir}/.owners.json`
    const LOCKS_PATH = `${this.#dataDir}/.locks.json`
    const USERS_PATH = `${this.#dataDir}/.users.json`
    const COOKIE_NAME = "amrg_auth"
    const USER_COOKIE_NAME = "amrg_user"
    const app = express()
    // CORS for HTTP routes (allow Vite dev and preview origins)
    app.use((req, res, next) => {
      const origin = req.headers.origin
      const allowlist = new Set([
        "http://localhost:5173", // Vite dev (viewer / quickstart default)
        "http://localhost:5174", // alternate dev port (quickstart when 5173 taken)
        "http://localhost:8000", // alternate dev/preview
      ])
      if (origin && allowlist.has(origin)) {
        res.header("Access-Control-Allow-Origin", origin)
        res.header("Vary", "Origin")
        res.header("Access-Control-Allow-Credentials", "true")
      }
      res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
      res.header(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization"
      )
      if (req.method === "OPTIONS") {
        res.status(204).end()
        return
      }
      next()
    })
    // Body parsers for login API
    app.use(express.json())
    app.use(express.urlencoded({ extended: true }))

    // Cookie parsing
    const parseCookies = (cookieHeader = "") => {
      /** @type {Record<string,string>} */
      const out = {}
      cookieHeader.split(";").forEach((p) => {
        const i = p.indexOf("=")
        if (i > -1) {
          const k = p.slice(0, i).trim()
          const v = p.slice(i + 1).trim()
          out[k] = decodeURIComponent(v)
        }
      })
      return out
    }

    // Simple auth helper for HTTP endpoints (cookie-based)
    /** @param {import('express').Request} req @param {import('express').Response} res @param {import('express').NextFunction} next */
    const requireAuth = (req, res, next) => {
      if (!AUTH_TOKEN) return next()
      const cookies = parseCookies(req.headers.cookie || "")
      const token = cookies[COOKIE_NAME] || ""
      if (token === AUTH_TOKEN) return next()
      res.status(401).send("Unauthorized")
    }

    // --- ACL helpers (per-document write protection) ---
    /**
     * @returns {Record<string, { hash: string }>} docId -> { hash }
     */
    const loadACL = () => {
      try {
        const raw = fs.readFileSync(ACL_PATH, "utf8")
        const json = JSON.parse(raw)
        if (json && typeof json === "object") return json
      } catch {}
      return {}
    }
    /** @param {Record<string, { hash: string }>} acl */
    const saveACL = (acl) => {
      try {
        fs.writeFileSync(ACL_PATH, JSON.stringify(acl, null, 2))
      } catch {}
    }
    // --- Simple per-document labels for dashboard readability ---
    /** @returns {Record<string, { label: string }>} docId -> { label } */
    const loadLabels = () => {
      try {
        const raw = fs.readFileSync(LABELS_PATH, "utf8")
        const json = JSON.parse(raw)
        if (json && typeof json === "object") return json
      } catch {}
      return {}
    }
    /** @param {Record<string, { label: string }>} labels */
    const saveLabels = (labels) => {
      try {
        fs.writeFileSync(LABELS_PATH, JSON.stringify(labels, null, 2))
      } catch {}
    }

    /** @returns {Record<string, { ownerId: string }>} docId -> { ownerId } */
    const loadOwners = () => {
      try {
        const raw = fs.readFileSync(OWNERS_PATH, "utf8")
        const json = JSON.parse(raw)
        if (json && typeof json === "object") return json
      } catch {}
      return {}
    }
    /** @param {Record<string, { ownerId: string }>} owners */
    const saveOwners = (owners) => {
      try {
        fs.writeFileSync(OWNERS_PATH, JSON.stringify(owners, null, 2))
      } catch {}
    }

    /** @returns {Record<string, { locked: boolean }>} docId -> { locked } */
    const loadLocks = () => {
      try {
        const raw = fs.readFileSync(LOCKS_PATH, "utf8")
        const json = JSON.parse(raw)
        if (json && typeof json === "object") return json
      } catch {}
      return {}
    }
    /** @param {Record<string, { locked: boolean }>} locks */
    const saveLocks = (locks) => {
      try {
        fs.writeFileSync(LOCKS_PATH, JSON.stringify(locks, null, 2))
      } catch {}
    }

    /** @returns {Record<string, { userId: string }>} keyHash -> { userId } */
    const loadUsers = () => {
      try {
        const raw = fs.readFileSync(USERS_PATH, "utf8")
        const json = JSON.parse(raw)
        if (json && typeof json === "object") return json
      } catch {}
      return {}
    }
    /** @param {Record<string, { userId: string }>} users */
    const saveUsers = (users) => {
      try {
        fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2))
      } catch {}
    }

    const genShortUserId = () => {
      const part = () => Math.random().toString(36).slice(2, 8)
      return `${part()}-${part()}`
    }

    /** @param {string} userKey */
    const hashUserKey = (userKey) => {
      // Do not store raw private keys on disk.
      return crypto.createHash("sha256").update(String(userKey)).digest("hex")
    }

    /** @param {import('express').Request} req */
    const getUserIdFromReq = (req) => {
      try {
        const cookies = parseCookies(req.headers.cookie || "")
        const v = cookies[USER_COOKIE_NAME]
        return v ? String(v) : ""
      } catch {
        return ""
      }
    }

    /** @param {string} msg */
    const hmac = (msg) =>
      crypto.createHmac("sha256", AUTH_TOKEN || "amrg_secret").update(msg).digest("hex")
    /** Hash a password for storage (HMAC; for stronger security, replace with scrypt/bcrypt)
     * @param {string} pwd
     */
    const hashPassword = (pwd) => hmac(`pwd:${pwd}`)
    /** Verify provided password against stored hash
     * @param {string} pwd
     * @param {string} hash
     */
    const verifyPassword = (pwd, hash) => hashPassword(pwd) === hash
    /** Sign a short payload for doc cookies
     * @param {any} payload
     */
    const signToken = (payload) => {
      const data = Buffer.from(JSON.stringify(payload)).toString("base64url")
      const sig = hmac(data)
      return `${data}.${sig}`
    }
    /** @param {string} token */
    const verifyToken = (token) => {
      try {
        const [data, sig] = String(token).split(".")
        if (!data || !sig) return null
        if (hmac(data) !== sig) return null
        const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"))
        if (payload.exp && Date.now() > payload.exp) return null
        return payload
      } catch {
        return null
      }
    }

    // Login/Logout endpoints
    app.post("/login", (req, res) => {
      const pwd = String(req.body?.password ?? req.body?.token ?? "")
      if (!AUTH_TOKEN || pwd === AUTH_TOKEN) {
        const attrs = [
          `${COOKIE_NAME}=${encodeURIComponent(AUTH_TOKEN)}`,
          "HttpOnly",
          "Path=/",
          "SameSite=Lax",
        ]
        // Only set Secure on HTTPS
        if ((req.headers["x-forwarded-proto"] || req.protocol) === "https") {
          attrs.push("Secure")
        }
        res.setHeader("Set-Cookie", attrs.join("; "))
        res.json({ ok: true })
        return
      }
      res.status(401).json({ ok: false, error: "invalid_password" })
    })

    app.post("/logout", (req, res) => {
      res.setHeader(
        "Set-Cookie",
        `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
      )
      res.json({ ok: true })
    })

    // Identity: embody via long private userKey -> stable short userId cookie.
    // Legacy: if { userId } is provided without { userKey }, treat it as the cookie value.
    app.post("/users/embody", (req, res) => {
      const userKey = String(req.body?.userKey ?? req.body?.key ?? "").trim()
      const legacyUserId = String(req.body?.userId ?? "").trim()

      /** @type {string} */
      let userId = ""

      if (userKey) {
        const keyHash = hashUserKey(userKey)
        const users = loadUsers()
        const existing = users[keyHash]?.userId
        userId = existing ? String(existing) : genShortUserId()
        users[keyHash] = { userId }
        try {
          fs.mkdirSync(this.#dataDir, { recursive: true })
        } catch {}
        saveUsers(users)
      } else if (legacyUserId) {
        userId = legacyUserId
      } else {
        return res.status(400).json({ ok: false, error: "missing_userKey" })
      }

      const attrs = [
        `${USER_COOKIE_NAME}=${encodeURIComponent(userId)}`,
        "Path=/",
        "SameSite=Lax",
      ]
      if ((req.headers["x-forwarded-proto"] || req.protocol) === "https") {
        attrs.push("Secure")
      }
      res.setHeader("Set-Cookie", attrs.join("; "))
      res.json({ ok: true, userId })
    })

    app.get("/users/me", (req, res) => {
      const userId = getUserIdFromReq(req)
      res.json({ ok: true, userId: userId || null })
    })

    app.get("/users/me/docs", (req, res) => {
      const userId = getUserIdFromReq(req)
      if (!userId) return res.json({ ok: true, userId: null, docs: [] })
      const owners = loadOwners()
      const docs = Object.entries(owners)
        .filter(([, v]) => v && v.ownerId === userId)
        .map(([docId]) => docId)
      res.json({ ok: true, userId, docs })
    })

    // Public: return current ownership map (docId -> ownerId)
    app.get("/meta/owners", (req, res) => {
      const owners = loadOwners()
      /** @type {Record<string, string>} */
      const out = {}
      for (const [docId, v] of Object.entries(owners)) {
        if (v && typeof v.ownerId === "string" && v.ownerId) out[docId] = v.ownerId
      }
      res.json({ ok: true, owners: out })
    })

    // Per-document: set/replace protection password (admin-only)
    app.post("/docs/:docId/protect", requireAuth, (req, res) => {
      const docId = String(req.params.docId)
      const pwd = String(req.body?.password ?? "")
      if (!docId) return res.status(400).json({ ok: false, error: "missing_docId" })
      if (!pwd) return res.status(400).json({ ok: false, error: "missing_password" })
      const acl = loadACL()
      acl[docId] = { hash: hashPassword(pwd) }
      try { fs.mkdirSync(this.#dataDir, { recursive: true }) } catch {}
      try { fs.writeFileSync(`${this.#dataDir}/.acl.json`, JSON.stringify(acl, null, 2)) } catch {}
      res.json({ ok: true })
    })

    // Per-document: contributor login to obtain a doc-scoped cookie
    app.post("/docs/:docId/login", (req, res) => {
      const docId = String(req.params.docId)
      const pwd = String(req.body?.password ?? req.body?.token ?? "")
      if (!docId) return res.status(400).json({ ok: false, error: "missing_docId" })
      const acl = loadACL()
      const entry = acl[docId]
      if (!entry) return res.status(404).json({ ok: false, error: "not_protected" })
      if (!verifyPassword(pwd, entry.hash)) {
        return res.status(401).json({ ok: false, error: "invalid_password" })
      }
      const exp = Date.now() + DOC_TOKEN_TTL_SECONDS * 1000
      const token = signToken({ d: docId, exp })
      const cookieName = `amrg_doc_${docId}`
      const attrs = [
        `${cookieName}=${encodeURIComponent(token)}`,
        "HttpOnly",
        "Path=/",
        "SameSite=Lax",
        `Max-Age=${DOC_TOKEN_TTL_SECONDS}`,
      ]
      if (req.headers["x-forwarded-proto"] === "https" || req.protocol === "https") {
        attrs.push("Secure")
      }
      res.setHeader("Set-Cookie", attrs.join("; "))
      res.json({ ok: true, exp })
    })

    // Clear per-doc cookie to remove write permissions for this browser
    app.post("/docs/:docId/logout", (req, res) => {
      const docId = String(req.params.docId)
      const cookieName = `amrg_doc_${docId}`
      res.setHeader(
        "Set-Cookie",
        `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
      )
      res.json({ ok: true })
    })

    // Public status endpoint: tells if a document is protected and if caller has write cookie
    app.get("/docs/:docId/status", (req, res) => {
      const docId = String(req.params.docId)
      const acl = loadACL()
      const isProtected = Boolean(acl[docId])
      const cookies = parseCookies(req.headers.cookie || "")
      const tok = cookies[`amrg_doc_${docId}`]
      const payload = tok ? verifyToken(tok) : null
      const canWrite = Boolean(payload && payload.d === docId)
      const owners = loadOwners()
      const ownerId = owners[docId]?.ownerId || null
      const userId = getUserIdFromReq(req) || null
      const locks = loadLocks()
      const locked = locks[docId] ? Boolean(locks[docId].locked) : false
      res.json({ ok: true, protected: isProtected, canWrite, ownerId, userId, locked })
    })

    // Owner-only: toggle comment lock (CanvasDoc.locked)
    app.post("/docs/:docId/lock", async (req, res) => {
      try {
        const docId = String(req.params.docId)
        const userId = getUserIdFromReq(req)
        if (!userId) return res.status(401).json({ ok: false, error: "not_embodied" })

        const owners = loadOwners()
        const ownerId = owners[docId]?.ownerId || ""
        if (!ownerId || ownerId !== userId) {
          return res.status(403).json({ ok: false, error: "not_owner", ownerId: ownerId || null })
        }

        const locked = Boolean(req.body?.locked)
        const locks = loadLocks()
        locks[docId] = { locked }
        try { fs.mkdirSync(this.#dataDir, { recursive: true }) } catch {}
        saveLocks(locks)
        res.json({ ok: true, docId, locked })
      } catch (e) {
        res.status(500).json({ ok: false, error: "lock_failed" })
      }
    })

    // Public: batch flags for many docs (for canvas list UI)
    app.post("/meta/docs/flags", async (req, res) => {
      try {
        const docIds = Array.isArray(req.body?.docIds)
          ? req.body.docIds.map((/** @type {any} */ d) => String(d))
          : []
        const owners = loadOwners()
        const acl = loadACL()
        const locks = loadLocks()
        /** @type {Record<string, { ownerId: string | null, protected: boolean, locked: boolean | null }>} */
        const out = {}
        for (const docId of docIds) {
          const locked = locks[docId] ? Boolean(locks[docId].locked) : false
          out[docId] = {
            ownerId: owners[docId]?.ownerId || null,
            protected: Boolean(acl[docId]),
            locked,
          }
        }
        res.json({ ok: true, flags: out })
      } catch {
        res.status(500).json({ ok: false, error: "flags_failed" })
      }
    })

    // Claim/unclaim ownership for a doc (requires a userId cookie)
    app.post("/docs/:docId/claim", (req, res) => {
      const docId = String(req.params.docId)
      const userId = getUserIdFromReq(req)
      if (!userId) return res.status(401).json({ ok: false, error: "not_embodied" })
      const owners = loadOwners()
      const existing = owners[docId]?.ownerId || ""
      if (existing && existing !== userId) {
        return res.status(409).json({ ok: false, error: "already_claimed", ownerId: existing })
      }
      owners[docId] = { ownerId: userId }
      try { fs.mkdirSync(this.#dataDir, { recursive: true }) } catch {}
      saveOwners(owners)
      res.json({ ok: true, docId, ownerId: userId })
    })

    app.post("/docs/:docId/unclaim", (req, res) => {
      const docId = String(req.params.docId)
      const userId = getUserIdFromReq(req)
      if (!userId) return res.status(401).json({ ok: false, error: "not_embodied" })
      const owners = loadOwners()
      const existing = owners[docId]?.ownerId || ""
      if (!existing) return res.json({ ok: true, docId, ownerId: null })
      if (existing !== userId) {
        return res.status(403).json({ ok: false, error: "not_owner", ownerId: existing })
      }
      delete owners[docId]
      saveOwners(owners)
      res.json({ ok: true, docId, ownerId: null })
    })

    // Per-document: set or clear a human-readable label (admin-only)
    app.post("/docs/:docId/label", requireAuth, (req, res) => {
      const docId = String(req.params.docId)
      if (!docId) return res.status(400).json({ ok: false, error: "missing_docId" })
      const label = typeof req.body?.label === "string" ? req.body.label.trim() : ""
      const labels = loadLabels()
      if (label) {
        labels[docId] = { label }
      } else {
        delete labels[docId]
      }
      saveLabels(labels)
      res.json({ ok: true })
    })

    // Serve static files (dashboard must be accessible to show login form)
    app.use(express.static("public"))

    const config = {
      network: [new NodeWSServerAdapter(this.#socket)],
      storage: new NodeFSStorageAdapter(dir),
      /** @ts-ignore @type {(import("@automerge/automerge-repo").PeerId)}  */
      peerId: `storage-server-${hostname}`,
      // Since this is a server, we don't share generously — meaning we only sync documents they already
      // know about and can ask for by ID.
      sharePolicy: async () => false,
    }
    this.#repo = new Repo(config)

    app.get("/", (req, res) => {
      res.send(`👍 @automerge/automerge-repo-sync-server is running`)
    })

    // Lightweight metrics API (protected)
    app.get("/metrics.json", requireAuth, (req, res) => {
      const acl = loadACL()
      const labels = loadLabels()
      const addr = this.#server?.address?.() ?? null
      const port = addr && typeof addr !== "string" ? addr.port : null
      res.json({
        status: "ok",
        hostname: this.#hostname,
        port,
        dataDir: this.#dataDir,
        activeConnections: this.#clients.size,
        documents: this.#listDocuments().map((d) => ({
          ...d,
          protected: Boolean(acl[d.id]),
          label: labels[d.id]?.label || "",
        })),
      })
    })

    // Fetch document contents (for canvas navigator)
    app.get("/docs/:docId", async (req, res) => {
      try {
        const docId = String(req.params.docId)
        const url = docId.startsWith("automerge:") ? docId : `automerge:${docId}`
        const handle = await this.#repo.find(url)
        await handle.whenReady()
        const doc = await handle.doc()
        if (!doc) {
          res.status(404).json({ error: "Document not found" })
          return
        }
        res.json(doc)
      } catch (e) {
        console.error("Failed to fetch document", e)
        res.status(500).json({ error: "Failed to fetch document" })
      }
    })

    // Redirect to the static React dashboard app under public/dashboard/
    app.get("/dashboard", (req, res) => {
      res.redirect("/dashboard/")
    })

    this.#server = app.listen(PORT, () => {
      console.log(`Listening on port ${PORT}`)
      this.#isReady = true
      this.#readyResolvers.forEach((resolve) => resolve(true))
    })

    this.#server.on("upgrade", (request, socket, head) => {
      // Cookie-based auth for WebSocket upgrade
      try {
        const cookies = parseCookies(request.headers["cookie"] || "")
        const token = cookies[COOKIE_NAME] || ""
        if (AUTH_TOKEN && token !== AUTH_TOKEN) {
          socket.write(
            "HTTP/1.1 401 Unauthorized\r\n" +
              "Connection: close\r\n" +
              "Content-Type: text/plain\r\n\r\nUnauthorized"
          )
          socket.destroy()
          return
        }
      } catch {
        try {
          socket.write(
            "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"
          )
        } catch {}
        socket.destroy()
        return
      }

      this.#socket.handleUpgrade(request, socket, head, (socket) => {
        // Stash parsed cookies for later per-document checks
        try {
          // @ts-ignore
          socket.__cookies = parseCookies(request.headers["cookie"] || "")
        } catch {}
        this.#socket.emit("connection", socket, request)
      })
    })

    // Track active WS connections
    this.#socket.on("connection", (socket) => {
      this.#clients.add(socket)

      // Conservative per-doc gate: if a message payload contains a protected docId
      // and the socket lacks a valid doc cookie, close with policy violation.
      // Note: This is a heuristic string scan suitable for current adapters.
      socket.on("message", (data) => {
        try {
          const acl = loadACL()
          const protectedIds = Object.keys(acl)
          if (protectedIds.length === 0) return
          let buf
          if (typeof data === "string") {
            buf = Buffer.from(data)
          } else if (Buffer.isBuffer(data)) {
            buf = data
          } else if (data instanceof ArrayBuffer) {
            buf = Buffer.from(new Uint8Array(data))
          } else if (Array.isArray(data)) {
            // Array of Buffer (from ws in some cases)
            const parts = data.map((b) => (Buffer.isBuffer(b) ? b : Buffer.from(b)))
            const u8s = parts.map((b) => new Uint8Array(b))
            buf = Buffer.concat(u8s)
          } else {
            // Fallback
            buf = Buffer.from(String(data ?? ""))
          }
          // @ts-ignore
          const cookies = socket.__cookies || {}
          for (const docId of protectedIds) {
            // Cheap substring scan for docId within frame
            if (buf.includes(Buffer.from(docId))) {
              const cookieName = `amrg_doc_${docId}`
              const tok = cookies[cookieName]
              const payload = tok ? verifyToken(tok) : null
              if (!payload || payload.d !== docId) {
                try { socket.close(1008, "Write to protected document not authorized") } catch {}
                // Ensure the connection is torn down promptly to avoid dangling waits in the adapter
                try { setTimeout(() => { try { socket.terminate() } catch {} }, 200) } catch {}
                return
              }
            }
          }
        } catch {}
      })

      socket.on("close", () => this.#clients.delete(socket))
    })
  }

  async ready() {
    if (this.#isReady) {
      return true
    }

    return new Promise((resolve) => {
      this.#readyResolvers.push(resolve)
    })
  }

  close() {
    this.#socket.close()
    this.#server.close()
  }

  /**
   * Gather document metadata by scanning the storage directory.
   * Tries to infer document IDs from top-level entry names.
   * @returns {{ id: string, type: 'dir'|'file', sizeBytes: number, mtimeMs: number, mtimeISO: string }[]}
   */
  #listDocuments() {
    try {
      /**
       * We'll collapse adapter artifacts like `<docId>snapshot` and `<docId>sync-state`
        * into a single logical `docId` row. We also hide the ACL file.
       */
      /** @type {Record<string, { id: string, type: 'dir'|'file', sizeBytes: number, mtimeMs: number }>} */
      const byId = {}

      /**
       * Recursively walk the storage dir. Many adapters shard IDs across
       * multiple 2-char directory segments. We reconstruct the full ID by
       * joining all path segments from the root to a leaf directory that
       * contains files (or has no subdirectories).
       * @param {string} dir
       * @param {string[]} segments
       */
      const walk = (dir, segments) => {
        let entries
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }
        const subdirs = entries.filter((e) => e.isDirectory())
        const files = entries.filter((e) => e.isFile())

        // If this level has files or no subdirs, consider this a leaf representing a doc bucket
        if (files.length > 0 || subdirs.length === 0) {
          const id = segments.join("") || dir.replace(this.#dataDir + "/", "")
          const { size, mtime } = this.#subtreeStats(dir)
          const prev = byId[id]
          const sizeBytes = Math.max(prev?.sizeBytes || 0, size)
          const mtimeMs = Math.max(prev?.mtimeMs || 0, mtime)
          byId[id] = { id, type: "dir", sizeBytes, mtimeMs }
          return
        }

        // Otherwise, continue descending
        for (const d of subdirs) {
          walk(`${dir}/${d.name}`, [...segments, d.name])
        }
      }

      // Kick off from top-level dirs; if there are files at top-level, include them individually
      let top
      try {
        top = fs.readdirSync(this.#dataDir, { withFileTypes: true })
      } catch {
        top = []
      }
      for (const e of top) {
        const p = `${this.#dataDir}/${e.name}`
        if (e.isDirectory()) {
          walk(p, [e.name])
        } else if (e.isFile()) {
          try {
            const stat = fs.statSync(p)
            if (e.name === ".acl.json") continue
            // Collapse known suffixes
            let baseId = e.name
            if (baseId.endsWith("snapshot")) baseId = baseId.slice(0, -"snapshot".length)
            if (baseId.endsWith("sync-state")) baseId = baseId.slice(0, -"sync-state".length)
            const prev = byId[baseId]
            const sizeBytes = (prev?.sizeBytes || 0) + stat.size
            const mtimeMs = Math.max(prev?.mtimeMs || 0, stat.mtimeMs)
            byId[baseId] = { id: baseId, type: "file", sizeBytes, mtimeMs }
          } catch {}
        }
      }
      // Convert to array with ISO dates
      return Object.values(byId).map((d) => ({
        id: d.id,
        type: d.type,
        sizeBytes: d.sizeBytes,
        mtimeMs: d.mtimeMs,
        mtimeISO: new Date(d.mtimeMs).toISOString(),
      }))
    } catch {
      return []
    }
  }

  /** @param {string} dirPath */
  #dirSize(dirPath) {
    return this.#subtreeStats(dirPath).size
  }

  /**
   * Compute total size and latest mtime within a subtree.
   * @param {string} dirPath
   * @returns {{ size: number, mtime: number }}
   */
  #subtreeStats(dirPath) {
    let total = 0
    let latest = 0
    try {
      const items = fs.readdirSync(dirPath, { withFileTypes: true })
      for (const item of items) {
        const fp = `${dirPath}/${item.name}`
        if (item.isDirectory()) {
          const { size, mtime } = this.#subtreeStats(fp)
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
      // include directory mtime as well
      try {
        const stDir = fs.statSync(dirPath)
        if (stDir.mtimeMs > latest) latest = stDir.mtimeMs
      } catch {}
    } catch {}
    return { size: total, mtime: latest }
  }
}
