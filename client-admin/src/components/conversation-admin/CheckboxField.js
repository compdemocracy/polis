import { Box, Flex, Text } from 'theme-ui'
import { useDispatch } from 'react-redux'
import { useState } from 'react'
import PropTypes from 'prop-types'

import { handleConversationDataUpdate } from '../../actions'
import { useConversationData } from '../../util/conversation_data'

export const CheckboxField = ({ field, label = '', children, isIntegerBool = false }) => {
  const conversationData = useConversationData()
  const initialState = isIntegerBool
    ? Number(conversationData[field]) === 1
      ? 1
      : 0
    : Boolean(conversationData[field])
  const [state, setState] = useState(initialState)
  const dispatch = useDispatch()

  const handleBoolValueChange = (field) => {
    const val = !state
    setState(val)
    dispatch(handleConversationDataUpdate(conversationData, field, val))
  }

  const transformBoolToInt = (value) => {
    return value ? 1 : 0
  }

  const handleIntegerBoolValueChange = (field) => {
    const val = transformBoolToInt(!state)
    setState(val)
    dispatch(handleConversationDataUpdate(conversationData, field, val))
  }

  return (
    <Flex sx={{ alignItems: 'flex-start', mb: [3] }}>
      <Box sx={{ flexShrink: 0, position: 'relative', top: -0.5 }}>
        <input
          type="checkbox"
          label={label}
          data-testid={field}
          checked={
            isIntegerBool ? Number(conversationData[field]) === 1 : Boolean(conversationData[field])
          }
          onChange={
            isIntegerBool
              ? () => handleIntegerBoolValueChange(field)
              : () => handleBoolValueChange(field)
          }
        />
      </Box>
      <Box
        sx={{
          ml: [2],
          flex: '1 1 auto',
          maxWidth: ['100%', '100%', '35em'],
          wordWrap: 'break-word',
          overflowWrap: 'break-word'
        }}>
        <Text>{children}</Text>
      </Box>
    </Flex>
  )
}
CheckboxField.propTypes = {
  field: PropTypes.string.isRequired,
  label: PropTypes.string,
  children: PropTypes.string.isRequired,
  isIntegerBool: PropTypes.bool
}
