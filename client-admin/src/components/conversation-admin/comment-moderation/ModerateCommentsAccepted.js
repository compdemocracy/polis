// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { useSelector } from 'react-redux'
import PropTypes from 'prop-types'
import ModerateCommentsList from './ModerateCommentsList'

const ModerateCommentsAccepted = ({ pagination, onPageChange, loading = false }) => {
  const { accepted_comments } = useSelector((state) => state.mod_comments_accepted)

  return (
    <ModerateCommentsList
      comments={accepted_comments}
      pagination={pagination}
      onPageChange={onPageChange}
      loading={loading}
      variant="accepted"
      loadingText="Loading accepted comments..."
      testId="approved-comments"
    />
  )
}

ModerateCommentsAccepted.propTypes = {
  pagination: PropTypes.shape({
    limit: PropTypes.number.isRequired,
    offset: PropTypes.number.isRequired,
    total: PropTypes.number.isRequired,
    hasMore: PropTypes.bool.isRequired
  }),
  onPageChange: PropTypes.func.isRequired,
  loading: PropTypes.bool
}

export default ModerateCommentsAccepted
