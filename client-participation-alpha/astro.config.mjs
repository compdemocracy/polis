// @ts-check
import identityTools from '../scripts/build-identity.cjs'
const buildInfo = identityTools.buildIdentity()
import { defineConfig } from 'astro/config'

import react from '@astrojs/react'

import node from '@astrojs/node'

// https://astro.build/config
export default defineConfig({
  output: 'server',
  vite: { define: { 'process.env.POLIS_BUILD_INFO': JSON.stringify(buildInfo) } },
  adapter: node({
    mode: 'standalone'
  }),
  server: {
    host: '0.0.0.0'
  },
  integrations: [
    react({
      experimentalDisableStreaming: true,
      experimentalReactChildren: true
    })
  ]
})
