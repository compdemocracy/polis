import Layout from './lander-layout'
import { Heading, Box, Text, Link, Image } from 'theme-ui'
import PropTypes from 'prop-types'

const Placeholder = ({ text }) => (
  <Box
    sx={{
      bg: 'muted',
      p: 4,
      my: 4,
      textAlign: 'center',
      border: '1px dashed',
      borderColor: 'secondary'
    }}>
    <Text sx={{ fontWeight: 'bold', color: 'secondary' }}>{text}</Text>
  </Box>
)

Placeholder.propTypes = {
  text: PropTypes.string.isRequired
}

const Home2 = () => {
  return (
    <Layout>
      <Box sx={{ maxWidth: '800px', mx: 'auto', px: 3 }}>
        {/* Introduction */}
        <Heading as="h1" sx={{ my: 4, fontSize: [5, 6] }}>
          Polis is an open-source platform that helps entire cities, states, or even countries find
          common ground on complex issues.
        </Heading>
        <Text as="p" sx={{ fontSize: 3, mb: 4, lineHeight: 'body' }}>
          First launched in 2012, it&apos;s been battle-tested in tens of thousands of conversations
          with more than ten million participants worldwide. By collecting and analyzing viewpoints
          from thousands of participants, Polis reveals points of consensus, even on topics that
          seem deadlocked.
        </Text>

        <Text as="p" sx={{ mb: 3 }}>
          Polis has become part of the national democratic infrastructure in Taiwan, the UK, and
          Finland. Taiwan has used it to craft legislation on issues ranging from Uber regulation to
          revenge porn and online liquor sales; the UK has employed it for national security
          consultations; and Finland&apos;s wellbeing services counties — regional bodies
          responsible for health and social services — use Polis to design programs like support for
          elderly safety and mental health services for children, based on what citizens say they
          need. Governments in Singapore and the Philippines have also adopted the platform, while
          in Austria, the Klimarat (the National Citizens&rsquo; Assembly on Climate) used Polis to
          bring together thousands of citizens and experts to develop climate proposals.
        </Text>
        <Text as="p" sx={{ mb: 3 }}>
          At the local level, Amsterdam, Bowling Green, Kentucky, and multiple UK cities have used
          Polis to improve residents&apos; lives. The United Nations Development Programme (UNDP)
          deployed it for what it called &quot;the largest online deliberative exercises in
          history,&quot; engaging 30,000 youth across Bhutan, East Timor, and Pakistan.
        </Text>
        <Text as="p" sx={{ mb: 4 }}>
          Polis is designed, engineered, and maintained by The Computational Democracy Project
          (CompDem), a U.S.-based 501(c)(3). The tool has been featured in MIT Technology Review,
          Wired, The Economist, and The New York Times, and in BBC and PBS documentaries.
        </Text>

        <Box sx={{ mb: 5 }}>
          <Link href="https://compdemocracy.org/Case-studies" target="_blank">
            Polis case studies from around the world
          </Link>
        </Box>

        {/* Polis 2.0 */}
        <Heading as="h2" sx={{ fontSize: 5, mb: 3 }}>
          Polis 2.0
        </Heading>
        <Text as="p" sx={{ mb: 3 }}>
          CompDem is now introducing Polis 2.0, an enhanced version of the original Polis 1.0
          platform. This upgraded system combines massive participation capacity — supporting
          millions of simultaneous participants — with automated mapping of hundreds of thousands of
          individual viewpoints, real-time LLM-generated summaries, and the ability to keep
          conversations open indefinitely.
        </Text>
        <Text as="p" sx={{ mb: 4 }}>
          Polis 2.0 achieves this transformative scale through four key mechanisms:
        </Text>
        <Box as="ul" sx={{ pl: 4, mb: 5 }}>
          <Box as="li" sx={{ mb: 2 }}>
            <Text>
              <strong>Scalable Cloud Infrastructure:</strong> Polis 2.0&rsquo;s robust,
              cloud-powered distributed system scales in real time to meet demand. While Polis
              1.0&rsquo;s largest deployment reached 33,547 participants (a conversation hosted by
              Germany&rsquo;s <em>Aufstehen</em> party), Polis 2.0&rsquo;s infrastructure can handle
              10–30x increases, supporting millions of simultaneous participants.
            </Text>
          </Box>
          <Box as="li" sx={{ mb: 2 }}>
            <Text>
              <strong>Dynamic Opinion Mapping:</strong> Polis groups participants based on how
              similarly they vote and what statements they submit. Building on a foundation of
              simple but solid statistical algorithms from a decade ago, Polis 2.0 now employs more
              refined and nuanced approaches. These groupings update in real-time as the
              conversation evolves, maintaining clear analysis even across hundreds of thousands of
              statements and millions of votes.
            </Text>
          </Box>
          <Box as="li" sx={{ mb: 2 }}>
            <Text>
              <strong>Semantic Topic Clustering:</strong> Polis 2.0 is the first to use the
              Embedding Vector Oriented Clustering (EVōC) library from the Tutte Institute for
              Mathematics and Computing to automatically organize conversations into evolving topic
              hierarchies — hundreds of topics and subtopics — drawn from both organizer-seeded
              comments and participant input. Participants can view all topic areas and select those
              of greatest interest before entering the discussion. This organic process lets
              participants collectively shape the agenda over time, with &quot;hot&quot; and
              &quot;cold&quot; areas of discussion naturally emerging, allowing Polis 2.0
              conversations to remain open indefinitely.
            </Text>
          </Box>
          <Box as="li" sx={{ mb: 2 }}>
            <Text>
              <strong>End-to-End Automation:</strong> Earlier Polis conversations required intensive
              moderation of participant input and facilitator expertise to distill dense outputs
              into actionable reports — processes that demanded extensive training and practice.
              Polis 2.0 automates conversation seeding, moderation (including toxicity filtering),
              semantic clustering, and report generation. This removes the expert facilitator
              bottleneck while preserving the option for human oversight.
            </Text>
          </Box>
        </Box>

        {/* How Polis 2.0 works */}
        <Heading as="h2" sx={{ fontSize: 5, mb: 4 }}>
          How Polis 2.0 works
        </Heading>

        {/* 1. Setting up */}
        <Heading as="h3" sx={{ fontSize: 4, mb: 3 }}>
          1. Setting up a Polis 2.0 conversation
        </Heading>
        <Text as="p" sx={{ mb: 3 }}>
          Polis is “seeded” with a set of statements that participants can “agree,” “disagree,” or
          “pass” on.
        </Text>
        <Text as="p" sx={{ mb: 2 }}>
          Polis 2.0 accepts multiple input types.{' '}
          <strong>The primary format is short statements (1-3 sentences)</strong>, optimized for
          mobile voting — most are generated directly by participants.
        </Text>
        <Text as="p" sx={{ mb: 2, fontWeight: 'bold' }}>
          Other input formats can be pre-processed using an LLM and entered via CSV:
        </Text>
        <Box as="ul" sx={{ pl: 4, mb: 5 }}>
          <Box as="li" sx={{ mb: 1 }}>
            <strong>Long narratives</strong> (chunked into votable statements)
          </Box>
          <Box as="li" sx={{ mb: 1 }}>
            <strong>Workshop transcripts</strong> (face-to-face discussion outputs converted to
            votable statements)
          </Box>
          <Box as="li" sx={{ mb: 1 }}>
            <strong>Social media posts</strong> (text from Facebook, Instagram, YouTube, etc.,
            processed and de-duplicated)
          </Box>
          <Box as="li" sx={{ mb: 1 }}>
            <strong>Online media comments</strong> (compiled and filtered)
          </Box>
          <Box as="li" sx={{ mb: 1 }}>
            <strong>Email submissions</strong> (text-based input from non-digital participants)
          </Box>
          <Box as="li" sx={{ mb: 1 }}>
            <strong>Voice recordings</strong> (transcribed and processed into text)
          </Box>
        </Box>

        {/* 2. Inviting Participants */}
        <Heading as="h3" sx={{ fontSize: 4, mb: 3 }}>
          2. Inviting Participants
        </Heading>
        <Text as="p" sx={{ mb: 2 }}>
          Polis 2.0 includes multiple systems for managing participant identity and growth:
        </Text>
        <Box as="ul" sx={{ pl: 4, mb: 5 }}>
          <Box as="li" sx={{ mb: 2 }}>
            <strong>Invite Trees:</strong> A structured invitation system tracks how participants
            join conversations, enabling organic growth through networks while maintaining quality.
            This snowball sampling approach allows organizers to understand how conversations spread
            and optimize for meaningful participation over viral reach.
          </Box>
          <Box as="li" sx={{ mb: 2 }}>
            <strong>Identity Management:</strong> Advanced XID (external identifier) whitelist and
            download capabilities, plus OIDC authentication providers, ensure secure and flexible
            participant access.
          </Box>
          <Box as="li" sx={{ mb: 2 }}>
            <strong>Data Portability:</strong> Complete data portability with XID support enables
            cross-platform participant tracking and analysis, compatible with popular polling and
            survey platforms such as SurveyMonkey, Qualtrics, Typeform, and Google Forms.
          </Box>
        </Box>

        {/* 3. Participating */}
        <Heading as="h3" sx={{ fontSize: 4, mb: 3 }}>
          3. Participating on Polis 2.0
        </Heading>
        <Text as="p" sx={{ mb: 2 }}>
          On Polis 2.0 participants can:
        </Text>
        <Box as="ul" sx={{ pl: 4, mb: 3 }}>
          <Box as="li" sx={{ mb: 1 }}>
            <strong>Select topics of interest</strong> — collectively setting the agenda for what
            everyone will vote on
          </Box>
          <Box as="li" sx={{ mb: 1 }}>
            <strong>Vote on others’ statements</strong> — agree, disagree, or pass (there&apos;s no
            reply function, by design)
          </Box>
          <Box as="li" sx={{ mb: 1 }}>
            <strong>Submit statements about issues that matter to them</strong> — shaping
            conversation topics
          </Box>
          <Box as="li" sx={{ mb: 1 }}>
            <strong>Mark which statements are especially important to them</strong> (optional)
          </Box>
        </Box>

        <Box sx={{ my: 4, textAlign: 'center' }}>
          <Image
            src="/bg2050.png"
            alt="Bowling Green 2050 Conversation"
            sx={{
              maxWidth: '100%',
              height: 'auto',
              borderRadius: 4,
              boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
            }}
          />
        </Box>

        <Text as="p" sx={{ mb: 2 }}>
          <strong>Multi-lingual capabilities:</strong> The system detects a participant’s browser
          language and automatically translates the UI text and statements into their preferred
          language. Participants can submit statements in any language and view all statements both
          in the default language and in their chosen language.
        </Text>

        <Box sx={{ my: 4, textAlign: 'center' }}>
          <Image
            src="/bg2050_fr.png"
            alt="Bowling Green 2050 Conversation in French"
            sx={{
              maxWidth: '100%',
              height: 'auto',
              borderRadius: 4,
              boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
            }}
          />
        </Box>

        {/* 4. Moderating */}
        <Heading as="h3" sx={{ fontSize: 4, mb: 3, mt: 5 }}>
          4. Moderating Polis 2.0
        </Heading>
        <Text as="p" sx={{ mb: 3 }}>
          Polis conversations with tens of thousands of participant-entered statements require
          effective moderation. Polis 2.0 includes AI-assisted moderation features to support this:
        </Text>
        <Box as="ul" sx={{ pl: 4, mb: 3 }}>
          <Box as="li" sx={{ mb: 1 }}>
            <strong>Toxicity Detection:</strong> Real-time flagging of hate speech, harassment, and
            extremist content
          </Box>
          <Box as="li" sx={{ mb: 1 }}>
            <strong>Language Processing:</strong> Automatic translation for multilingual
            participation
          </Box>
        </Box>
        <Text as="p" sx={{ mb: 2 }}>
          Human Oversight (recommended):
        </Text>
        <Box as="ul" sx={{ pl: 4, mb: 3 }}>
          <Box as="li" sx={{ mb: 1 }}>
            <strong>Review:</strong> Human review of AI moderation decisions
          </Box>
          <Box as="li" sx={{ mb: 1 }}>
            <strong>Cultural Sensitivity:</strong> Specialized review for marginalized or
            under-represented community contributions
          </Box>
          <Box as="li" sx={{ mb: 1 }}>
            <strong>Expert Fact-checking:</strong> Specialists verify claims about technical details
          </Box>
          <Box as="li" sx={{ mb: 1 }}>
            <strong>Company and Community Standards:</strong> Transparent moderation guidelines
            co-developed with participant input
          </Box>
        </Box>
        <Text as="p" sx={{ mb: 5 }}>
          In addition, the statement routing system functions as a form of moderation by determining
          the optimal presentation of statements to each participant.
        </Text>

        {/* 5. Analysis & Visualization */}
        <Heading as="h3" sx={{ fontSize: 4, mb: 3 }}>
          5. Real-time Analysis & Visualization
        </Heading>
        <Text as="p" sx={{ mb: 2, fontWeight: 'bold' }}>
          Polis 2.0 Outputs
        </Text>

        <Box sx={{ mb: 4 }}>
          <Text as="p" sx={{ mb: 2 }}>
            <strong>Comprehensive Topic and Opinion Mapping:</strong> Polis 2.0 maps the
            conversation by identifying popular topics, subtopics and their interconnections, areas
            of consensus, and points of disagreement.
          </Text>
          <Box
            as="iframe"
            src="https://polis-delphi.s3.us-east-1.amazonaws.com/visualizations/r7wehfsmutrwndviddnii/8456bfac-94a6-4fdf-b99e-0679fd635d9a/layer_0_datamapplot.html"
            sx={{
              width: '100%',
              height: '500px',
              border: 'none',
              borderRadius: 4,
              boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
              my: 3
            }}
            title="Interactive Topic Map"
          />
        </Box>

        <Box sx={{ mb: 4 }}>
          <Text as="p" sx={{ mb: 2 }}>
            <strong>Consensus Statements:</strong> For each topic and subtopic, the platform
            generates collective statements that reflect agreement across all groups, supported by
            the underlying comments and votes. These statements represent authentic consensus rather
            than imposed compromise.
          </Text>

          <Box sx={{ my: 4, textAlign: 'center' }}>
            <Image
              src="/collective.png"
              alt="Collective Statement Panel"
              sx={{
                maxWidth: '100%',
                height: 'auto',
                borderRadius: 4,
                boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
              }}
            />
          </Box>

          <Box sx={{ my: 4, textAlign: 'center' }}>
            <Image
              src="/beeswarm.png"
              alt="Topic Stats Beeswarm View"
              sx={{
                maxWidth: '100%',
                height: 'auto',
                borderRadius: 4,
                boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
              }}
            />
          </Box>
        </Box>

        <Box sx={{ mb: 4 }}>
          <Text as="p" sx={{ mb: 2 }}>
            <strong>Automated Narrative Report Generation:</strong> Polis 2.0 generates automated
            narrative reports and can draw on multiple LLM models. Reports cover the entire
            conversation or focus on specific topics and subtopics. The platform employs statistical
            grounding, prompt engineering, and evaluations to ensure high-quality summaries, with
            each clause in the report including citations for easy human verification.
          </Text>
        </Box>

        <Box sx={{ mb: 5 }}>
          <Text as="p" sx={{ mb: 2 }}>
            <strong>Data Repository:</strong> All data remains accessible for ongoing reference and
            further analysis
          </Text>
          <Box sx={{ my: 4, textAlign: 'center' }}>
            <Image
              src="/export_links.png"
              alt="Data Export Links"
              sx={{
                maxWidth: '100%',
                height: 'auto',
                borderRadius: 4,
                boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
              }}
            />
          </Box>
        </Box>
      </Box>
    </Layout>
  )
}

export default Home2
