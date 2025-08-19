/* eslint-disable no-unused-vars */
/* eslint-disable react/prop-types */
import { Heading, Box, Text } from 'theme-ui'
import { useSelector, useDispatch } from 'react-redux'
import { handleZidMetadataUpdate } from '../../actions'

const InviteCodes = () => {
  const dispatch = useDispatch()
  const zid_metadata = useSelector((state) => state.zid_metadata)

  console.log('InviteCodes', zid_metadata)

  return (
    <Box>
      <Heading
        as="h3"
        sx={{
          fontSize: [3, null, 4],
          lineHeight: 'body',
          mb: [3, null, 4]
        }}>
        Invite Codes
      </Heading>

      <Box sx={{ mb: [3] }}>
        <Text sx={{ display: 'block', mb: [2] }}>
          This conversation is invite only. Participants will require an invite code in order to
          vote or comment
        </Text>
      </Box>

      <Heading
        as="h6"
        sx={{
          fontSize: [1, null, 2],
          lineHeight: 'body',
          my: [3, null, 4]
        }}>
        Initial Wave Size
      </Heading>
      <Text sx={{ display: 'block', mb: [2] }}>
        Enter the initial amount of invite codes to be disperesed
      </Text>
      <input type="number" min={5} max={1000} />
    </Box>
  )
}

export default InviteCodes
