(ns conversation-test
  (:require [clojure.test :refer :all]
            [polismath.conversation :refer :all]
            [polismath.named-matrix :refer :all]))


(def rat-mat
  (named-matrix [:a :b] [:x :y] [[1 0] [-1 1]]))


(deftest init-conversation-test
  (let [single-vote [{:pid :a, :tid :x, :vote 3}]
        several-votes
                  (conj single-vote 
                     {:pid :b, :tid :x, :vote 0}
                     {:pid :a, :tid :y, :vote 1})
        full-votes (for [pid [:a :b :c] tid [:x :y :z]]
                    {:pid pid :tid tid :vote (rand)})]
    (testing "should work on empty matrix and one vote"
      (is (small-conv-update {:conv {:rating-mat (named-matrix)} :opts {} :votes single-vote})))
    (testing "should work on a wonky matrix"
      (is (small-conv-update {:conv {:rating-mat (named-matrix)} :opts {} :votes
                              [{:pid :a :tid :x :vote  1}
                               {:pid :b :tid :y :vote -1}]})))
    (testing "should work on empty matrix and several votes"
      (is (small-conv-update {:conv {:rating-mat (named-matrix)} :opts {} :votes several-votes})))
    (testing "should work on ful matrix"
      (is (small-conv-update {:conv {:rating-mat (named-matrix)} :opts {} :votes full-votes})))
    (testing "should work on an existing matrix and several votes"
      (is (small-conv-update {:conv {:rating-mat rat-mat} :opts {} :votes several-votes})))))


