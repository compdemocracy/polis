import { render, screen } from '@testing-library/react'
const { cases, fixture } = require('../../../scripts/build-identity-test.cjs')

const original = process.env
let About
beforeAll(() => {
  process.env = { ...original, POLIS_BUILD_INFO: fixture(cases[1][1]) }
  About = require('./About').default
})
afterAll(() => { process.env = original })
afterEach(() => { delete global.fetch })

test.each(cases)('shows %s server identity', async (_name, metadata, expected) => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => fixture(metadata) })
  render(<About />)
  expect(screen.getByText('Admin: 2.40.0+dev.16.aaaaaaaaaaaa')).toBeInTheDocument()
  expect(await screen.findByText(`Server: ${expected}`)).toBeInTheDocument()
  expect(screen.getByText(expected === '2.40.0+dev.16.aaaaaaaaaaaa'
    ? 'Client and server builds match.' : 'Client and server builds differ.')).toBeInTheDocument()
})
test('shows matching builds', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => fixture(cases[1][1]) })
  render(<About />)
  expect(await screen.findByText('Client and server builds match.')).toBeInTheDocument()
})
test('shows unavailable server', async () => {
  global.fetch = jest.fn().mockRejectedValue(new Error('unavailable'))
  render(<About />)
  expect(await screen.findByText('Server version unavailable.')).toBeInTheDocument()
})
