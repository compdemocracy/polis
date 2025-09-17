// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

const helpers = {}

helpers.getAdminUids = () => {
  // Derive admin UID list from env as produced by webpack DefinePlugin JSON.stringify
  const adminUidsRaw = process.env.ADMIN_UIDS
  if (typeof adminUidsRaw === 'string' && adminUidsRaw.trim() !== '') {
    try {
      const parsed = JSON.parse(adminUidsRaw)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // Ignore invalid JSON
    }
  }
  return []
}

helpers.shouldShowPermissionsError = (props) => {
  const isSuperAdminUser = helpers.getAdminUids().indexOf(props.user?.user?.uid) !== -1
  if (isSuperAdminUser) return false
  const hasMetadata = !!props.zid_metadata

  // Check if metadata is an empty object (not loaded yet)
  const isMetadataEmpty = hasMetadata && Object.keys(props.zid_metadata).length === 0

  const isOwner = props.zid_metadata?.is_owner || false
  const isMod = props.zid_metadata?.is_mod || false

  // Don't show error if metadata hasn't loaded yet or if loading
  if (props.loading || isMetadataEmpty) {
    return false
  }

  const shouldShow = hasMetadata && !isOwner && !isMod

  return shouldShow
}

export default helpers
