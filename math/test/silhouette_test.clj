;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns silhouette-test
  (:use test-helpers)
  (:require [clojure.test :refer :all]
            [polismath.math.named-matrix :refer :all]
            [polismath.math.clusters :refer :all]
            [clojure.core.matrix :as m]))

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
        (is (almost=?
              (get-matrix (named-dist-matrix m))
               ; From R
              [[ 0.0     8.0     13.1909]
               [ 8.0     0.0      5.4772]
               [13.1909  5.4772   0.0]]
              :tol 0.001))))
    (testing "With two args"
      (let [m2 (named-matrix [:q :r :t]
                             [:x :y :z :w]
                             [[0  2  4  8]
                              [10 12 14 16]
                              [0  0  0  0]])]
        (testing "should have correct rownames"
          (is (= [:a :b :c] (rownames (named-dist-matrix m m2)))))
        (testing "should have the correct colnames"
          (is (= [:q :r :t] (colnames (named-dist-matrix m m2)))))))))


; Some pretty simple, basic examples
(let [distmat
        (named-matrix [:a :b :c :d]
                      [:a :b :c :d]
                      [[0 1 3 4]
                       [1 0 3 4]
                       [3 3 0 2]
                       [4 4 2 0]])
      clusters
        [{:members [:a :b]} {:members [:c :d]}]]
  (deftest member-silhouette-test
    ; Compute by hand
    (is (almost=? (silhouette distmat clusters :a) 0.71428)))
  (deftest clutering-silhouette-test
    ; Again, by hand
    (is (almost=? (silhouette distmat clusters) 0.5654)))
  (deftest singleton-cluster-test
    (is (= 0 (silhouette distmat [{:members [:a]} {:members [:c :d]}] :a)))))


