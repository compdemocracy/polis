;; Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.darwin.email
  (:require [polismath.components.env :as env]
            [clj-http.client :as client]))

(defn send-email!
  "Simple email helper for sending email via mailgun based on config, from, to, subject, text and optionally html"
  ([config {:keys [from to subject text html] :as params}]
   (let [{:keys [api-key url]} (:email config)]
     (try
       (client/post url
                    {:basic-auth ["api" api-key]
                     :query-params params})
       (catch Exception e (.printStackTrace e)))))
  ([config from to subject text html] (send-email! config {:from from :to to :subject subject :text text :html html}))
  ([config from to subject text] (send-email! config {:from from :to to :subject subject :text text})))

