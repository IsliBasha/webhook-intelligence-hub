import 'dotenv/config'
import express from 'express'
import { createServer } from 'node:http'

// TODO P3.1: Mount providers, routing, dashboard, SSE routes
const app = express()
const server = createServer(app)

app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

const PORT = parseInt(process.env.PORT ?? '3000', 10)
server.listen(PORT, () => {
  process.stdout.write(`Webhook hub listening on :${PORT}\n`)
})

export { app, server }
