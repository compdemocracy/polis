// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

const setupBasedOnCurrentDate = () => {
  var d = new Date()
  var month = d.getMonth() + 1 || 12
  var year = d.getUTCFullYear() || 2030
  var dayOfMonth = d.getDate() || 31
  var tzKey = d.getTimezoneOffset() || 480
  tzKey = tzKey / 60
  var tzWasNegative = tzKey < 0
  tzKey = Math.abs(tzKey)
  if (tzKey < 10) {
    tzKey = '0' + tzKey
  }
  if (tzWasNegative) {
    tzKey = 'UTC+' + tzKey + '00'
  } else {
    tzKey = 'UTC-' + tzKey + '00'
  }

  var months = [
    { num: 1, name: 'january' },
    { num: 2, name: 'february' },
    { num: 3, name: 'march' },
    { num: 4, name: 'april' },
    { num: 5, name: 'may' },
    { num: 6, name: 'june' },
    { num: 7, name: 'july' },
    { num: 8, name: 'august' },
    { num: 9, name: 'september' },
    { num: 10, name: 'october' },
    { num: 11, name: 'november' },
    { num: 12, name: 'december' }
  ].map(function (m) {
    if (m.num === month) {
      m.selected = true
    }
    return m
  })

  var years = []
  for (var i = 2012; i <= year; i++) {
    years.push({ name: i, selected: i === year })
  }

  var days = []
  for (var day = 1; day <= 31; day++) {
    days.push({ name: day, selected: day === dayOfMonth })
  }
  var tzs = [
    'UTC-1200',
    'UTC-1100',
    'UTC-1000',
    'UTC-0900',
    'UTC-0800',
    'UTC-0700',
    'UTC-0600',
    'UTC-0500',
    'UTC-0430',
    'UTC-0400',
    'UTC-0330',
    'UTC-0300',
    'UTC-0200',
    'UTC-0100',
    'UTC+0000',
    'UTC+0100',
    'UTC+0200',
    'UTC+0300',
    'UTC+0330',
    'UTC+0400',
    'UTC+0430',
    'UTC+0500',
    'UTC+0530',
    'UTC+0600',
    'UTC+0630',
    'UTC+0700',
    'UTC+0800',
    'UTC+0830',
    'UTC+0900',
    'UTC+0930',
    'UTC+1000',
    'UTC+1030',
    'UTC+1100',
    'UTC+1200',
    'UTC+1245',
    'UTC+1300',
    'UTC+1400'
  ].map(function (s) {
    return {
      name: s,
      selected: s === tzKey
    }
  })

  return {
    format: 'csv',
    months: months,
    years: years,
    days: days,
    tzs: tzs
  }
}

export default setupBasedOnCurrentDate
