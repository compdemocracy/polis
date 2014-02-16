(ns conversation-test
  (:require [clojure.test :refer :all]
            [polismath.conversation :refer :all]
            [polismath.named-matrix :refer :all]))


(def rat-mat
  (named-matrix [:a :b] [:x :y] [[1 0] [-1 1]]))


(deftest init-conversation-test
  (let [new-votes [{:pid :a, :tid :x, :vote 3}]]
    (testing "should work on empty matrix"
      (is (small-conv-update {:conv {:rating-mat (named-matrix)} :opts {} :votes new-votes})))
    (testing "should work on an existing matrix"
      (is (small-conv-update {:conv {:rating-mat rat-mat} :opts {} :votes new-votes})))))


