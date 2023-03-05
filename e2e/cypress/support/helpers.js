import { faker } from '@faker-js/faker'

export function generateRandomUser() {
  return {
    name: faker.name.findName(),
    email: faker.internet.email(),
    password: faker.internet.password(),
  }
}

export function generateRandomUsers(count) {
  return Array.from({ length: count }, generateRandomUser)
}

export function translation(lang, filename) {
  cy.readFile(`../../../client-participation/js/strings/${filename}.js`).then((contents) => {
    const targetStringKey = 'writePrompt'
    const stringObj = JSON.parse(contents)
    return stringObj[targetStringKey] || ''
  })
}
