/** @jest-environment node */
import { GET } from '../pages/build-info.json'
const { cases, fixture } = require('../../../scripts/build-identity-test.cjs')

test.each(cases)('%s build resource', async (_name, metadata, expected) => {
  const info = fixture(metadata)
  const original = process.env
  try {
    process.env = { ...original, POLIS_BUILD_INFO: info }
    const response = GET()
    expect(await response.json()).toEqual(info)
    expect(info.version_display).toBe(expected)
  } finally {
    process.env = original
  }
})
