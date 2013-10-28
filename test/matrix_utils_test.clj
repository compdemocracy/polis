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
          {:keys [ptpts cmts matrix]} (update-rating-matrix' reactions rating-matrix)]
      (is (= ptpts (real-rating-matrix :ptpts)))
      (is (= cmts (real-rating-matrix :cmts)))
      (is (= matrix (real-rating-matrix :matrix))))))


; These could all be DRYer, and likely highlight the need to change the way we are
; treating the identity of these atoms

;(deftest update-matrix
  ;(testing "Updating an existing matrix"
    ;(let [rating-matrix (atom real-rating-matrix)
          ;ptpts (atom real-ptpts)
          ;cmts (atom real-cmts)]
      ;(testing "only with existing comments/ptpts"
        ;(update-rating-matrix
          ;['("p1" "c3" 1) '("p3" "c3" -1)]
          ;rating-matrix ptpts cmts)
        ;(is (= @rating-matrix
               ;[[ 0 1  1]
                ;[-1 1  1]
                ;[-1 0 -1]]))
        ;(is (= @ptpts real-ptpts) "Nothing should change")
        ;(is (= @cmts real-cmts) "Nothing should change")))

    ;(let [rating-matrix (atom real-rating-matrix)
          ;ptpts (atom real-ptpts)
          ;cmts (atom real-cmts)]
      ;(testing "with new ptpts"
        ;(update-rating-matrix
          ;['("p4" "c3" 1) '("p3" "c3" -1)]
          ;rating-matrix ptpts cmts)
        ;(is (= @rating-matrix
               ;[[ 0 1  0]
                ;[-1 1  1]
                ;[-1 0 -1]
                ;[ 0 0  1]]))
        ;(is (= @ptpts ["p1" "p2" "p3" "p4"]) "the new participant should be in ptpts")
        ;(is (= @cmts real-cmts) "nothing should change")))

    ;(let [rating-matrix (atom real-rating-matrix)
          ;ptpts (atom real-ptpts)
          ;cmts (atom real-cmts)]
      ;(testing "with new ptpts"
        ;(update-rating-matrix
          ;['("p4" "c3" 1) '("p3" "c3" -1)]
          ;rating-matrix ptpts cmts)
        ;(is (= @rating-matrix
               ;[[ 0 1  0]
                ;[-1 1  1]
                ;[-1 0 -1]
                ;[ 0 0  1]]))
        ;(is (= @ptpts ["p1" "p2" "p3" "p4"]) "the new participant should be in ptpts")
        ;(is (= @cmts real-cmts) "nothing should change")))))
