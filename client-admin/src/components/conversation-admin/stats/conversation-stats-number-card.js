// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React from 'react'
import { Text, Flex } from 'theme-ui'

class NumberCard extends React.Component {
  render() {
    return (
      <Flex sx={{ my: [2] }}>
        <Text sx={{ fontWeight: 700, mr: [2] }}>{this.props.datum}</Text>
        <Text> {this.props.subheading} </Text>
      </Flex>
    )
  }
}

export default NumberCard
