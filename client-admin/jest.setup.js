/* globals global, jest */
import { TextEncoder } from 'util'
global.TextEncoder = TextEncoder

import '@testing-library/jest-dom'

// Limit Testing Library's DOM output in error messages
process.env.DEBUG_PRINT_LIMIT = '0'

// Add fetch polyfill for tests
global.fetch = jest.fn(() =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    headers: new Headers()
  })
)

// Mock window.matchMedia for components that use responsive design
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {}
  })
})
