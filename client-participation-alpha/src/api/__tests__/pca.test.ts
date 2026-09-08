import { fetchPCAData, PCA2_WIRE_FIELDS, PCA_VISUALIZATION_KEYS } from '../pca'
import PolisNet from '../../lib/net'

jest.mock('../../lib/net')

const mockedPolisNet = PolisNet as jest.Mocked<typeof PolisNet>

/**
 * The 17 field names of the decoded pca2 body, transcribed from the `required`
 * list of cost-reduction/04-plans/p032-slice1/decoded-empty.schema.json (a
 * closed Draft-07 schema: `additionalProperties: false`), in the wire order
 * quoted in cost-reduction/04-plans/P-032-slice1-pca2.md.
 *
 * Duplicated literally here rather than imported so the test fails if the
 * production list drifts from the contract.
 */
const CONTRACT_FIELDS = [
  'group-clusters',
  'base-clusters',
  'group-votes',
  'group-aware-consensus',
  'user-vote-counts',
  'in-conv',
  'n-cmts',
  'pca',
  'tids',
  'n',
  'repness',
  'consensus',
  'votes-base',
  'lastModTimestamp',
  'lastVoteTimestamp',
  'comment-priorities',
  'math_tick'
]

describe('pca2 wire field names', () => {
  it('PCA2_WIRE_FIELDS matches the P-032 slice-1 contract exactly, in wire order', () => {
    expect([...PCA2_WIRE_FIELDS]).toEqual(CONTRACT_FIELDS)
    expect(PCA2_WIRE_FIELDS).toHaveLength(17)
  })

  it('requested keys are all real wire field names', () => {
    // The server picks with `_.pick` and silently drops unknown keys, so an
    // unknown key here is not an error at runtime — it is a field that never
    // arrives. This is the check that caught `mathTick`.
    for (const key of PCA_VISUALIZATION_KEYS) {
      expect(CONTRACT_FIELDS).toContain(key)
    }
  })

  it('requests the tick under its wire name, not a camelCased one', () => {
    expect(PCA_VISUALIZATION_KEYS).toContain('math_tick')
    expect(PCA_VISUALIZATION_KEYS).not.toContain('mathTick')
  })

  it('requests no key twice', () => {
    expect(new Set(PCA_VISUALIZATION_KEYS).size).toBe(PCA_VISUALIZATION_KEYS.length)
  })
})

describe('fetchPCAData', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('sends no keys param in full mode', async () => {
    mockedPolisNet.polisGet.mockResolvedValue({})

    await fetchPCAData('conv123')

    expect(mockedPolisNet.polisGet).toHaveBeenCalledWith('/math/pca2', {
      conversation_id: 'conv123'
    })
  })

  it('sends the requested keys as a comma list in subset mode', async () => {
    mockedPolisNet.polisGet.mockResolvedValue({})

    await fetchPCAData('conv123', PCA_VISUALIZATION_KEYS)

    expect(mockedPolisNet.polisGet).toHaveBeenCalledWith('/math/pca2', {
      conversation_id: 'conv123',
      keys: 'base-clusters,group-clusters,group-aware-consensus,group-votes,repness,math_tick'
    })
  })
})
