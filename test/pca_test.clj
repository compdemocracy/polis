(ns pca-test
  (:require [clojure.test :refer :all]
            [polismath.named-matrix :refer :all]
            [incanter.core :refer :all]
            [polismath.pca :refer :all]))


(defn almost-equal? [xs ys & {:keys [tol] :or {tol 1e-2}}]
  (< (apply + (map #(abs (- %1 %2)) xs ys)) tol))


(deftest powerit
  (testing "Should generally work"
    (let [data (matrix [[ 1 0  0  ]
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

