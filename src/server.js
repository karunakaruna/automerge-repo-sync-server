// @ts-check
import fs from "fs"
import express from "express"
import { WebSocketServer } from "ws"
import { Repo } from "@automerge/automerge-repo"
import { NodeWSServerAdapter } from "@automerge/automerge-repo-network-websocket"
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs"
import os from "os"

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

    const PORT =
      process.env.PORT !== undefined ? parseInt(process.env.PORT) : 3030
    const AUTH_TOKEN = process.env.AUTH_TOKEN ?? "motherearth"
    const COOKIE_NAME = "amrg_auth"
    const app = express()
    // CORS for HTTP routes
    app.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "http://localhost:8000")
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
    const requireAuth = (req, res, next) => {
      if (!AUTH_TOKEN) return next()
      const cookies = parseCookies(req.headers.cookie || "")
      const token = cookies[COOKIE_NAME] || ""
      if (token === AUTH_TOKEN) return next()
      res.status(401).send("Unauthorized")
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
      const addr = this.#server?.address?.() ?? null
      const port = addr && typeof addr !== "string" ? addr.port : null
      res.json({
        status: "ok",
        hostname: this.#hostname,
        port,
        dataDir: this.#dataDir,
        activeConnections: this.#clients.size,
        documents: this.#listDocuments(),
      })
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
        this.#socket.emit("connection", socket, request)
      })
    })

    // Track active WS connections
    this.#socket.on("connection", (socket) => {
      this.#clients.add(socket)
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
      /** @type {{ id: string, type: 'dir'|'file', sizeBytes: number, mtimeMs: number, mtimeISO: string }[]} */
      const out = []

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
          out.push({
            id,
            type: "dir",
            sizeBytes: size,
            mtimeMs: mtime,
            mtimeISO: new Date(mtime).toISOString(),
          })
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
            out.push({
              id: e.name,
              type: "file",
              sizeBytes: stat.size,
              mtimeMs: stat.mtimeMs,
              mtimeISO: new Date(stat.mtimeMs).toISOString(),
            })
          } catch {}
        }
      }
      return out
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
