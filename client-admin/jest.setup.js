import { TextEncoder } from 'util'
global.TextEncoder = TextEncoder

import '@testing-library/jest-dom'

// Limit Testing Library's DOM output in error messages
process.env.DEBUG_PRINT_LIMIT = '0'

// Suppress React act() warnings and jsdom navigation errors in tests
const originalError = console.error
beforeAll(() => {
  console.error = (...args) => {
    // Suppress React act() warnings (expected for async components)
    if (
      typeof args[0] === 'string' &&
      args[0].includes('An update to') &&
      args[0].includes('inside a test was not wrapped in act')
    ) {
      return
    }
    // Suppress jsdom navigation warnings (from download link clicks in tests)
    if (
      args[0]?.message?.includes('Not implemented: navigation') ||
      (typeof args[0] === 'string' && args[0].includes('Not implemented: navigation'))
    ) {
      return
    }
    // Suppress expected error logs from error handling tests
    if (typeof args[0] === 'string' && args[0].includes('Error fetching UUID:')) {
      return
    }
    originalError.call(console, ...args)
  }
})

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
