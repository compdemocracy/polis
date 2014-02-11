(ns cluster-tests
  (:require [clojure.test :refer :all]
            [polismath.named-matrix :refer :all]
            [polismath.clusters :refer :all]))

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
(deftest init-clusters-test
  (let [n-clusts 2
        ic       (init-clusters real-nmat n-clusts)]
    (testing "gives right number of clusters"
      (is (= 2 (count ic))))
    (testing "doesn't give duplicate clusters"
      (is (not (= (:center (first ic)) (:center (second ic))))))))

(deftest k-means-test
  (let [n-clusts 2
        clusts   (kmeans real-nmat n-clusts)]
    (testing "gives right number of clusters"
      (is (= 2 (count clusts))))
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

; Need to test having to add new clusters when the number isn't right; this is going to be intersting

