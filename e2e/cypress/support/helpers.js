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
