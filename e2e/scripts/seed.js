const cypress = require('cypress')

/**
 * Seed Script Usage:
 * -----------------
 * Basic usage:
 *   npm run seed
 *
 * With custom parameters:
 *   npm run seed -- --numVoters=10 --numConversations=3 --commentsPerConvo=5
 *
 * Environment Variables:
 *   CYPRESS_BASE_URL - Set the API server URL (default: http://localhost)
 *     Example: CYPRESS_BASE_URL=http://localhost:5001 npm run seed
 *
 * Available Arguments:
 *   --numVoters         Number of anonymous participants to create (default: 5)
 *   --numConversations Number of conversations to create (default: 2)
 *   --commentsPerConvo Number of seed comments per conversation (default: 3)
 *
 * Notes:
 * - A moderator user will always be created (moderator@polis.test)
 * - Each conversation will have the specified number of seed comments
 * - For each conversation, the specified number of anonymous participants will be created
 * - Each participant will make the specified number of votes on their conversation
 * - The script is idempotent - running it multiple times will not create duplicate data
 */

async function seed({ numVoters = 5, numConversations = 2, commentsPerConvo = 3 } = {}) {
  console.log('\n🌱 Starting database seeding...\n')
  console.log('Configuration:')
  console.log(`- Anonymous participants per conversation: ${numVoters}`)
  console.log(`- Conversations to create: ${numConversations}`)
  console.log(`- Comments per conversation: ${commentsPerConvo}`)
  console.log('\n')

  const config = {
    config: {
      baseUrl: process.env.CYPRESS_BASE_URL || 'http://localhost',
      experimentalMemoryManagement: true,
      numTestsKeptInMemory: 0,
      video: false,
      screenshotOnRunFailure: false,
      e2e: {
        specPattern: 'scripts/seed.cy.js',
      },
    },
    env: {
      numVoters,
      numConversations,
      commentsPerConvo,
    },
  }

  try {
    const results = await cypress.run(config)

    if (results.totalFailed === 0) {
      const totalVotes = numVoters * commentsPerConvo * numConversations
      console.log(`\n✅ Database seeded successfully!
- Created 1 moderator
- Created ${numConversations} conversations
- Added ${numConversations * commentsPerConvo} total comments
- Created ${numVoters} participants
- Added ${totalVotes} total votes\n`)
      process.exit(0)
    } else {
      console.log('\n❌ Failed to seed database')
      console.log(`Failed tests: ${results.totalFailed}`)
      console.log('Check the output above for detailed error messages.\n')
      console.log('Common issues:')
      console.log(`1. Make sure the API server is running at ${config.config.baseUrl}`)
      console.log('2. Make sure the database is accessible')
      console.log('3. Check if the moderator account already exists\n')
      process.exit(1)
    }
  } catch (err) {
    console.error('\n❌ Error running tests:', err.message)
    process.exit(1)
  }
}

// If script is run directly (not imported)
if (require.main === module) {
  const args = process.argv.slice(2)
  const options = {}

  args.forEach((arg) => {
    const [key, value] = arg.replace('--', '').split('=')
    if (value) {
      options[key] = parseInt(value)
    }
  })

  seed(options)
}

module.exports = { seed }
