import { Box, Text, Button, Flex, Heading } from 'theme-ui'
import { useState, useRef, useCallback } from 'react'
import PropTypes from 'prop-types'

/**
 * Parses file content to extract XIDs.
 * Supports CSV (with or without headers) and plain text (one per line).
 * @param {string} content - File content as text
 * @returns {string} - Newline-separated list of XIDs
 */
const parseFileContent = (content) => {
  if (!content || !content.trim()) {
    return ''
  }

  const lines = content.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length === 0) {
    return ''
  }

  // Check if first line looks like CSV headers (e.g., "pid,xid", "xid", "XID", etc.)
  const firstLine = lines[0].toLowerCase()
  const hasHeaders =
    firstLine.includes('xid') ||
    firstLine.includes('pid') ||
    (firstLine.includes(',') && !firstLine.match(/^\d+/))

  // If headers detected, skip first line
  const dataLines = hasHeaders ? lines.slice(1) : lines

  const xids = []
  for (const line of dataLines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue // Skip empty lines and comments

    // If CSV format, extract XID
    if (line.includes(',')) {
      // Split by comma, handling quoted values
      const parts = []
      let current = ''
      let inQuotes = false

      for (let i = 0; i < line.length; i++) {
        const char = line[i]
        if (char === '"') {
          if (inQuotes && line[i + 1] === '"') {
            // Escaped quote
            current += '"'
            i++
          } else {
            // Toggle quote state
            inQuotes = !inQuotes
          }
        } else if (char === ',' && !inQuotes) {
          parts.push(current.trim())
          current = ''
        } else {
          current += char
        }
      }
      parts.push(current.trim()) // Add last part

      // If we have pid,xid format, use second column; otherwise use first
      if (parts.length >= 2) {
        // If first column is empty or numeric (pid), use second column (xid)
        // Otherwise use first column (assuming it's xid without pid)
        const firstIsEmpty = !parts[0] || parts[0].trim() === ''
        const firstIsNumeric = /^\d+$/.test(parts[0])
        const xid = firstIsEmpty || firstIsNumeric ? parts[1] : parts[0]
        if (xid && xid.trim()) {
          xids.push(xid.trim())
        }
      } else if (parts.length === 1) {
        // Single column, use it
        if (parts[0] && parts[0].trim()) {
          xids.push(parts[0].trim())
        }
      }
    } else {
      // Plain text, one XID per line
      xids.push(trimmed)
    }
  }

  // Remove duplicates and return as newline-separated string
  const uniqueXids = Array.from(new Set(xids.filter((xid) => xid && typeof xid === 'string')))
  return uniqueXids.join('\n')
}

const UploadXidsModal = ({ isOpen, onClose, onUpload, conversationId }) => {
  const [xidsText, setXidsText] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [replaceAll, setReplaceAll] = useState(false)
  const fileInputRef = useRef(null)
  const textareaRef = useRef(null)

  const handleFileRead = useCallback((file) => {
    if (!file) return

    setIsProcessing(true)
    const reader = new FileReader()
    reader.onload = (event) => {
      try {
        const content = event.target.result
        if (typeof content !== 'string') {
          throw new Error('File content is not text')
        }
        const parsedXids = parseFileContent(content)
        // Ensure we always set a string
        if (typeof parsedXids !== 'string') {
          throw new Error('Parsing failed: expected string result')
        }
        setXidsText(parsedXids)
      } catch (error) {
        alert(`Error reading file: ${error.message}`)
      } finally {
        setIsProcessing(false)
      }
    }
    reader.onerror = () => {
      alert('Error reading file')
      setIsProcessing(false)
    }
    reader.readAsText(file)
  }, [])

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0]
    if (file) {
      handleFileRead(file)
    }
    // Reset input so same file can be selected again
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const file = e.dataTransfer.files?.[0]
    if (file) {
      handleFileRead(file)
    }
  }

  const handleUpload = () => {
    // Parse textarea content into array of XIDs
    const xids = xidsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    if (xids.length === 0) {
      alert('Please enter at least one XID')
      return
    }

    if (onUpload) {
      onUpload(xids, replaceAll)
    }
  }

  const handleClose = () => {
    setXidsText('')
    setIsDragging(false)
    setReplaceAll(false)
    onClose()
  }

  if (!isOpen) {
    return null
  }

  return (
    <Box
      sx={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: [3]
      }}
      onClick={handleClose}>
      <Box
        sx={{
          backgroundColor: 'background',
          borderRadius: 2,
          boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
          maxWidth: '600px',
          width: '100%',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}
        onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <Flex
          sx={{
            p: [3],
            borderBottom: '1px solid',
            borderColor: 'lightGray',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}>
          <Heading
            as="h3"
            sx={{
              fontSize: [3],
              lineHeight: 'body',
              m: 0
            }}>
            Upload XIDs
          </Heading>
          <Button variant="outline" size="small" onClick={handleClose}>
            ✕
          </Button>
        </Flex>

        {/* Content */}
        <Box sx={{ p: [3], overflow: 'auto', flex: 1 }}>
          <Text sx={{ mb: [3], color: 'text', fontSize: [1] }}>
            Upload a file or paste a list of XIDs to allow. Supports CSV files (with or without
            headers) and plain text files (one XID per line).
          </Text>

          {/* Drop zone */}
          <Box
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            sx={{
              border: '2px dashed',
              borderColor: isDragging ? 'primary' : 'mediumGray',
              borderRadius: 2,
              p: [3],
              mb: [3],
              backgroundColor: isDragging ? 'lightGray' : 'background',
              textAlign: 'center',
              cursor: 'pointer',
              transition: 'all 0.2s',
              '&:hover': {
                borderColor: 'primary',
                backgroundColor: 'lightGray'
              }
            }}
            onClick={() => fileInputRef.current?.click()}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.txt,.text"
              onChange={handleFileSelect}
              style={{ display: 'none' }}
            />
            {isProcessing ? (
              <Text sx={{ color: 'mediumGray' }}>Processing file...</Text>
            ) : (
              <>
                <Text sx={{ mb: [2], color: 'text', fontSize: [1] }}>
                  {isDragging ? 'Drop file here' : 'Click to browse or drag and drop file here'}
                </Text>
                <Text sx={{ color: 'mediumGray', fontSize: [0] }}>
                  Supports CSV and text files
                </Text>
              </>
            )}
          </Box>

          {/* Text input */}
          <Box sx={{ mb: [3] }}>
            <Text
              as="label"
              sx={{
                display: 'block',
                mb: [2],
                fontWeight: 'bold',
                fontSize: [1]
              }}>
              Allowed XIDs
            </Text>
            <Box
              as="textarea"
              ref={textareaRef}
              value={xidsText}
              onChange={(e) => setXidsText(e.target.value)}
              placeholder="Paste XIDs here, one per line, or upload a file above"
              sx={{
                fontFamily: 'mono',
                fontSize: [1],
                width: '100%',
                minHeight: '300px',
                maxHeight: '400px',
                resize: 'vertical',
                padding: [2],
                borderRadius: 2,
                border: '1px solid',
                borderColor: 'mediumGray',
                backgroundColor: 'background'
              }}
            />
          </Box>

          {/* Replace all checkbox */}
          <Flex sx={{ alignItems: 'flex-start', mb: [2] }}>
            <Box sx={{ flexShrink: 0, position: 'relative', top: -0.5 }}>
              <input
                type="checkbox"
                id="replaceAll"
                checked={replaceAll}
                onChange={(e) => setReplaceAll(e.target.checked)}
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
              <Text
                as="label"
                htmlFor="replaceAll"
                sx={{
                  cursor: 'pointer',
                  fontSize: [1]
                }}>
                Replace all existing XIDs
              </Text>
            </Box>
          </Flex>
        </Box>

        {/* Footer */}
        <Flex
          sx={{
            p: [3],
            borderTop: '1px solid',
            borderColor: 'lightGray',
            justifyContent: 'flex-end',
            gap: [2]
          }}>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleUpload} disabled={!xidsText.trim()}>
            Upload XIDs
          </Button>
        </Flex>
      </Box>
    </Box>
  )
}

UploadXidsModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onUpload: PropTypes.func.isRequired,
  conversationId: PropTypes.string
}

export default UploadXidsModal

