import React, { useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Box, Flex, Text } from 'theme-ui'
import PropTypes from 'prop-types'

import { handleZidMetadataUpdate } from '../../actions'

export const CheckboxField = ({
  field,
  label = '',
  children,
  isIntegerBool = false
}) => {
  const { zid_metadata } = useSelector(state => state.zid_metadata)
  const [state, setState] = useState(zid_metadata[field])
  const dispatch = useDispatch()

  const handleBoolValueChange = field => {
    const val = !state
    setState(val)
    dispatch(handleZidMetadataUpdate(zid_metadata, field, val))
  }

  const transformBoolToInt = value => {
    return value ? 1 : 0
  }

  const handleIntegerBoolValueChange = field => {
    const val = transformBoolToInt(!state)
    setState(val)
    dispatch(handleZidMetadataUpdate(zid_metadata, field, val))
  }

  return (
    <Flex sx={{ alignItems: 'flex-start', mb: [3] }}>
      <Box sx={{ flexShrink: 0, position: 'relative', top: -0.5 }}>
        <input
          type="checkbox"
          label={label}
          data-test-id={field}
          checked={
            isIntegerBool ? zid_metadata[field] === 1 : zid_metadata[field]
          }
          onChange={
            isIntegerBool
              ? () => handleIntegerBoolValueChange(field)
              : () => handleBoolValueChange(field)
          }
        />
      </Box>
      <Box sx={{ ml: [2], flexShrink: 0, maxWidth: '35em' }}>
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
