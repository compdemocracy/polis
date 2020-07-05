;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns cluster-tests
  (:use polismath.utils
        test-helpers)
  (:require [clojure.test :refer :all]
            [plumbing.core :as pc]
            [polismath.math.named-matrix :refer :all]
            [polismath.math.clusters :refer :all]))

(defn size-correct [clusters n]
  ; XXX - really need to rewrite as macro
  (is (= n (count clusters))))


(def real-nmat (named-matrix
                ["p1" "p2" "p3" "p4" "p5" "p6"]
                ["c1" "c2" "c3" "c4"]
                [[ 0  1  0  1]
                 [ 0  1  0  1]
                 [-1  0 -1  1]
                 [ 1  0  1  0]
                 [-1 -1  0  1]
                 [-1  1  0  1]]))


; Initialization test
(deftest init-test
  (let [n-clusts 2
        ic       (init-clusters real-nmat n-clusts)]
    (testing "gives right number of clusters"
      (size-correct ic 2))
    (testing "doesn't give duplicate clusters"
      (is (not (= (:center (first ic)) (:center (second ic))))))))

(deftest basic-test
  (let [n-clusts 2
        clusts   (kmeans real-nmat n-clusts)]
    (testing "gives right number of clusters"
      (size-correct clusts 2))
    (testing "doesn't give duplicate clusters"
      (is (not (= (:center (first clusts)) (:center (second clusts))))))
    (testing "coordinate transforms should be handled gracefully"
      (let [real-nmat (named-matrix (rownames real-nmat) (colnames real-nmat)
                            [[0.5 0.3]
                             [4.3 0.5]
                             [2.3 8.1]
                             [1.2 4.2]
                             [1.2 2.3]
                             [4.3 1.2]])]
        ; basically just testing here that things don't break
        (is (= 2 (count (kmeans real-nmat 2 :last-clusters clusts))))))))

(deftest growing-clusters
  (let [data (named-matrix
               ["p1" "p2" "p3" "p4" "p5"]
               ["c1" "c2" "c3"]
               [[ 1  1  1]
                [ 1  1  0]
                [-1 -1 -1]
                [-1 -1  0]
                [-1  1  0]])
        last-clusts [{:id 1 :members ["p1" "p2"]} {:id 2 :members ["p3" "p4"]}]
        clusts (kmeans data 3 :last-clusters last-clusts)]
    (testing "should give the right number of clusters"
      (size-correct clusts 3))))


(deftest less-than-k-test
  (testing "k-means on n < k items gives n clusters"
    (let [data (named-matrix
                 ["p1" "p2"]
                 ["c1" "c2" "c3"]
                 [[ 0  1  0]
                  [-1  1  0]])]
      (size-correct (kmeans data 3) 2))))


(let [data (named-matrix
             ["p1" "p2" "p3"]
             ["c1" "c2" "c3"]
             [[ 0  1  0]
              [ 0  1  0]
              [-1  1  0]])]
  (deftest identical-mem-pos-test
    (testing "k-means gives n-1 clusters when precisely 2 items have identical positions"
        (size-correct (kmeans data 3) 2)))

  (deftest shrinking-test
    (testing "k-means gives n-1 clusters even when n last-clusters have been specified
             if two members have identical positions"
      (let [last-clusts [{:id 1 :members ["p1"]}
                         {:id 2 :members ["p2"]}
                         {:id 3 :members ["p3"]}]]
        (size-correct (kmeans data 3 :last-clusters last-clusts) 2)))))

(deftest edge-cases (less-than-k-test) (identical-mem-pos-test) (shrinking-test))


(deftest most-distal-test
  (let [data (named-matrix
               ["p1" "p2" "p3" "p4" "p5"]
               ["c1" "c2" "c3"]
               [[ 1  1  1]
                [ 1  1  0]
                [-1 -1 -1]
                [-1 -1  0]
                [-1  1  0]])
        clusts [{:id 1 :members ["p1" "p2"]} {:id 2 :members ["p3" "p4" "p5"]}]
        clusts (recenter-clusters data clusts)]
    (testing "correct clst-id"
      (is (= (:clst-id (most-distal data clusts)) 2)))
    (testing "correct member id"
      (is (= (:id (most-distal data clusts)) "p5")))
    (testing "correct distance"
      (is (< 
            (- (:dist (most-distal data clusts)) 1.37436854)
            0.0001)))))


(deftest uniqify-clusters-test
  (let [last-clusts [{:id 1 :members ["p1"] :center [1 1  1]}
                     {:id 2 :members ["p2"] :center [1 1  1]}
                     {:id 3 :members ["p3"] :center [1 0 -1]}]]
    (testing "correct size"
      (size-correct (uniqify-clusters last-clusts) 2))
    (testing "correct members"
      (is (some #{["p1" "p2"]} (map :members (uniqify-clusters last-clusts)))))))


(deftest merge-clusters-test
  (let [clst1 {:id 1 :center [1 1 1] :members ["a" "b"]}
        clst2 {:id 2 :center [1 0 0] :members ["c" "d"]}]
    (is (= #{"a" "b" "c" "d"}
           (set (:members (merge-clusters clst1 clst2)))))))


(let [last-clusters [{:members [1 2] :id 1}
                     {:members [3 4] :id 2}]
      nmat (fn [rows] (named-matrix rows [:x :y]
                       [[1.2   0.4]
                        [1.0   0.3]
                        [-0.2 -0.4]
                        [-0.7 -0.7]]))
      kmeanser (fn [new-data] (kmeans new-data 2 :last-clusters last-clusters))]

  (deftest missing-some-members
    (let [new-data (nmat [1 5 3 4])]
      (is (kmeanser new-data))
      (size-correct (kmeanser new-data) 2)))

  (deftest missing-all-members
    (let [new-data (nmat [6 5 3 4])]
      (is (kmeanser new-data))
      (size-correct (kmeanser new-data) 2)))

  (deftest missing-all-members-global
    (let [new-data (nmat [6 5 8 7])]
      (is (kmeanser new-data))
      (size-correct (kmeanser new-data) 2))))

(deftest missing-members
  (missing-some-members)
  (missing-all-members)
  (missing-all-members-global))


(deftest dropped-cluster
  ; Goal is to split clst 2 so that one mem goes to 1 and other goes to 3; empty cluster should handle
  (let [last-clusters [{:members [1 2] :id 1}
                       {:members [3 4] :id 2}
                       {:members [5 6] :id 3}]
        nmat (named-matrix [1 2 3 4 5 6] [:x :y]
               [[ 1.1  1.1]
                [ 1.0  1.0]
                [ 0.9  0.9]
                [-0.9 -0.9]
                [-1.0 -1.0]
                [-1.1 -1.1]])]
    (is (kmeans nmat 3 :last-clusters last-clusters))))


; Reproducible random generator for weighted kmeans test; if this gets used anywhere else, need to move
; to a closure
(def rand-gen
  (atom
    (java.util.Random. 1234)))


(defn random-vec*
  "Reproducible random vector"
  [n]
  (for [_ (range n)]
    (.nextFloat @rand-gen)))


(defn rand-int*
  "Reproducible random integer"
  [n]
  (.nextInt @rand-gen n))

(defn dup-matrix-from-weights
  "Take a matrix and weights, and produce a new matrix with duplicate rows according to `weights` integers."
  [mat weights]
  (reduce
    (fn [duped-mat [weight row]]
      (concat duped-mat (replicate weight row)))
    []
    (map vector weights mat)))

(defn dup-rownames-from-weights
  "Create a new rownames vector with names duplicated according to weights, as with dup-matrix-from-weights."
  [rownames weights]
  (reduce
    (fn [duped-rownames [weight rowname]]
      (concat duped-rownames
              (for [i (range weight)]
                [rowname i])))
    []
    (map vector weights rownames)))

(defn print-mat
  "Helper for looking at matrices"
  [names mat]
  (doseq [[n r] (map vector names mat)]
    (println n ":" r)))

(defn init-clsts
  [f coll]
  (->> coll
       (group-by f)
       (map (fn [[i mems]] {:id i :members mems}))))

(deftest weighted-kmeans
  (testing (str "Should give the same result as regular kmeans where rows have been duplicated according to a set "
             "of integer weights")
    (let [j 5]
      (swap! rand-gen (fn [_] (java.util.Random. j)))
      (let [n-uniq       20
            n-dups-max   5
            n-cmnts      3
            ; First create the base matrix, and a random set of integer weights
            uniq-positions   (into [] (for [_ (range n-uniq)] (random-vec* n-cmnts)))
            ptpt-names       (into [] (for [i (range n-uniq)] i))
            weights          (into [] (for [_ (range n-uniq)] (inc (rand-int* n-dups-max))))
            weights-hash     (into {} (map vector ptpt-names weights))
            deduped-data     (named-matrix ptpt-names [:x :y :z] uniq-positions)
            ; Use the weights to create a matrix where the rows have been duplicated according to weights
            duped-positions  (dup-matrix-from-weights uniq-positions weights)
            duped-names      (dup-rownames-from-weights ptpt-names weights)
            duped-data       (named-matrix duped-names [:x :y :z] duped-positions)
            ; Some initial data to play with
            uniq-init        (recenter-clusters
                               deduped-data
                               (init-clsts #(mod % 3) ptpt-names))
            weighted-init    (recenter-clusters
                               deduped-data
                               (init-clsts #(mod % 3) ptpt-names)
                               :weights weights-hash)
            duped-init       (recenter-clusters
                               duped-data
                               (init-clsts #(mod (first %) 3) duped-names))
            ; Run kmeans on the various data
            weighted-clsts   (kmeans deduped-data 3 
                                     :last-clusters uniq-init
                                     :weights weights-hash)
            duped-clsts      (kmeans duped-data 3
                                     :last-clusters duped-init)]
        (is (= (setify-members weighted-clsts)
               (setify-members duped-clsts :trans first)))
        (doseq [[weighted-clst duped-clst]
                (map vector weighted-init duped-init)]
          (is (almost=? (:center weighted-clst)
                        (:center weighted-clst))))))))


(deftest folding-test
  (let [clusters [{:id 0 :members [0 1 2] :center [0.4 8.5]}
                  {:id 1 :members [3 4] :center [-0.4 -5.6]}
                  {:id 2 :members [5 6 7] :center [0.3 0.4]}]]
    (testing "folding should work"
      (is (= (fold-clusters clusters)
             {:id      [0 1 2]
              :members [[0 1 2] [3 4] [5 6 7]]
              :x       [0.4 -0.4 0.3]
              :y       [8.5 -5.6 0.4]
              :count   [3 2 3]})))
    (testing "unfolding should get you back"
      (is (= ((comp unfold-clusters fold-clusters) clusters)
             clusters)))))


(defn -main []
  (run-tests 'cluster-tests))


