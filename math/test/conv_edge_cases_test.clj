;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns conv-edge-cases-test
  "Tests for edge cases in the conversation update pipeline that can cause
  crashes on large or evolving conversations."
  (:require [clojure.test :refer [deftest testing is]]
            [polismath.math.repness :as repness]
            [polismath.math.named-matrix :as nm]
            [polismath.math.conversation :as conversation]))


;; ============================================================================
;; Bug 1: conv-repness crashes with empty group-clusters
;;
;; When group-clusters is nil or empty, (apply map f []) returns a transducer
;; (function object) instead of a sequence. Downstream code that tries to
;; iterate over :stats gets:
;;   IllegalArgumentException: Don't know how to create ISeq from: clojure.core$map$fn__XXXX
;;
;; This happens in production when the k-smoother holds a stale smoothed-k
;; that no longer exists in group-clusterings (see Bug 2 below).
;; ============================================================================

(def test-rating-mat
  (nm/named-matrix
    [:p1 :p2 :p3 :p4]
    [:c1 :c2 :c3]
    [[-1  1  0]
     [ 1 -1  1]
     [-1 -1  0]
     [ 1  1 -1]]))

(def test-base-clusters
  [{:id :b1 :members [:p1 :p2]}
   {:id :b2 :members [:p3 :p4]}])


(deftest conv-repness-with-empty-group-clusters
  (testing "conv-repness throws an informative error when group-clusters is empty"
    ;; Without the guard, (apply map f []) silently returns a transducer that
    ;; crashes downstream with a cryptic "Don't know how to create ISeq" error.
    ;; The guard throws immediately with a message pointing to the root cause.
    (is (thrown-with-msg? IllegalArgumentException
                          #"group-clusters is nil or empty"
                          (repness/conv-repness test-rating-mat [] test-base-clusters))))

  (testing "conv-repness throws an informative error when group-clusters is nil"
    (is (thrown-with-msg? IllegalArgumentException
                          #"group-clusters is nil or empty"
                          (repness/conv-repness test-rating-mat nil test-base-clusters)))))


;; ============================================================================
;; Bug 2: stale smoothed-k in group-k-smoother
;;
;; The k-smoother preserves the old smoothed-k for :group-k-buffer iterations
;; to dampen oscillation. But it doesn't check whether the old k still exists
;; in the current group-clusterings. When the number of non-empty base-clusters
;; drops (e.g. due to PCA rotation after a batch of new votes), the k-range
;; shrinks and (get group-clusterings old-smoothed-k) returns nil.
;;
;; We test this by feeding the smoother a conv with a previous smoothed-k=5
;; and group-clusterings that only contain k=2,3.
;; ============================================================================

(deftest stale-smoothed-k-is-clamped-to-available-group-clusters
  (testing "smoothed-k is clamped to an available range so group-clusters stays non-nil"
    ;; Simulate: previous iteration had smoothed-k=5, but current base-cluster
    ;; count only supports k=2,3
    (let [;; Minimal group clusterings for k=2 and k=3
          dummy-clustering-k2 [{:id 0 :members [:b1]} {:id 1 :members [:b2]}]
          dummy-clustering-k3 [{:id 0 :members [:b1]} {:id 1 :members [:b2]} {:id 2 :members []}]
          group-clusterings {2 dummy-clustering-k2
                             3 dummy-clustering-k3}
          ;; Old smoother state with smoothed-k=5 (stale!)
          old-smoother {:last-k 5 :last-k-count 1 :smoothed-k 5}
          ;; Current smoother picks the best available k, but preserves old smoothed-k
          ;; because buffer hasn't been exceeded
          group-clusterings-silhouettes {2 0.6, 3 0.8}
          smoother-fnk (:group-k-smoother conversation/small-conv-update-graph)
          new-smoother (smoother-fnk
                         {:conv {:group-k-smoother old-smoother}
                          :group-clusterings group-clusterings
                          :group-clusterings-silhouettes group-clusterings-silhouettes
                          :opts' {:group-k-buffer 4}})
          ;; Now look up group-clusters using the smoother's smoothed-k
          group-clusters (get group-clusterings (:smoothed-k new-smoother))]

      ;; With the current (unfixed) code, smoothed-k stays at 5 and the lookup returns nil.
      ;; After the fix, smoothed-k should be clamped to an available k.
      (testing "smoothed-k should be a key that exists in group-clusterings"
        (is (contains? group-clusterings (:smoothed-k new-smoother))
            (str "smoothed-k=" (:smoothed-k new-smoother)
                 " not in " (keys group-clusterings))))

      (testing "group-clusters should not be nil"
        (is (some? group-clusters)
            "group-clusters lookup must not return nil")))))


;; ============================================================================
;; Bug 3 (colleague's fix): agg-bucket-votes-for-tid with unknown pids
;;
;; When base-cluster members include pids not present in the rating matrix
;; (e.g. after incremental updates where clusters lag behind the matrix),
;; the pid-to-row lookup returns nil, and (get person-rows nil) can fail
;; depending on the matrix implementation.
;; ============================================================================

(deftest agg-bucket-votes-unknown-pid
  (testing "agg-bucket-votes-for-tid handles pids not in the rating matrix"
    (let [;; rating-mat only has :p1 and :p2
          rating-mat (nm/named-matrix
                       [:p1 :p2]
                       [:c1 :c2]
                       [[-1 1]
                        [ 1 0]])
          ;; but bid-to-pid references :p3 which doesn't exist in rating-mat
          bid-to-pid [[:p1 :p3] [:p2]]
          result (conversation/agg-bucket-votes-for-tid
                   bid-to-pid rating-mat number? :c1)]
      ;; Should not throw; :p3's vote is nil, filtered out by number?
      (is (vector? result))
      ;; bucket 0 has :p1 (voted) and :p3 (unknown → nil, filtered out) → count 1
      (is (= 1 (first result)))
      ;; bucket 1 has :p2 (voted) → count 1
      (is (= 1 (second result))))))


;; ============================================================================
;; Bug 4: comment-priorities collapsed every comment to META_PRIORITY^2 (=49)
;;
;; #1961 (2025-03-15) changed the meta-tid lookup in the :comment-priorities fnk
;; from (meta-tids tid) to (get meta-tids tid 0). For a non-meta tid,
;; (get meta-tids tid 0) returns 0 — and 0 is TRUTHY in Clojure — so
;; priority-metric took the meta branch for EVERY comment, collapsing all
;; priorities to meta-priority^2 = 49 and degrading routing to uniform-random.
;; Fixed by passing a real boolean: (contains? meta-tids tid). See #2571.
;; ============================================================================

(deftest comment-priorities-only-meta-tids-get-meta-priority
  (testing "only genuine meta tids get meta-priority^2; non-meta tids get varied importance-based priorities"
    (let [priorities-fnk (:comment-priorities conversation/small-conv-update-graph)
          tids [1 2 3]
          meta-tids #{2}                       ; only tid 2 is a meta comment
          group-votes {0 {:votes {1 {:A 5 :D 1 :S 8}
                                   2 {:A 3 :D 0 :S 6}
                                   3 {:A 1 :D 2 :S 7}}}
                       1 {:votes {1 {:A 2 :D 1 :S 5}
                                  2 {:A 1 :D 1 :S 4}
                                  3 {:A 4 :D 0 :S 9}}}}
          conv {:zid 1 :group-votes group-votes}
          pca {:comment-extremity [0.5 1.2 0.8]}   ; one per tid, in tids order
          meta-priority-sq (double (* conversation/meta-priority conversation/meta-priority))
          priorities (priorities-fnk {:conv conv
                                      :group-votes group-votes
                                      :pca pca
                                      :tids tids
                                      :meta-tids meta-tids})]
      (testing "the meta tid gets exactly meta-priority^2"
        (is (== meta-priority-sq (double (get priorities 2)))))
      ;; Regression guard for #1961: with the truthy-0 bug, non-meta tids also
      ;; hit the meta branch and returned meta-priority^2.
      (testing "non-meta tids do NOT get meta-priority^2"
        (is (not (== meta-priority-sq (double (get priorities 1)))))
        (is (not (== meta-priority-sq (double (get priorities 3))))))
      (testing "non-meta priorities are varied, not a single constant"
        (is (not (== (double (get priorities 1)) (double (get priorities 3)))))))))
