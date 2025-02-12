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
      '[--uiLang <ulLang>] [--ucsd <value>] [--ucsf <value>] [--ucsh <value>]\n' +
      '[--ucst <value>] [--ucsv <value>] [--ucv <value>] [--ucw <value>]'
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
    default: 'http://localhost',
  })
  .option('uiLang', {
    alias: 'lang',
    describe: 'The UI language',
    type: 'string',
    default: 'en',
  })
  .option('ucsd', {
    describe: 'user-can-see-description',
    type: 'string',
  })
  .option('ucsf', {
    describe: 'user-can-see-footer',
    type: 'string',
  })
  .option('ucsh', {
    describe: 'user-can-see-help',
    type: 'string',
  })
  .option('ucst', {
    describe: 'user-can-see-topic',
    type: 'string',
  })
  .option('ucsv', {
    describe: 'user-can-see-vis',
    type: 'string',
  })
  .option('ucv', {
    describe: 'user-can-vote',
    type: 'string',
  })
  .option('ucw', {
    describe: 'user-can-write',
    type: 'string',
  }).argv

fs.readFile(inputFile, 'utf8', (err, data) => {
  if (err) throw err

  const replacedData = data
    .replace(/<%= conversation_id %>/g, argv.id)
    .replace(/<%= base_url %>/g, argv.url)
    .replace(/<%= ui_lang %>/g, argv.lang)
    .replace(/<%= ucsd %>/g, argv.ucsd !== undefined ? argv.ucsd : 1)
    .replace(/<%= ucsf %>/g, argv.ucsf !== undefined ? argv.ucsf : 1)
    .replace(/<%= ucsh %>/g, argv.ucsh !== undefined ? argv.ucsh : 1)
    .replace(/<%= ucst %>/g, argv.ucst !== undefined ? argv.ucst : 1)
    .replace(/<%= ucsv %>/g, argv.ucsv !== undefined ? argv.ucsv : 1)
    .replace(/<%= ucv %>/g, argv.ucv !== undefined ? argv.ucv : 1)
    .replace(/<%= ucw %>/g, argv.ucw !== undefined ? argv.ucw : 1)

  fs.writeFile(outputFile, replacedData, (err) => {
    if (err) throw err
    console.log(`Generated ${outputFile} with Conversation ID ${argv.id}`)
  })
})
