import { axe, type JestAxeConfigureOptions } from 'jest-axe'
import en from '../strings/en_us'
import type { Translations } from '../strings/types'

export const a11yStrings: Translations = en

export async function expectNoA11yViolations(
  container: Element,
  options?: JestAxeConfigureOptions
): Promise<void> {
  const results = await axe(container, options)
  expect(results).toHaveNoViolations()
}
