describe('Facebook auth', () => {

  before(function () {
    cy.createConvo('moderator').then(() => {
      cy.seedComment("This is the first comment", this.convoId)
    })

    // Ensure social login is enabled for all participant interactions.
    cy.get('input[data-test-id="auth_needed_to_write"]').check()
    cy.get('input[data-test-id="auth_needed_to_vote"]').check()

    // Ensure Facebook login button is present
    cy.get('input[data-test-id="auth_opt_fb"]').check()

    // Moderator will have implicitly voted on seed comment, so log out.
    // See: https://github.com/pol-is/polisServer/issues/373
    cy.logout()
  })

  it('logs in when trying to vote', function () {
    cy.visit(`/${this.convoId}`)

    const cookieName = 'token2'
    const socialLoginOptions = {
      username: 'nnjjfonwbp_1607230783@tfbnw.net',
      password: 'wickerbasket',
      loginUrl: `${Cypress.config().baseUrl}/${this.convoId}`,
      preLoginSelector: 'button#agreeButton',
      loginSelector: 'button#facebookButtonVoteView',
      postLoginSelector: 'button#subscribeBtn',
      isPopup: true,
      args: ['--ignore-certificate-errors']
    }

    return cy.task('FacebookSocialLogin', socialLoginOptions).then(({cookies}) => {
      cy.clearCookies()

      console.log(cookies)

      const cookie = cookies.filter(cookie => cookie.name === cookieName).pop()
      if (cookie) {
        cy.setCookie(cookie.name, cookie.value, {
          domain: cookie.domain,
          expiry: cookie.expires,
          httpOnly: cookie.httpOnly,
          path: cookie.path,
          secure: cookie.secure
        })

        Cypress.Cookies.defaults({
          preserve: cookieName
        })
      }
    })
  })
})