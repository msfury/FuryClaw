import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { ProjectManager } from "../orchestrator/pm.js";
import type { FuryClawConfig } from "../types/config.js";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

export async function startDashboard(
  config: FuryClawConfig,
  workingDirectory: string,
  port: number = 3000
): Promise<void> {
  const pm = new ProjectManager(config, workingDirectory);
  const clients = new Set<WebSocket>();

  function broadcast(msg: Record<string, unknown>) {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  function broadcastState() {
    const state = pm.getState();
    const cfg = pm.getConfig();
    broadcast({
      type: "state",
      data: {
        status: state.status,
        plan: state.plan,
        workers: Object.fromEntries(
          [...state.workers].map(([k, v]) => [k, { ...v, logs: v.logs.slice(-50) }])
        ),
        chat: state.chat.slice(-200),
        totalCostUsd: state.totalCostUsd,
        elapsed: state.startTime ? Date.now() - state.startTime : 0,
        pendingQuestion: state.pendingQuestion,
        config: { model: cfg.defaultModel, effort: cfg.effort, concurrency: cfg.concurrency },
      },
    });
  }

  // PM emits state changes
  pm.on("state", broadcastState);

  // Tick elapsed timer
  setInterval(() => {
    const s = pm.getState();
    if (s.status !== "idle" && s.status !== "done" && s.status !== "error") {
      broadcastState();
    }
  }, 1000);

  // HTTP server
  const thisDir = dirname(fileURLToPath(import.meta.url));
  let publicDir = resolve(thisDir, "public");
  if (!existsSync(publicDir)) {
    publicDir = resolve(thisDir, "../../src/web/public");
  }

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // API: user sends a message (chat)
    if (url.pathname === "/api/message" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { text } = JSON.parse(body);
          if (!text) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "text required" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          pm.handleUserMessage(text);
        } catch {
          res.writeHead(400);
          res.end("Invalid JSON");
        }
      });
      return;
    }

    // API: update config
    if (url.pathname === "/api/config" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const updates = JSON.parse(body);
          pm.updateConfig(updates);
          const cfg = pm.getConfig();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, config: { model: cfg.defaultModel, effort: cfg.effort, concurrency: cfg.concurrency } }));
        } catch {
          res.writeHead(400);
          res.end("Invalid JSON");
        }
      });
      return;
    }

    // API: state
    if (url.pathname === "/api/state") {
      const state = pm.getState();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: state.status, workerCount: state.workers.size, totalCostUsd: state.totalCostUsd }));
      return;
    }

    // Static files
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const fullPath = resolve(publicDir, filePath.slice(1));
    try {
      const content = readFileSync(fullPath);
      const ext = extname(fullPath);
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  // WebSocket
  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws) => {
    clients.add(ws);
    broadcastState();
    ws.on("close", () => clients.delete(ws));
  });

  httpServer.listen(port, () => {
    console.log(`\n  Dashboard: http://localhost:${port}\n`);
  });
}
