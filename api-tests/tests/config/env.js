import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, '../..')

// Load environment variables from .env file
config({ path: resolve(rootDir, '.env') })

// Set defaults for required environment variables
process.env.API_DOCKERFILE_PATH = process.env.API_DOCKERFILE_PATH || '../server'
process.env.API_SERVER_PORT = process.env.API_SERVER_PORT || '5000'
