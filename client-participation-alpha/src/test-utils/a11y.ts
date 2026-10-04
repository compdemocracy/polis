import { axe, type JestAxeConfigureOptions } from 'jest-axe'
import en from '../strings/en_us'
import type { Translations } from '../strings/types'

/**
 * Real en_us help strings use mismatched <b>/</b> tags (legacy copy).
 * Override with valid HTML so axe checks the components, not the copy bugs.
 */
export const a11yStrings: Translations = {
  ...en,
  writeCommentHelpText:
    'Are your perspectives or experiences missing from the conversation? If so, <b>add them</b> in the box below — <b>one at a time</b>.',
  tipCommentsRandom:
    'Statements are displayed randomly and you are not replying directly to other people’s statements: <b>you are adding a stand-alone statement.</b>'
}

export async function expectNoA11yViolations(
  container: Element,
  options?: JestAxeConfigureOptions
): Promise<void> {
  const results = await axe(container, options)
  expect(results).toHaveNoViolations()
}
