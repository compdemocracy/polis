// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

export const headerHeight = 30
const regular = 300
const bold = 500
const brand = '#03a9f4'

export const s = {}

/*************************
        General
*************************/

s.brandColor = brand

s.container = {
  minHeight: '100%',
  margin: 0
}

s.dangerButton = {
  borderRadius: 3,
  padding: '10px 20px',
  color: 'white',
  backgroundColor: '#F1360A',
  border: 'none',
  cursor: 'pointer'
}

s.primaryButton = {
  borderRadius: 3,
  padding: '10px 20px',
  color: 'white',
  backgroundColor: brand,
  border: 'none',
  cursor: 'pointer',
  textDecoration: 'none'
}

s.secondaryButton = {
  borderRadius: 3,
  padding: '10px 20px',
  color: 'white',
  backgroundColor: '#444444',
  border: 'none',
  cursor: 'pointer',
  textDecoration: 'none'
}
/*************************
        Sidebar
*************************/

s.sidebar = {
  width: 256
}

s.sidebarLinks = {
  backgroundColor: 'white',
  height: '100%',
  padding: 20
}

s.sidebarLink = {
  display: 'block',
  color: 'black',
  textDecoration: 'none',
  cursor: 'pointer',
  marginBottom: 20
}

/*************************
      Conversations
*************************/

s.conversation = {
  ':hover': {
    backgroundColor: 'rgb(245,245,245)'
  },
  padding: '10px 20px',
  cursor: 'pointer'
}

s.statNumber = {
  fontSize: 12,
  margin: 0
}

s.topic = {
  fontWeight: bold,
  margin: '5px 0px 5px 0px'
}

s.description = {
  fontWeight: regular,
  fontStyle: 'italic',
  margin: 0
}

s.parentUrl = {
  fontSize: 12,
  marginTop: 10
}

/*************************
      Account
*************************/

s.accountContainer = {
  padding: 20
}

s.accountSection = {
  marginBottom: 40
}

s.accountSectionHeader = {
  fontWeight: bold
}
