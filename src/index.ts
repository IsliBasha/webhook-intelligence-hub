import { server } from './server.js'
import { startRetryScheduler } from './routing/pipeline.js'

const REQUIRED_ENV_VARS = ['GITHUB_WEBHOOK_SECRET', 'STRIPE_WEBHOOK_SECRET', 'SHOPIFY_WEBHOOK_SECRET'] as const

const missingEnvVars = REQUIRED_ENV_VARS.filter((name) => !process.env[name])
if (missingEnvVars.length > 0) {
  throw new Error(`Missing required environment variables: ${missingEnvVars.join(', ')}`)
}

const PORT = parseInt(process.env.PORT ?? '3000', 10)
server.listen(PORT, () => {
  process.stdout.write(`Webhook hub listening on :${PORT}\n`)
})

startRetryScheduler()
