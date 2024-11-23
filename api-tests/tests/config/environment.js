export const config = {
  database: {
    user: 'postgres',
    password: 'test-password',
    name: 'postgres',
    testName: 'polis_test',
  },
  api: {
    dockerImage: process.env.API_DOCKER_IMAGE,
    dockerfilePath: process.env.API_DOCKERFILE_PATH,
  },
}
