(ns stats-test
  (:use test-helpers)
  (:require [clojure.test :refer :all]
            [polismath.math.clusters :refer :all]
            [polismath.math.stats :refer :all]))


(deftest test-two-prop-test
  (testing "should have correct z-score"
    (is (almost=?
          ; from example here - http://www.cliffsnotes.com/math/statistics/univariate-inferential-tests/test-for-comparing-two-proportions
          ; note this has dec applied to all inputs since we use psuedocounts to prevent / 0
          (two-prop-test 15 56 24 71)
          -1.518
          :tol 0.01))))


(deftest test-prop-test
  (testing "should have correct z-score"
    (is (almost=?
          ; Silly little hack - as we become more certain out -> 0.5, these should converge
          (two-prop-test 30 1000000 50 2000000)
          (prop-test 30 50)))))
                

