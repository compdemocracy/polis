(ns named-matrix-test
  (:require [clojure.test :refer :all]
            [polismath.named-matrix :refer :all]))

(def reactions [
   '("p1" "c1"  0)
   '("p1" "c2"  1)
   '("p2" "c1" -1)
   '("p2" "c2"  1)
   '("p3" "c1" -1)
   '("p2" "c3"  1)
   ])

(def real-nmat (named-matrix
  ["p1" "p2" "p3"]
  ["c1" "c2" "c3"]
  [[ 0 1 0]
   [-1 1 1]
   [-1 0 0]]))


; Simple creation test
(deftest create-matrix
  (testing "Creation of matrix from scratch"
    (let [nmat (named-matrix)
          {:keys [rows cols matrix]} (update-nmat nmat reactions)]
      (is (= rows (:rows real-nmat)))
      (is (= cols (:cols real-nmat)))
      (is (= matrix (:matrix real-nmat))))))

(deftest test-update-nmat
  (testing "Updating an existing nmatrix"
    (testing "with existing cols"
      (let [nmat (update-nmat real-nmat
                   ['("p1" "c3" 1) '("p3" "c3" -1)])]
        (is (= (:matrix nmat)
               [[ 0 1  1]
                [-1 1  1]
                [-1 0 -1]]))
        (is (= (:rows nmat)
               (:rows real-nmat))
            "Nothing should change rows")
        (is (= (:cols nmat)
               (:cols real-nmat))
            "Nothing should change with cols")))

    (testing "with new rows"
      (let [nmat (update-nmat real-nmat
                   ['("p4" "c3" 1) '("p3" "c3" -1)])]
        (is (= (:matrix nmat)
               [[ 0 1  0]
                [-1 1  1]
                [-1 0 -1]
                [ 0 0  1]]))
        (is (= (:rows nmat)
               ["p1" "p2" "p3" "p4"])
            "the new participant should be in rows")
        (is (= (:cols nmat)
               (:cols real-nmat))
            "Nothing should change with cols")))

    (testing "with new cols"
      (let [nmat (update-nmat real-nmat
                   ['("p3" "c4" 1) '("p2" "c3" -1)])]
        (is (= (:matrix nmat)
               [[ 0 1  0 0]
                [-1 1 -1 0]
                [-1 0  0 1]]))
        (is (= (:rows nmat)
               (:rows real-nmat))
            "Nothing should change with rows")
        (is (= (:cols nmat)
               ["c1" "c2" "c3" "c4"])
            "the new cols should be in cols")))

    (testing "with new cols and rows"
      (let [nmat (update-nmat real-nmat
                   ['("p4" "c3" 1) '("p3" "c4" -1)])]
        (is (= (:matrix nmat)
               [[ 0 1  0  0]
                [-1 1  1  0]
                [-1 0  0 -1]
                [ 0 0  1  0]]))
        (is (= (:rows nmat)
               ["p1" "p2" "p3" "p4"])
            "the new participant should be in rows")
        (is (= (:cols nmat)
               ["c1" "c2" "c3" "c4"])
            "there new participants should be in rows")))))


(deftest matrix-subsetting-test
  (testing "by row"
    (let [submat (named-matrix ["p1" "p2"] ["c1" "c2" "c3"]
                    [[ 0 1 0]
                     [-1 1 1]])]
      (testing "using rowname-subset"
        (is (= (rowname-subset real-nmat ["p1" "p2"]) submat)))
      (testing "using row-subset"
        (is (= (row-subset real-nmat [0 1]) submat)))
      (testing "using inv-rowname-subset"
        (is (= (inv-rowname-subset real-nmat ["p3"]) submat))))))


