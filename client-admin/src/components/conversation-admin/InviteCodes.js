/* eslint-disable no-unused-vars */
/* eslint-disable react/prop-types */
import { use, useState, useEffect } from 'react'
import { Heading, Box, Text, Button } from 'theme-ui'
import { useSelector, useDispatch } from 'react-redux'
import { handleZidMetadataUpdate } from '../../actions'

const getTotalInvitesSecheduled = (waves) => {
  let total = Number(waves.initialSize)
  waves.waves.forEach((w) => {
    total += total * Number(w)
  })

  return total
}

const InviteCodes = () => {
  const dispatch = useDispatch()
  const zid_metadata = useSelector((state) => state.zid_metadata)
  const [waves, setWaves] = useState({
    initialSize: 5,
    waves: []
  })
  const [isAddingWave, setIsAddingWave] = useState(false)

  console.log('InviteCodes', zid_metadata, waves)

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
        Enter the initial amount of invite codes to be dispersed
      </Text>
      <input
        type="number"
        min={5}
        max={1000}
        onChange={(e) => setWaves((w) => ({ initialSize: e.target.value, waves: w.waves }))}
        value={waves.initialSize || 5}
      />
      {waves.initialSize && (
        <Box sx={{ mb: [3], mt: [3] }}>
          <Button
            onClick={() => {
              setIsAddingWave(true)
            }}>
            Add Wave +
          </Button>
        </Box>
      )}
      {isAddingWave && (
        <Box sx={{ mb: [3] }}>
          <select
            onChange={(e) => {
              const newWave = e.target.value
              setWaves((w) => ({
                initialSize: w.initialSize,
                waves: [...w.waves, newWave]
              }))
            }}>
            <option selected value={1}>
              1
            </option>
            <option value={2}>2</option>
            <option value={3}>3</option>
            <option value={4}>4</option>
            <option value={5}>5</option>
          </select>
          <Button
            sx={{ ml: [3] }}
            onClick={() => {
              setIsAddingWave(false)
            }}>
            Submit
          </Button>
        </Box>
      )}
      <hr />
      {waves.waves.map((w, i) => (
        <Box key={i}>
          Wave {i + 1} Invites: {w}
        </Box>
      ))}
      Total Invite Codes Scheduled: {getTotalInvitesSecheduled(waves)}
    </Box>
  )
}

export default InviteCodes
