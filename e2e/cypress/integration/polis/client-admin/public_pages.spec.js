describe('Public pages', () => {
  it('renders Privacy Policy', function () {
    cy.visit('/privacy')
    cy.get('h1').should('contain', 'Privacy Policy')
  })

  it('renders Terms of Use', function () {
    cy.visit('/tos')
    cy.get('h1').should('contain', 'Terms of')
  })
})
