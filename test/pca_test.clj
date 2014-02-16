(ns pca-test
  (:require [clojure.test :refer :all]
            [polismath.named-matrix :refer :all]
            [clojure.math.numeric-tower :refer :all]
            [clojure.core.matrix :as m]
            [polismath.pca :refer :all]))


(defn almost-equal? [xs ys & {:keys [tol] :or {tol 1e-2}}]
  (< (apply + (map #(abs (- %1 %2)) xs ys)) tol))


(deftest powerit
  (testing "Should generally work"
    (let [data (m/matrix [[ 1 0  0  ]
                        [-1 1  0.1]
                        [ 0 1  0.1]
                        [ 0 1 -0.1]])
          expected [-0.34217 0.93906 0.032633]
          pc-from-start (fn [start] (power-iteration data 2 start))]

      (testing "from scratch"
               (is (= true (almost-equal? (pc-from-start nil) expected))))
      (testing "from scratch"
               (is (almost-equal? (pc-from-start [1 1 1]) expected)))
      (testing "from scratch"
               (is (almost-equal? (pc-from-start [1 1]) expected))))))


(deftest wrapped-pca-test
  (testing "Should not fail and have the right shape for for"
    (letfn [(right-shape [data]
              (let [res (wrapped-pca (m/matrix data) 2)]
                (and (:center res) (:comps res))))]
      (testing "1x1"
        (is (right-shape [[1]])))
      (testing "1x2"
        (is (right-shape [[1 0]])))
      (testing "2x1"
        (is (right-shape [[1] [0]])))
      (testing "2x2"
        (is (right-shape [[1 0] [-1 1]])))))

  (testing "zero matrices"
    (let [data (m/matrix [[1 -1 0]
                          [1 -1 0]
                          [1 -1 0]])]
      ; need to test not only that we get something sensible here, but also that if 0 vectors are returned,
      ; that our wrapped-pca still be able to start up again
      (is (almost-equal?  [0 0 0] (first (:comps (wrapped-pca data 2)))))
      (is (almost-equal?  [0 0 0] (second (:comps (wrapped-pca data 2)))))))

  (testing "zero start-vectors"
    (let [data (m/matrix [[1  0 0]
                          [0 -1 1]
                          [1  1 0]])
          zero-vec (m/matrix [0 0 0])
          zero-vecs [zero-vec zero-vec]
          comps (:comps (wrapped-pca data 2 :start-vectors zero-vecs))]
      (is (not (almost-equal? zero-vec (first comps))))
      (is (not (almost-equal? zero-vec (second comps)))))))

