-- Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

alter table conversations add column use_xid_whitelist BOOLEAN DEFAULT FALSE;

CREATE TABLE xid_whitelist (
    owner INTEGER NOT NULL REFERENCES users(uid),
    xid TEXT NOT NULL, -- TODO add constraint to limit length
    created BIGINT DEFAULT now_as_millis(),
    UNIQUE (owner, xid)
);
CREATE INDEX xid_whitelist_owner_idx ON xid_whitelist USING btree (owner);

alter table participants_extended add column subscribe_email VARCHAR(256);