const matchers = require('@testing-library/jest-dom/matchers')
expect.extend(matchers)

// Mock window.matchMedia which is used by some components
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(), // deprecated
    removeListener: jest.fn(), // deprecated
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn()
  }))
})

// Mock IntersectionObserver
global.IntersectionObserver = jest.fn().mockImplementation(() => ({
  observe: jest.fn(),
  unobserve: jest.fn(),
  disconnect: jest.fn()
}))

// Mock ResizeObserver
global.ResizeObserver = jest.fn().mockImplementation(() => ({
  observe: jest.fn(),
  unobserve: jest.fn(),
  disconnect: jest.fn()
}))

// Suppress console errors and warnings in tests (optional)
const originalError = console.error
const originalWarn = console.warn

beforeAll(() => {
  console.error = jest.fn((...args) => {
    if (
      typeof args[0] === 'string' &&
      (args[0].includes('Warning: ReactDOM.render') || args[0].includes('Warning: useLayoutEffect'))
    ) {
      return
    }
    originalError.call(console, ...args)
  })

  console.warn = jest.fn((...args) => {
    if (typeof args[0] === 'string' && args[0].includes('Warning:')) {
      return
    }
    originalWarn.call(console, ...args)
  })
})

afterAll(() => {
  console.error = originalError
  console.warn = originalWarn
})
