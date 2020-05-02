;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns named-matrix-test
  (:use test-helpers)
  (:require [clojure.test :refer :all]
            [polismath.math.named-matrix :refer :all]
            [polismath.math.named-matrix :as nm]))

(def reactions [
                '("p1" "c1"  0)
                '("p1" "c2"  1)
                '("p2" "c1" -1)
                '("p2" "c2"  1)
                '("p3" "c1" -1)
                '("p2" "c3"  1)])


(def real-nmat (named-matrix
                ["p1" "p2" "p3"]
                ["c1" "c2" "c3"]
                [[ 0 1   nil]
                 [-1 1   1]
                 [-1 nil nil]]))


(defn unpack-nmat [nmat]
  (map #(% nmat) [rownames colnames get-matrix]))

(def m [[1 2 3] [4 5 6]])

(deftest simple-add-padding-test
  (testing "Adding nil"
    (testing "verticle"
      (is (m=? [[1 2 3] [4 5 6] [nil nil nil]] (add-padding m 0 1 nil))))
    (testing "horizontal"
      (is (m=? [[1 2 3 nil] [4 5 6 nil]] (add-padding m 1 1 nil))))
   (testing "adding 0"
     (testing "verticle"
       (is (m=? [[1 2 3] [4 5 6] [0 0 0]] (add-padding m 0 1 0))))
     (testing "horizontal"
       (is (m=? [[1 2 3 0] [4 5 6 0]] (add-padding m 1 1 0)))))))


(deftest test-zero-out-columns
  (testing "sanity check"
    (is (m=? (nm/get-matrix (nm/zero-out-columns real-nmat ["c2"]))
             [[0 0 nil] [-1 0 1] [-1 0 nil]]))
    (is (m=? (nm/get-matrix (nm/zero-out-columns real-nmat []))
             (nm/get-matrix real-nmat))))
  (testing "mod out a comment without votes yet"
    (is (m=? (nm/get-matrix (nm/zero-out-columns real-nmat ["c999"]))
             (nm/get-matrix real-nmat)))))

; Simple creation test
(deftest create-matrix
  (testing "Creation of matrix from scratch"
    (let [nmat (named-matrix)
          [rows cols matrix] (unpack-nmat (update-nmat nmat reactions))]
      (is (= rows (rownames real-nmat)))
      (is (= cols (colnames real-nmat)))
      (is (= matrix (get-matrix real-nmat))))))

(defn nmat-equal [nm1 nm2]
  (is
    (and
      (= (rownames nm1) (rownames nm2))
      (= (colnames nm1) (colnames nm2))
      (m=? (get-matrix nm1) (get-matrix nm2)))))

(deftest test-update-nmat
  (testing "Updating an existing nmatrix"
    (testing "with existing cols"
      (let [nmat (update-nmat real-nmat
                   ['("p1" "c3" 1) '("p3" "c3" -1)])]
        (is (m=? (get-matrix nmat)
               [[ 0 1  1]
                [-1 1  1]
                [-1 nil -1]]))
        (is (= (rownames nmat)
               (rownames real-nmat))
            "Nothing should change rows")
        (is (= (colnames nmat)
               (colnames real-nmat))
            "Nothing should change with cols")))

    (testing "with new rows"
      (let [nmat (update-nmat real-nmat
                   ['("p4" "c3" 1) '("p3" "c3" -1)])]
        (is (m=? (get-matrix nmat)
               [[ 0 1  nil]
                [-1 1  1]
                [-1 nil -1]
                [ nil nil  1]]))
        (is (= (rownames nmat)
               ["p1" "p2" "p3" "p4"])
            "the new participant should be in rows")
        (is (= (colnames nmat)
               (colnames real-nmat))
            "Nothing should change with cols")))

    (testing "with new cols"
      (let [nmat (update-nmat real-nmat
                   ['("p3" "c4" 1) '("p2" "c3" -1)])]
        (is (m=? (get-matrix nmat)
               [[ 0 1   nil  nil]
                [-1 1   -1   nil]
                [-1 nil nil  1]]))
        (is (= (rownames nmat)
               (rownames real-nmat))
            "Nothing should change with rows")
        (is (= (colnames nmat)
               ["c1" "c2" "c3" "c4"])
            "the new cols should be in cols")))

    (testing "with new cols and rows"
      (let [nmat (update-nmat real-nmat
                   ['("p4" "c3" 1) '("p3" "c4" -1)])]
        (is (m=? (get-matrix nmat)
               [[ 0   1    nil  nil]
                [-1   1    1    nil]
                [-1   nil  nil -1]
                [ nil nil  1    nil]]))
        (is (= (rownames nmat)
               ["p1" "p2" "p3" "p4"])
            "the new participant should be in rows")
        (is (= (colnames nmat)
               ["c1" "c2" "c3" "c4"])
            "there new participants should be in rows")))))


(deftest matrix-subsetting-test
  (testing "by row"
    (let [submat (named-matrix
                   ["p1" "p2"] ["c1" "c2" "c3"]
                    [[ 0 1 nil]
                     [-1 1 1]])]
      (testing "using rowname-subset"
        (is (nmat-equal (rowname-subset real-nmat ["p1" "p2"]) submat)))
      (testing "using inv-rowname-subset"
        (is (nmat-equal (inv-rowname-subset real-nmat ["p3"]) submat))))))


(deftest get-row-by-name-test
  (is (= (get-row-by-name real-nmat "p2") [-1 1 1])))


