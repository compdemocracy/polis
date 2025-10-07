// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { Box, Heading } from 'theme-ui'

import Spinner from '../framework/Spinner'
import { useUser } from '../../util/auth'

const Account = () => {
  const userContext = useUser()

  const buildAccountMarkup = () => {
    return (
      <>
        <Box>
          <Heading
            as="h3"
            sx={{
              fontSize: [3, null, 4],
              lineHeight: 'body',
              mb: [3, null, 4]
            }}>
            Account
          </Heading>
          <p>Hi {userContext?.user?.hname?.split(' ')[0]}!</p>
          <Box>
            <p>{userContext?.user?.hname}</p>
            <p>{userContext?.user?.email}</p>
          </Box>
        </Box>
      </>
    )
  }

  return <div>{userContext?.user?.hname ? buildAccountMarkup() : <Spinner />}</div>
}

export default Account
