(ns cluster-tests
  (:use polismath.utils)
  (:require [clojure.test :refer :all]
            [polismath.named-matrix :refer :all]
            [polismath.clusters :refer :all]))

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
      (let [real-nmat (assoc real-nmat :matrix
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
                 [[ 0  1  0 ]
                  [-1  1  0 ]])]
      (size-correct (kmeans data 3) 2))))


(let [data (named-matrix
             ["p1" "p2" "p3"]
             ["c1" "c2" "c3"]
             [[ 0  1  0 ]
              [ 0  1  0 ]
              [-1  1  0 ]])]
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


