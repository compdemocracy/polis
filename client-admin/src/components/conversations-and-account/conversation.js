/** @jsx jsx */
import { jsx, Text, Card } from 'theme-ui'
import PropTypes from 'prop-types'

function Conversation({ c, i, goToConversation }) {
  return (
    <Card
      onClick={goToConversation}
      sx={{ cursor: 'pointer', 'overflow-wrap': 'break-word', mb: [3] }}
      key={i}>
      <Text sx={{ fontWeight: 700, mb: [2] }}>{c.topic}</Text>
      <Text>{c.description}</Text>
      <Text>{c.parent_url ? `Embedded on ${c.parent_url}` : null}</Text>
      <Text sx={{ mt: [2] }}>{c.participant_count} participants</Text>
    </Card>
  )
}

Conversation.propTypes = {
  c: PropTypes.shape({
    topic: PropTypes.string,
    description: PropTypes.string,
    parent_url: PropTypes.string,
    participant_count: PropTypes.number
  }),
  i: PropTypes.number.isRequired,
  goToConversation: PropTypes.func.isRequired
}

export default Conversation
