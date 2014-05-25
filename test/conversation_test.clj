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


(deftest large-conv-update-test
  (let [data (named-matrix
               [:p1 :p2 :p3 :p4 :p5]
               [:c1 :c2 :c3 :c4]
               [[ 0  1  0 -1  1]
                [-1  0 -1 -1  0]
                [ 1  0  1  0  1]
                [ 1 -1  0 -1  0]
                [-1 -1  0  1  0]])
        conv {:rating-mat data
              :pca {:center [0.0 -0.2 -0.0  0.4] ;actually calculated this...
                    :comps [[0.4  0.2 -0.3  0.7] ;this is faked...
                            [0.1 -0.5  0.2  0.2]]}}]
    (testing "should work with votes for only existing ptpts/cmts"
      (is (large-conv-update {:conv conv :opts {} 
                              :votes [{:pid :p1 :tid :c1 :vote  1}
                                      {:pid :p3 :tid :c3 :vote -1}]})))
    (testing "should work with votes for new cmts"
      (is (large-conv-update {:conv conv :opts {}
                              :votes [{:pid :p3 :tid :c5 :vote  1}
                                      {:pid :p5 :tid :c5 :vote -1}]})))))


