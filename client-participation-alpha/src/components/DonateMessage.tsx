import { useState, useEffect } from 'react'
import { jwtDecode } from 'jwt-decode'
import { _getOidcTokenFromStorage } from '../lib/auth'

export default function DonateMessage() {
  const [isLoading, setIsLoading] = useState(true)
  const [isDelphiEnabled, setIsDelphiEnabled] = useState(false)

  useEffect(() => {
    const checkAccessTokenClaim = async () => {
      try {
        const accessToken = await _getOidcTokenFromStorage(window.localStorage)

        if (accessToken) {
          const decodedToken = jwtDecode(accessToken)
          // @ts-expect-error t: dynamically accessing environment variable property on decoded token
          if (
            decodedToken &&
            decodedToken[`${import.meta.env.PUBLIC_AUTH_NAMESPACE}delphi_enabled`]
          ) {
            setIsDelphiEnabled(true)
          }
        }
      } catch (error) {
        console.error('Failed to check access token claim:', error)
      } finally {
        setIsLoading(false)
      }
    }

    checkAccessTokenClaim()
  }, [])

  if (isLoading) {
    return null
  }

  return isDelphiEnabled ? null : (
    <>
      <br />
      <div>
        <i>
          Polis is powered by support from people like you. Contribute <a href="/donate">here</a>.
        </i>
      </div>
    </>
  )
}
