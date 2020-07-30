import React from 'react'
import { Box, Link, Heading } from 'theme-ui'
import KnowledgeBase from './knowledgeBase'

const ExploreKnowledgeBase = () => {
  return (
    <Box>
      <Heading
        as="h3"
        sx={{ fontSize: [4], lineHeight: 'body', my: [2, null, 3] }}>
        Explore
      </Heading>
      <Box sx={{ mb: [4, null, 5], maxWidth: '35em' }}>
        <Box style={{ mb: [5, null, 6] }}>
          Onboard with a{' '}
          <Link
            target="_blank"
            href="https://roamresearch.com/#/app/polis-methods/page/1GR4r4LX8">
            comprehensive knowledge base
          </Link>{' '}
          including
        </Box>
        <KnowledgeBase
          url="https://roamresearch.com/#/app/polis-methods/page/1GR4r4LX8"
          e="👋"
          txt="Welcome Guide"
        />
        <KnowledgeBase
          url="https://roamresearch.com/#/app/polis-methods/page/M3kl50tZp"
          e="🏎"
          txt="Quickstart"
        />
        <KnowledgeBase
          url="https://roamresearch.com/#/app/polis-methods/page/yOgKP4cOJ"
          e="🔩"
          txt="Usage Overview"
        />
        <KnowledgeBase
          url="https://roamresearch.com/#/app/polis-methods/page/yYRydgFpz"
          e="📖"
          txt="FAQ"
        />
        <KnowledgeBase
          url="https://roamresearch.com/#/app/polis-methods/page/FFCfORSze"
          e="⚗️"
          txt="Case Studies"
        />
        <KnowledgeBase
          url="https://roamresearch.com/#/app/polis-methods/page/ciPWF73Ss"
          e="👾"
          txt="Algorithms"
        />
        <KnowledgeBase
          url="https://roamresearch.com/#/app/polis-methods/page/nCWjNfNRP"
          e="👹"
          txt="Best Practices for Moderation"
        />
        <KnowledgeBase
          url="https://roamresearch.com/#/app/polis-methods/page/CHakFRWFR"
          e="🗞"
          txt="Press"
        />
      </Box>
    </Box>
  )
}

export default ExploreKnowledgeBase
