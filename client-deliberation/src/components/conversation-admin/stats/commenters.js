// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

/** @jsx jsx */

import React from 'react'
import { jsx, Box, Heading } from 'theme-ui'
import { VictoryChart, VictoryArea } from 'victory'
import victoryTheme from './victoryTheme'

class Commenters extends React.Component {
  render() {
    const { size, firstCommentTimes } = this.props
    if (firstCommentTimes.length <= 1) return null /* handle seed commenter */
    return (
      <Box sx={{ mt: [5] }}>
        <Heading
          as="h6"
          sx={{
            fontSize: [2, null, 3],
            lineHeight: 'body',
            my: [2]
          }}>
          Commenters over time, by time of first comment
        </Heading>
        <VictoryChart
          theme={victoryTheme}
          height={size}
          width={size}
          domainPadding={{ x: 0, y: [0, 20] }}
          scale={{ x: 'time' }}>
          <VictoryArea
            style={{ data: { fill: '#03a9f4' } }}
            data={firstCommentTimes.map((d, i) => {
              return { x: new Date(d), y: i }
            })}
          />
        </VictoryChart>
      </Box>
    )
  }
}

export default Commenters
