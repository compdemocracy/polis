;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns conv-man-tests
  (:use polismath.utils
        test-helpers)
  (:require [clojure.test :refer :all]
            ;[clojure.test.check :as tc]
            ;[clojure.test.check.generators :as gen]
            ;[clojure.test.check.properties :as prop]
            [clojure.core.async :as async]
            [clojure.tools.logging :as log]
            [polismath.math.conversation :as conv]
            [polismath.math.named-matrix :as nm]
            [polismath.conv-man :as conv-man]
            [polismath.system :as system]
            [polismath.components.config :as config]))



;(gen/sample gen/->Generator

;(let [random-matrix (gen/vector (partial gen/vector (ge

;; Should make this generative
(deftest integration-test
  (testing "of some votes"
    (let [messages [{:vote  0 :pid 0 :tid 0 :zid 0 :created 9000}
                    {:vote  1 :pid 1 :tid 1 :zid 0 :created 9003}
                    {:vote -1 :pid 2 :tid 0 :zid 0 :created 9005}
                    {:vote -1 :pid 1 :tid 2 :zid 0 :created 9009}]
          config {:math-env :test
                  :poller {:initial-polling-timestamp (System/currentTimeMillis)}}]
      (testing "in a new conv"
        (let [system (system/create-and-run-base-system! config)
              conv-man (:conversation-manager system)
              result-chan (async/chan)
              ;; TODO Need to hook this up
              error-chan (async/chan)]
          ;; Since the conversation manager is asynchronous, we'll create a channel where we'll put the
          ;; results of the conversation update.
          ;; Should add an error listener as well... so we can catch information there as well
          (conv-man/add-listener! conv-man (fn [conv] (async/>!! result-chan conv)))
          (conv-man/queue-message-batch! conv-man :votes 0 messages)
          ;; For right now, let's just use a timeout to check for whether the conversation updated; Really
          ;; need to fix this... XXX
          (is (if-let [conv (first (async/alts!! [result-chan (async/timeout 20000)]))]
                (let [matrix (-> conv :rating-mat nm/get-matrix)]
                  (is (m=? [[0   nil nil]
                            [nil  1  -1]
                            [-1  nil nil]]
                           matrix)
                      "The conversation does not have the correct rating matrix post conversation update")
                  (not (nil? conv)))
                ;; There's a problem; the timeout was hit
                (do (log/error "There was an update timeout in integration-test; check log...")
                    (/ 1 0)))))))))


(defn -main []
  (run-tests 'conv-man-tests))


