// Description: Generates embed/index.html from embed/template.html
// NPM Usage: npm run build:embed -- --conversationId <conversationId> [--baseUrl <baseUrl>]
// Run npm run build:embed -- --help for more information.
// This is used by Cypress to generate ad-hoc embed/index.html for testing.

const fs = require('fs')
const inputFile = './embed/template.html'
const outputFile = './embed/index.html'

const argv = require('yargs/yargs')(process.argv.slice(2))
  .usage(
    'Usage: $0 --conversationId <conversationId> [--baseUrl <baseUrl>]\n' +
      '[--uiLang <ulLang>] [--ucsd <false>] [--ucsf <false>] [--ucsh <false>]\n' +
      '[--ucst <false>] [--ucsv <false>] [--ucv <false>] [--ucw <false>]',
  )
  .option('conversationId', {
    alias: 'id',
    describe: 'The conversation ID',
    type: 'string',
    demandOption: true,
  })
  .option('baseUrl', {
    alias: 'url',
    describe: 'The base URL',
    type: 'string',
    default: process.env.BASE_URL || process.env.CYPRESS_BASE_URL || 'http://localhost',
  })
  .option('uiLang', {
    alias: 'lang',
    describe: 'The UI language',
    type: 'string',
    default: 'en',
  })
  .option('ucsd', {
    describe: 'user-can-see-description',
    type: 'boolean',
    default: true,
  })
  .option('ucsf', {
    describe: 'user-can-see-footer',
    type: 'boolean',
    default: true,
  })
  .option('ucsh', {
    describe: 'user-can-see-help',
    type: 'boolean',
    default: true,
  })
  .option('ucst', {
    describe: 'user-can-see-topic',
    type: 'boolean',
    default: true,
  })
  .option('ucsv', {
    describe: 'user-can-see-vis',
    type: 'boolean',
    default: true,
  })
  .option('ucv', {
    describe: 'user-can-vote',
    type: 'boolean',
    default: true,
  })
  .option('ucw', {
    describe: 'user-can-write',
    type: 'boolean',
    default: true,
  }).argv

fs.readFile(inputFile, 'utf8', (err, data) => {
  if (err) throw err

  const replacedData = data
    .replace(/<%= conversation_id %>/g, argv.id)
    .replace(/<%= base_url %>/g, argv.url)
    .replace(/<%= ui_lang %>/g, argv.lang)
    .replace(/<%= ucsd %>/g, argv.ucsd ? 1 : 0)
    .replace(/<%= ucsf %>/g, argv.ucsf ? 1 : 0)
    .replace(/<%= ucsh %>/g, argv.ucsh ? 1 : 0)
    .replace(/<%= ucst %>/g, argv.ucst ? 1 : 0)
    .replace(/<%= ucsv %>/g, argv.ucsv ? 1 : 0)
    .replace(/<%= ucv %>/g, argv.ucv ? 1 : 0)
    .replace(/<%= ucw %>/g, argv.ucw ? 1 : 0)

  fs.writeFile(outputFile, replacedData, (err) => {
    if (err) throw err
    console.log(`Generated ${outputFile} with Conversation ID ${argv.id}`)
  })
})
