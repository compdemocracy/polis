;; Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns conversation-test
  (:require [clojure.test :refer :all]
            [polismath.math.conversation :as conversation]
            [polismath.math.named-matrix :as named-matrix]
            [clojure.tools.trace :as tr]))


(def rat-mat
  (named-matrix/named-matrix [:a :b] [:x :y] [[1 0] [-1 1]]))


(let [empty-conv {:raw-rating-mat (named-matrix/named-matrix)}
      small-conv {:raw-rating-mat rat-mat
                  :rating-mat     rat-mat}

      single-vote   [{:created 500 :pid :a, :tid :x, :vote 3}]
      wonky-votes   [{:created 600 :pid :b, :tid :x, :vote 0}
                     {:created 700 :pid :a, :tid :y, :vote 1}]
      several-votes (concat single-vote wonky-votes)
      full-votes    (for [pid [:a :b :c] tid [:x :y :z]]
                     {:created 100 :pid pid :tid tid :vote (rand)})

      big-conv-matrix
      (named-matrix/named-matrix
        [:p1 :p2 :p3 :p4 :p5]
        [:c1 :c2 :c3 :c4]
        [[ 0  1  0 -1  1]
         [-1  0 -1 -1  0]
         [ 1  0  1  0  1]
         [ 1 -1  0 -1  0]
         [-1 -1  0  1  0]])
      big-conv {:raw-rating-mat big-conv-matrix
                :rating-mat     big-conv-matrix
                :pca            {:center [0.0 -0.2 -0.0  0.4] ;actually calculated this...
                      :comps [[0.4  0.2 -0.3  0.7] ;this is faked...
                              [0.1 -0.5  0.2  0.2]]}}]

  (deftest init-conv-update-test
    (testing "empty matrix and one vote"
      (is (conversation/conv-update empty-conv single-vote)))
    (testing "empty matrix and no vote"
      (is (conversation/conv-update empty-conv [])))
    (testing "empty matrix and several votes"
      (is (conversation/conv-update empty-conv several-votes)))
    (testing "empty matrix and full votes"
      (is (conversation/conv-update empty-conv full-votes)))
    (testing "empty matrix and wonky votes"
      (is (conversation/conv-update empty-conv wonky-votes))))

  ; Note that this assumes that a small conversation will actually use the small-conv-update implementation
  (deftest small-conv-update-test
    (testing "small matrix and one vote"
      (is (conversation/conv-update small-conv single-vote)))
    (testing "small matrix and no vote"
      (is (conversation/conv-update small-conv [])))
    (testing "small matrix and several votes"
      (is (conversation/conv-update small-conv several-votes)))
    (testing "small matrix and full votes"
      (is (conversation/conv-update small-conv full-votes)))
    (testing "small matrix and wonky votes"
      (is (conversation/conv-update small-conv wonky-votes))))


  (let [votes-base-fnk (:votes-base conversation/small-conv-update-graph)
        group-votes-fn (fn [conv]
                         ((:group-votes conversation/small-conv-update-graph)
                          (assoc conv :votes-base (votes-base-fnk conv))))

        group-clusters [{:id :g1 :members [:b1 :b2]} {:id :g2 :members [:b3 :b4 :b5]}]
        base-clusters (mapv (fn [[id m]] {:id id :members [m]})
                            [[:b1 :p1] [:b2 :p2] [:b3 :p3] [:b4 :p4] [:b5 :p5]])

        conv (assoc big-conv
                    :group-clusters group-clusters
                    :base-clusters base-clusters)
        conv (assoc conv
                    :bid-to-pid ((:bid-to-pid conversation/small-conv-update-graph) conv))]

    (deftest vote-base-test
      (letfn [(get-count [tid vote bid]
                (-> conv votes-base-fnk tid vote (nth bid)))]

        (testing "agree counts"
          (doseq [pid [1 4]]
            (is (= (get-count :c1 :A pid)
                   1)))
          (doseq [pid [0 2 3]]
            (is (= (get-count :c1 :A pid)
                   0))))

        (testing "disagree counts"
          (is (= (get-count :c1 :D 2)
                 1))
          (doseq [pid [0 1]]
            (is (= (get-count :c1 :D pid)
                   0))))

        (testing "disagree counts"
          (doseq [pid [0 1]]
            (is (= (get-count :c1 :S pid)
                   1))))))

    (deftest group-votes-test
      (letfn [(get-count [gid tid vote]
                (-> conv group-votes-fn gid :votes tid vote))]
        (testing "members counts"
          (is (= (-> conv group-votes-fn :g1 :n-members) 2))
          (is (= (-> conv group-votes-fn :g2 :n-members) 3)))
        (testing "aggrees"
          (is (= (get-count :g1 :c1 :A) 1))
          (is (= (get-count :g2 :c1 :A) 1)))
        (testing "aggrees"
          (is (= (get-count :g1 :c1 :D) 0))
          (is (= (get-count :g2 :c1 :D) 2))))))


  ; Test that iterating on previous pca/clustering results makes sense
  ;; TODO Put this conv-update inside a deftest, so that errors are handled appropriately
  (deftest iterative-results
    (let [fleshed-conv (conversation/conv-update small-conv single-vote)]
      (println "yeah...")
      (testing "small-conv-iterative-test"
        (testing "fleshed conv and full matrix"
          (is (conversation/conv-update fleshed-conv full-votes)))
        (testing "fleshed conv and wonky vote"
          (is (conversation/conv-update fleshed-conv [{:created 999 :pid :j :tid :k :vote -1}]))))

      (testing "moderation-test"
        (testing "from scratch with fleshed out conv"
          (is (= (:mod-out (conversation/mod-update fleshed-conv
                                       [{:tid :x :mod -1 :modified 1234}]))
                 #{:x})))
        (testing "based on previous moderations"
          (is (= (:mod-out (conversation/mod-update (assoc big-conv :mod-out #{:x})
                                       [{:tid :y :mod -1 :modified 1856}]))
                 #{:x :y})))
        (testing "modding back in"
          (is (= (:mod-out (conversation/mod-update (assoc big-conv :mod-out #{:x :y})
                                                    [{:tid :y :mod 1 :modified 1856}]))
                 #{:x})))
        (testing "'moderating' out is_meta"
          (is (= (:mod-out (conversation/mod-update (assoc big-conv :mod-out #{:x})
                                                    [{:tid :y :is_meta true :modified 1856}]))
                 #{:x :y})))
        (testing "undoing is_meta"
          (is (= (:mod-out (conversation/mod-update (assoc big-conv :mod-out #{:x :y})
                                                    [{:tid :y :is_meta false :modified 1856}]))
                 #{:x}))))
      (testing "with only approve mods"
        (is (= (:mod-out (conversation/mod-update big-conv [{:tid :x :mod 1 :modified 8576}
                                                            {:tid :y :mod 1 :modified 9856}]))
               #{})))
      (testing "with only approve mods"
        (is (= (:mod-out (conversation/mod-update big-conv [{:tid :x :mod 1 :modified 7654}
                                                            {:tid :y :mod -1 :modified 8567}]))
               #{:y})))))

  (deftest large-conv-update-test
      (testing "should work with votes for only existing ptpts/cmts"
        (is (conversation/large-conv-update {:conv big-conv :opts {} 
                                             :votes [{:created 100 :pid :p1 :tid :c1 :vote  1}
                                                     {:created 200 :pid :p3 :tid :c3 :vote -1}]})))
      (testing "should work with votes for new cmts"
        (is (conversation/large-conv-update {:conv big-conv :opts {}
                                             :votes [{:created 100 :pid :p3 :tid :c5 :vote  1}
                                                     {:created 200 :pid :p5 :tid :c5 :vote -1}]})))))

(defn -main []
  (run-tests 'conversation-test))



