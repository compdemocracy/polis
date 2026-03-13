;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.meta.microscope
  (:require
   [clojure.tools.logging :as log]
   [polismath.components.postgres :as db]
   [polismath.conv-man :as cm]
   [polismath.utils :as utils]))
;
;
;
;(defrecord Microscope [postgres mongo conversation-manager config]
;  component/Lifecycle
;  ;; Don't know if there will really be any important state here;
;  ;; Seems like an anti-pattern and like we should just be operating on some base-system...
;  (start [this] this)
;  (stop [this] this))

;; Should really just move this to the conv-man namespace; this namespace can go for now

(defn recompute
  [{:as system :keys [conversation-manager postgres]} & {:keys [zid zinvite] :as args}]
  (assert (utils/xor zid zinvite))
  (let [zid        (or zid (db/get-zid-from-zinvite (:postgres system) zinvite))
        new-votes  (db/conv-poll postgres zid 0)]
    (log/info "Running a recompute on zid:" zid "(zinvite:" zinvite ")")
    (cm/queue-message-batch! conversation-manager :votes zid new-votes)))

(comment
  (require '[polismath.runner :as runner :refer [system]])
  (db/get-zid-from-zinvite (:postgres system) "7scufp")
  (recompute system :zinvite "7scufp")
  :end-example-comment)

