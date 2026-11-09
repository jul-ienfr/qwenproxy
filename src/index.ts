try {
  process.title = "QwenProxy";
} catch {}
process.env.DOTENV_CONFIG_QUIET = 'true'
import dotenv from 'dotenv'
import fs from 'node:fs'
import { getEnvFilePath, ensureDataDirs } from './core/paths.ts'
import { formatVersionLine } from './core/build-info.ts'

// `--version` must work before data directories, .env or the server are touched.
if (
  process.argv.includes('--version') ||
  process.argv.includes('-v') ||
  process.argv[2] === 'version'
) {
  console.log(formatVersionLine())
  process.exit(0)
}

// Ensure persistent user data directory exists
ensureDataDirs()

// Load .env from local directory or persistent global OS directory
const envPath = getEnvFilePath()
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, quiet: true })
} else {
  dotenv.config({ quiet: true })
}
import { installProcessTeardownGuards } from './core/process-guard.ts'

// Prevent benign asynchronous driver/browser teardown exceptions from crashing the server
installProcessTeardownGuards("Playwright");
import { startServer } from './api/server.js'
const isTui = process.argv.includes('--tui') || process.env.QWEN_TUI === 'true'

if (isTui) {
  const { TuiApp } = await import('./tui/app.ts')
  const app = new TuiApp()
  await app.start()
} else {
  startServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    // Expected configuration errors are already formatted with an emoji and
    // actionable guidance; print only the message to avoid leaking stack traces.
    if (message.includes('No Qwen accounts configured')) {
      console.error(message)
      console.log('\n👉 Dica: Execute a interface interativa com "qpx" (ou "npm run tui") para gerenciar contas,')
      console.log('   ou configure a variável QWEN_ACCOUNTS no seu arquivo .env.\n')
    } else if (message.includes('[Server]')) {
      console.error(message)
    } else {
      console.error('❌ [Server] Failed to start:', message)
    }
    process.exit(1)
  })
}
