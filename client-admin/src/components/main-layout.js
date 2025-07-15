// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { Flex, Box } from 'theme-ui'
import { Outlet, Link } from 'react-router'
import InteriorHeader from './interior-header'

const MainLayout = () => {
  return (
    <InteriorHeader>
      <Flex>
        <Box sx={{ mr: [5], p: [4], flex: '0 0 auto' }}>
          <Box sx={{ mb: [3] }}>
            <Link sx={{ variant: 'links.nav' }} to={`/`}>
              Conversations
            </Link>
          </Box>
          <Box sx={{ mb: [3] }}>
            <Link sx={{ variant: 'links.nav' }} to={`/integrate`}>
              Integrate
            </Link>
          </Box>
          <Box sx={{ mb: [3] }}>
            <Link sx={{ variant: 'links.nav' }} to={`/account`}>
              Account
            </Link>
          </Box>
        </Box>
        <Box
          sx={{
            p: [4],
            flex: '0 0 auto',
            maxWidth: '35em',
            mx: [4]
          }}>
          <Outlet />
        </Box>
      </Flex>
    </InteriorHeader>
  )
}

export default MainLayout
