(ns silhouette-test
  (:use test-helpers)
  (:require [clojure.test :refer :all]
            [polismath.named-matrix :refer :all]
            [clojure.core.matrix :as m]
            [polismath.clusters :refer :all]))

(deftest named-dist-matrix-test
  (let [m (named-matrix [:a :b :c]
                        [:x :y :z :w]
                        [[1 2 3 4]
                         [5 6 7 8]
                         [9 9 9 9]])]
    (testing "With one arg"
      (testing "should have the correct rownames"
        (is (= [:a :b :c] (rownames (named-dist-matrix m)))))
      (testing "should have the correct colnames"
        (is (= [:a :b :c] (colnames (named-dist-matrix m)))))
      (testing "should have the correct distance matrix"
        (is (m=? (get-matrix (named-dist-matrix m))
                 ; From R
                 [[ 0.0     8.0     13.1909]
                  [ 8.0     0.0      5.4772]
                  [13.1909  5.4772   0.0   ]]))))
    (testing "With two args"
      (let [m2 (named-matrix [:q :r :t]
                             [:x :y :z :w]
                             [[0  2  4  8 ]
                              [10 12 14 16]
                              [0  0  0  0 ]])]
        (testing "should have correct rownames"
          (is (= [:a :b :c] (rownames (named-dist-matrix m m2)))))
        (testing "should have the correct colnames"
          (is (= [:q :r :t] (colnames (named-dist-matrix m m2)))))))))


