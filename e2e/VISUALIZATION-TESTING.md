# Visualization Test Requirements

## Critical Requirements for E2E Visualization Tests

**Note**: For general Cypress patterns including window context isolation, see [BEST-PRACTICES.md](./BEST-PRACTICES.md).

### 1. Visualization Must Be Explicitly Enabled

Visualization (`vis_type: 1`) must be enabled **after** conversation creation using the PUT endpoint:

```javascript
// Get current conversation data
cy.request({
  method: 'GET',
  url: `/api/v3/conversations?conversation_id=${conversationId}`,
  headers: { Authorization: `Bearer ${token}` },
}).then((response) => {
  const conversationData = response.body

  // Update with visualization enabled
  return cy.request({
    method: 'PUT',
    url: '/api/v3/conversations',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: {
      ...conversationData,
      vis_type: 1, // Enable visualization
    },
  })
})
```

**Important**: Setting `vis_type: 1` during conversation creation (POST) does NOT persist!

### 2. Auth Isolation is Critical

Admin authentication from setup can contaminate participant sessions, causing all participants to be counted as the admin (pid=0).

**Solution**: Use the window context isolation pattern described in [BEST-PRACTICES.md](./BEST-PRACTICES.md#window-context-isolation).

```javascript
// ✅ Correct pattern for visualization tests
it('shows visualization with 7 participants', () => {
  let conversationId

  // Phase 1: Admin setup (isolated window context)
  cy.window().then(() => {
    // Get admin token and create conversation
    conversationId = setupConversation()
  })

  // Phase 2: Create participants (clean context)
  cy.then(() => {
    // Each participant gets unique PID instead of admin PID=0
    for (let i = 0; i < 7; i++) {
      cy.visit(`/${conversationId}?xid=participant-${i}`)
      cy.get('#agreeButton').click()
    }
  })
})
```

### 3. Minimum Participant Requirements

- Visualization requires **7+ distinct participants** who have voted
- Each participant must be truly distinct (different XIDs or anonymous sessions)
- Admin votes during setup count as participant 0

### 4. Math Service Dependency

- After creating participants, trigger math update: `/api/v3/mathUpdate?conversation_id=${conversationId}`
- Wait 5+ seconds for math computation
- The math service may be flaky - tests may fail intermittently

### 5. Visualization Elements to Check

```javascript
// Visible when visualization is ready:
cy.get('#vis_section').should('be.visible')
cy.get('#vis_help_label').should('be.visible')

// Hidden when visualization is ready:
cy.get('#vis_not_yet_label').should('not.be.visible')
```

## Example Working Pattern

See `visualization-clean.cy.js` for a complete working example that:

1. Creates conversation via API
2. Explicitly enables visualization
3. Creates 7 distinct participants without auth contamination
4. Triggers math computation
5. Verifies visualization appears
