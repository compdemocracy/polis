import { faker } from '@faker-js/faker'

// Public //

export function generateRandomUser() {
  return {
    name: faker.person.fullName(),
    email: faker.internet.email(),
    password: faker.internet.password(),
  }
}

export function generateRandomUsers(count) {
  return Array.from({ length: count }, generateRandomUser)
}

export function readTranslation(lang, key = 'writePrompt') {
  const filename = locales[lang]
  return cy
    .readFile(`../client-participation/js/strings/${filename}.js`, 'utf8')
    .then((contents) => {
      const regex = new RegExp(`s\\.${key}\\s*=\\s*"([^"]*)";`)
      const match = contents.match(regex)

      if (match) {
        return match[1]
      } else {
        throw new Error(`Failed match ${key} in file ${locales[lang]}.js`)
      }
    })
}

// Private //

const locales = {
  // <lang>: <filename>
  cy: 'cy',
  da: 'da_dk',
  de: 'de_de',
  en: 'en_us',
  es: 'es_la',
  fa: 'fa',
  fr: 'fr',
  gr: 'gr',
  he: 'he',
  hr: 'hr',
  it: 'it',
  ja: 'ja',
  nl: 'nl',
  pt: 'pt_br',
  ru: 'ru',
  sk: 'sk',
  uk: 'uk',
  'zh-CN': 'zh_Hans',
  'zh-TW': 'zh_Hant',
}
