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

async function seed({
  numVoters = 5,
  numConversations = 2,
  commentsPerConvo = 3
} = {}) {
  console.log('🌱 Starting database seeding...')
  console.log(`
Configuration:
- Anonymous participants per conversation: ${numVoters}
- Conversations to create: ${numConversations}
- Comments per conversation: ${commentsPerConvo}
`)

  const config = {
    env: {
      numVoters,
      numConversations,
      commentsPerConvo
    },
    config: {
      video: false,
      screenshotOnRunFailure: false,
      e2e: {
        baseUrl: process.env.BASE_URL || 'http://localhost',
        specPattern: 'scripts/seed.cy.js'
      }
    }
  }

  try {
    const results = await cypress.run(config)

    if (results.totalFailed === 0) {
      const totalVotes = numVoters * commentsPerConvo
      console.log(`
✅ Database seeded successfully!
- Created 1 moderator
- Created ${numConversations} conversations
- Added ${numConversations * commentsPerConvo} total comments
- Created ${numVoters} anonymous participants
- Added ${totalVotes} total votes
`)
    } else {
      console.error(`
❌ Failed to seed database
Failed tests: ${results.totalFailed}
Check the output above for detailed error messages.

Common issues:
1. Make sure the API server is running at ${config.config.e2e.baseUrl}
2. Make sure the database is accessible
3. Check if the moderator account already exists
`)
      process.exit(1)
    }
  } catch (error) {
    console.error('❌ Error seeding database:', error)
    process.exit(1)
  }
}

// If script is run directly (not imported)
if (require.main === module) {
  const args = process.argv.slice(2)
  const options = {}

  args.forEach(arg => {
    const [key, value] = arg.split('=')
    if (key && value) {
      options[key.replace('--', '')] = parseInt(value, 10)
    }
  })

  seed(options)
}

module.exports = { seed } 