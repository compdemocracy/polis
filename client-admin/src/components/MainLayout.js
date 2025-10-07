// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { Flex, Box } from 'theme-ui'
import { Outlet, Link } from 'react-router'
import InteriorHeader from './InteriorHeader'

const MainLayout = () => {
  return (
    <InteriorHeader>
      <Flex
        sx={{
          flexDirection: ['column', 'column', 'row'],
          width: '100%',
          maxWidth: '100vw',
          overflowX: 'hidden'
        }}>
        {/* Navigation Sidebar - stacks vertically on mobile/tablet, sidebar on desktop */}
        <Box
          sx={{
            py: [2, 2, 4],
            px: [2, 3, 4],
            flex: '0 0 auto',
            width: ['100%', '100%', 'auto'],
            borderBottom: ['2px solid', '2px solid', 'none'],
            borderBottomColor: ['secondary', 'secondary', 'transparent'],
            display: 'flex',
            flexDirection: ['row', 'row', 'column'],
            gap: [2, 3, 0],
            flexWrap: ['wrap', 'wrap', 'nowrap'],
            justifyContent: ['center', 'center', 'flex-start'],
            minWidth: 0
          }}>
          <Box sx={{ mb: [0, 0, 3] }}>
            <Link sx={{ variant: 'links.nav', whiteSpace: 'nowrap' }} to={`/`}>
              Conversations
            </Link>
          </Box>
          <Box sx={{ mb: [0, 0, 3] }}>
            <Link sx={{ variant: 'links.nav', whiteSpace: 'nowrap' }} to={`/integrate`}>
              Integrate
            </Link>
          </Box>
          <Box sx={{ mb: [0, 0, 3] }}>
            <Link sx={{ variant: 'links.nav', whiteSpace: 'nowrap' }} to={`/account`}>
              Account
            </Link>
          </Box>
        </Box>
        {/* Main Content Area */}
        <Box
          sx={{
            p: [2, 3, 4],
            flex: '1 1 auto',
            maxWidth: ['100%', '100%', '65em'],
            width: '100%',
            minWidth: 0,
            mx: [0, 0, 4],
            overflowX: 'auto', // Allow horizontal scroll if content needs it
            wordWrap: 'break-word',
            overflowWrap: 'break-word'
          }}>
          <Outlet />
        </Box>
      </Flex>
    </InteriorHeader>
  )
}

export default MainLayout
