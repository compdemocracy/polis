// Description: Generates embed/alpha-index.html from embed/alpha-template.html
// NPM Usage: npm run build:embed:alpha -- --conversationId <conversationId> [--baseUrl <baseUrl>]
// Run npm run build:embed:alpha -- --help for more information.
// This is used by Cypress to generate ad-hoc embed/alpha-index.html for testing.

const fs = require('fs')

const inputFile = './embed/alpha-template.html'
const outputFile = './embed/alpha-index.html'

const argv = require('yargs/yargs')(process.argv.slice(2))
  .usage(
    'Usage: $0 --conversationId <conversationId> [--baseUrl <baseUrl>]\n' +
      '[--uiLang <uiLang>] [--xid <xid>] [--topic <topic>]\n' +
      '[--authNeededToVote <true|false>] [--authNeededToWrite <true|false>]',
  )
  .option('conversationId', {
    alias: 'id',
    describe: 'The conversation ID',
    type: 'string',
    demandOption: true,
  })
  .option('baseUrl', {
    alias: 'url',
    describe: 'The base URL that serves /alpha/embed.js',
    type: 'string',
    default: process.env.BASE_URL || process.env.CYPRESS_BASE_URL || 'http://localhost',
  })
  .option('uiLang', {
    alias: 'lang',
    describe: 'The UI language',
    type: 'string',
    default: 'en',
  })
  .option('xid', {
    describe: 'External ID (xid) to pass through to the iframe',
    type: 'string',
    default: '',
  })
  .option('topic', {
    describe: 'Topic to pass through to the iframe (optional)',
    type: 'string',
    default: '',
  })
  .option('authNeededToVote', {
    describe: 'Whether auth is needed to vote (string true/false)',
    type: 'boolean',
    default: false,
  })
  .option('authNeededToWrite', {
    describe: 'Whether auth is needed to write (string true/false)',
    type: 'boolean',
    default: true,
  }).argv

fs.readFile(inputFile, 'utf8', (err, data) => {
  if (err) throw err

  const replacedData = data
    .replace(/<%= conversation_id %>/g, argv.id)
    .replace(/<%= base_url %>/g, argv.url)
    .replace(/<%= ui_lang %>/g, argv.lang)
    .replace(/<%= xid %>/g, argv.xid)
    .replace(/<%= topic %>/g, argv.topic)
    .replace(/<%= auth_needed_to_vote %>/g, argv.authNeededToVote ? 'true' : 'false')
    .replace(/<%= auth_needed_to_write %>/g, argv.authNeededToWrite ? 'true' : 'false')

  fs.writeFile(outputFile, replacedData, (err) => {
    if (err) throw err
    console.log(`Generated ${outputFile} with Conversation ID ${argv.id}`)
  })
})
