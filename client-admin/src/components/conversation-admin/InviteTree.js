import { useEffect, useMemo, useState } from 'react'
import { useSelector } from 'react-redux'
import { Heading, Box, Text, Button } from 'theme-ui'
import { useParams } from 'react-router'
import PolisNet from '../../util/net'
import Spinner from '../framework/spinner'

const InviteTree = () => {
  const params = useParams()
  const zid_metadata = useSelector((state) => state.zid_metadata)
  const enabled = Boolean(zid_metadata?.zid_metadata?.treevite_enabled)
  const conversationId = useMemo(
    () => zid_metadata?.zid_metadata?.conversation_id || params.conversation_id,
    [zid_metadata?.zid_metadata?.conversation_id, params.conversation_id]
  )

  const [waves, setWaves] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const [invitesPerUser, setInvitesPerUser] = useState('')
  const [ownerInvites, setOwnerInvites] = useState('')
  const [parentWaveOverride, setParentWaveOverride] = useState('') // empty string => default (latest)
  const [creating, setCreating] = useState(false)
  const [createdSummary, setCreatedSummary] = useState(null)

  const hasWaves = waves && waves.length > 0

  const loadWaves = async () => {
    if (!conversationId) return
    setLoading(true)
    setError(null)
    try {
      const res = await PolisNet.polisGet('/api/v3/treevite/waves', {
        conversation_id: conversationId
      })
      setWaves(Array.isArray(res) ? res : [])
    } catch (e) {
      setError(e?.responseText || e?.message || 'Failed to load waves')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (enabled) {
      loadWaves()
    }
  }, [enabled, conversationId])

  const canCreate = useMemo(() => {
    const ipu = Number(invitesPerUser || 0)
    const oi = Number(ownerInvites || 0)
    return ipu > 0 || oi > 0
  }, [invitesPerUser, ownerInvites])

  const handleCreateWave = async () => {
    if (!conversationId || !canCreate) return
    setCreating(true)
    setError(null)
    setCreatedSummary(null)
    try {
      const body = {
        conversation_id: conversationId
      }
      if (invitesPerUser !== '') body.invites_per_user = Number(invitesPerUser)
      if (ownerInvites !== '') body.owner_invites = Number(ownerInvites)
      if (parentWaveOverride !== '') body.parent_wave = Number(parentWaveOverride)

      const res = await PolisNet.polisPost('/api/v3/treevite/waves', body)
      setCreatedSummary({ wave: res?.wave, invites_created: res?.invites_created })
      // Refresh list and clear only the owner/ipu fields (keep parent selector as-is)
      await loadWaves()
    } catch (e) {
      setError(e?.responseText || e?.message || 'Failed to create wave')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Box>
      <Heading
        as="h3"
        sx={{
          fontSize: [3, null, 4],
          lineHeight: 'body',
          mb: [3, null, 4]
        }}>
        Invite Tree
      </Heading>

      {!enabled ? (
        <Text>
          Invite Tree is not enabled. To use this feature, enable Invite Tree in the Conversation
          Configure options.
        </Text>
      ) : (
        <>
          <Box sx={{ mb: [3] }}>
            <Text sx={{ display: 'block', mb: [2] }}>
              This conversation is invite only. Participants must enter a valid invite code to vote
              or comment.
            </Text>
          </Box>

          <Heading
            as="h6"
            sx={{
              fontSize: [1, null, 2],
              lineHeight: 'body',
              my: [3, null, 3]
            }}>
            Waves
          </Heading>
          {loading ? (
            <Spinner />
          ) : error ? (
            <Text sx={{ color: 'red' }}>{String(error)}</Text>
          ) : hasWaves ? (
            <Box as="ul" sx={{ pl: [3], mb: [3] }}>
              {waves.map((w) => (
                <li key={w.id}>
                  <Text>
                    Wave {w.wave} (parent {w.parent_wave || 0}) — ipu {w.invites_per_user || 0},
                    owner {w.owner_invites || 0}, size {w.size || 0}
                  </Text>
                </li>
              ))}
            </Box>
          ) : (
            <Text>No waves yet. Create the initial wave below.</Text>
          )}

          <Heading
            as="h6"
            sx={{
              fontSize: [1, null, 2],
              lineHeight: 'body',
              my: [3, null, 3]
            }}>
            Create Next Wave
          </Heading>

          <Box sx={{ mb: [3] }}>
            <Text sx={{ display: 'block', mb: [2] }}>
              Invites per user (granted to each participant in the parent wave)
            </Text>
            <input
              type="number"
              min={0}
              max={1000}
              value={invitesPerUser}
              onChange={(e) => setInvitesPerUser(e.target.value)}
            />
          </Box>

          <Box sx={{ mb: [3] }}>
            <Text sx={{ display: 'block', mb: [2] }}>
              Owner invites (additional invites for you to distribute this wave)
            </Text>
            <input
              type="number"
              min={0}
              max={1000}
              value={ownerInvites}
              onChange={(e) => setOwnerInvites(e.target.value)}
            />
          </Box>

          <Box sx={{ mb: [3] }}>
            <Text sx={{ display: 'block', mb: [2] }}>
              Parent wave (optional override). Default is latest existing wave; use 0 for root.
            </Text>
            <select
              value={parentWaveOverride}
              onChange={(e) => setParentWaveOverride(e.target.value)}>
              <option value="">Latest (default)</option>
              <option value="0">Root (0)</option>
              {waves.map((w) => (
                <option key={w.id} value={w.wave}>{`Wave ${w.wave}`}</option>
              ))}
            </select>
          </Box>

          <Box sx={{ mb: [3], mt: [3] }}>
            <Button sx={{ mt: [2] }} onClick={handleCreateWave} disabled={!canCreate || creating}>
              {creating ? 'Creating…' : 'Create Wave'}
            </Button>
          </Box>

          {createdSummary ? (
            <Text>
              Created wave {createdSummary.wave}. Invites created: {createdSummary.invites_created}
            </Text>
          ) : null}
        </>
      )}
    </Box>
  )
}

export default InviteTree
