import { Box, Link, Heading } from 'theme-ui'
import KnowledgeBase from './KnowledgeBase'

const ExploreKnowledgeBase = () => {
  return (
    <Box>
      <Heading as="h3" sx={{ fontSize: [4], lineHeight: 'body', my: [2, null, 3] }}>
        Explore
      </Heading>
      <Box sx={{ mb: [4, null, 5], maxWidth: '35em' }}>
        {/* prettier-ignore */}
        <Box style={{ mb: [5, null, 6] }}>
          Onboard with a{' '}
          {/* prettier-ignore */}
          <Link
            target="_blank"
            href="https://compdemocracy.org/knowledge-base">
            comprehensive knowledge base
          </Link>{' '}
          including
        </Box>
        <KnowledgeBase url="https://compdemocracy.org/Welcome" e="👋" txt="Welcome Guide" />
        <KnowledgeBase url="https://compdemocracy.org/Quickstart" e="🏎" txt="Quickstart" />
        <KnowledgeBase url="https://compdemocracy.org/Usage" e="🔩" txt="Usage Overview" />
        {/* prettier-ignore */}
        <KnowledgeBase
          url="https://compdemocracy.org/FAQ"
          e="📖"
          txt="FAQ"
        />
        <KnowledgeBase url="https://compdemocracy.org/Case-studies" e="⚗️" txt="Case Studies" />
        <KnowledgeBase url="https://compdemocracy.org/algorithms" e="👾" txt="Algorithms" />
        <KnowledgeBase
          url="https://compdemocracy.org/Moderation"
          e="👹"
          txt="Best Practices for Moderation"
        />
        <KnowledgeBase url="https://compdemocracy.org/Media-coverage" e="🗞" txt="Press" />
      </Box>
    </Box>
  )
}

export default ExploreKnowledgeBase
