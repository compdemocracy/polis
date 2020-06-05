/** @jsx jsx */
import { jsx, Text, Card } from "theme-ui";

export default ({ c, i, goToConversation }) => {
  return (
    <Card onClick={goToConversation} sx={{ cursor: "pointer", mb: [3] }} key={i}>
      <Text sx={{ fontWeight: 700, mb: [2] }}>{c.topic}</Text>
      <Text>{c.description}</Text>
      <Text>{c.parent_url ? `Embedded on ${c.parent_url}` : null}</Text>
      <Text sx={{ mt: [2] }}>{c.participant_count} participants</Text>
    </Card>
  );
};
