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

(def real-rating-matrix (->RatingMatrix
  ["p1" "p2" "p3"]
  ["c1" "c2" "c3"]
  [[ 0 1 0]
   [-1 1 1]
   [-1 0 0]]))


; Simple creation test

(deftest create-matrix
  (testing "Creation of matrix from scratch"
    (let [rating-matrix (->RatingMatrix [] [] [[]])
          {:keys [ptpts cmts matrix]} (update-rating-matrix rating-matrix reactions)]
      (is (= ptpts (:ptpts real-rating-matrix)))
      (is (= cmts (:cmts real-rating-matrix)))
      (is (= matrix (:matrix real-rating-matrix))))))

; These could all be DRYer, and likely highlight the need to change the way we are
; treating the identity of these atoms
(deftest update-matrix
  (testing "Updating an existing matrix"
    (testing "with existing comments/ptpts"
      (let [rating-matrix (update-rating-matrix
                            real-rating-matrix
                            ['("p1" "c3" 1) '("p3" "c3" -1)])]
        (is (= (:matrix rating-matrix)
               [[ 0 1  1]
                [-1 1  1]
                [-1 0 -1]]))
        (is (= (:ptpts rating-matrix)
               (:ptpts real-rating-matrix))
            "Nothing should change ptpts")
        (is (= (:cmts rating-matrix)
               (:cmts real-rating-matrix))
            "Nothing should change with cmts")))

    (testing "with new ptpts"
      (let [rating-matrix (update-rating-matrix
                            real-rating-matrix
                            ['("p4" "c3" 1) '("p3" "c3" -1)])]
        (is (= (:matrix rating-matrix)
               [[ 0 1  0]
                [-1 1  1]
                [-1 0 -1]
                [ 0 0  1]]))
        (is (= (:ptpts rating-matrix)
               ["p1" "p2" "p3" "p4"])
            "the new participant should be in ptpts")
        (is (= (:cmts rating-matrix)
               (:cmts real-rating-matrix))
            "Nothing should change with cmts")))

    (testing "with new cmts"
      (let [rating-matrix (update-rating-matrix
                            real-rating-matrix
                            ['("p3" "c4" 1) '("p2" "c3" -1)])]
        (is (= (:matrix rating-matrix)
               [[ 0 1  0 0]
                [-1 1 -1 0]
                [-1 0  0 1]]))
        (is (= (:ptpts rating-matrix)
               (:ptpts real-rating-matrix))
            "Nothing should change with ptpts")
        (is (= (:cmts rating-matrix)
               ["c1" "c2" "c3" "c4"])
            "the new cmts should be in cmts")))

    (testing "with new cmts and ptpts"
      (let [rating-matrix (update-rating-matrix
                            real-rating-matrix
                            ['("p4" "c3" 1) '("p3" "c4" -1)])]
        (is (= (:matrix rating-matrix)
               [[ 0 1  0  0]
                [-1 1  1  0]
                [-1 0  0 -1]
                [ 0 0  1  0]]))
        (is (= (:ptpts rating-matrix)
               ["p1" "p2" "p3" "p4"])
            "the new participant should be in ptpts")
        (is (= (:cmts rating-matrix)
               ["c1" "c2" "c3" "c4"])
            "there new participants should be in ptpts")))))


