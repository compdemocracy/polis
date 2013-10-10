(ns matrix-utils-test
  (:require [clojure.test :refer :all]
            [matrix-utils :refer :all]))

(def reactions [
   '("p1" "c1"  0)
   '("p1" "c2"  1)
   '("p2" "c1" -1)
   '("p2" "c2"  1)
   '("p3" "c1" -1)
   '("p2" "c3"  1)
   ])

(def real-rating-matrix
  [[ 0 1 0]
   [-1 1 1]
   [-1 0 0]])


(deftest create-matrix
  (testing "Creation of matrix from scratch"
    (let [rating-matrix (atom [[]])
          ptpts         (atom [])
          cmts          (atom [])]
      (update-rating-matrix reactions rating-matrix ptpts cmts)
      (is (= @rating-matrix real-rating-matrix))
      (is (= @ptpts ["p1" "p2" "p3"]))
      (is (= @cmts ["c1" "c2" "c3"])))))

