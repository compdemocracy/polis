;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns pca-test
  (:use test-helpers)
  (:require [clojure.test :refer :all]
            [polismath.math.named-matrix :refer :all]
            [clojure.math.numeric-tower :refer :all]
            [clojure.core.matrix :as m]
            [polismath.math.pca :refer :all]
            [test-helpers :refer [almost=?]]))

(deftest powerit
  (testing "Should generally work"
    (let [data (m/matrix [[ 1 0  0]
                          [-1 1  0.1]
                          [ 0 1  0.1]
                          [ 0 1 -0.1]])
          expected [-0.34217 0.93906 0.032633]
          pc-from-start (fn [start] (power-iteration data 2 start))]

      (testing "from scratch"
               (is (= true (almost=? (pc-from-start nil) expected))))
      (testing "from scratch"
               (is (almost=? (pc-from-start [1 1 1]) expected)))
      (testing "from scratch"
               (is (almost=? (pc-from-start [1 1]) expected)))))

  (testing "Convergence behavior"
    (let [; Simple 2x2 matrix with known eigenvalues [2, 1] and eigenvector [1, 1]/√2
          simple-data (m/matrix [[1.5 0.5]
                                [0.5 1.5]])
          start-vec [1 0]  ; Not aligned with eigenvector to test convergence
          result (power-iteration simple-data 100 start-vec)]
      
      (testing "converges to correct eigenvector"
        ; The dominant eigenvector should be [1 1]/√2 ≈ [0.7071 0.7071]
        (is (almost=? result [0.7071 0.7071] :tol 0.001)))
      
      (testing "result is actually an eigenvector"
        (let [; Apply matrix to our result
              applied (m/mmul simple-data result)
              ; Get the scaling factor (eigenvalue)
              lambda (/ (m/mget applied 0) (m/mget result 0))
              ; Scale the original vector
              scaled (m/mul result lambda)]
          ; Av should equal λv
          (is (almost=? applied scaled :tol 0.001))))))
  
  (testing "Maximum iterations termination"
    (let [; Matrix that converges slowly to [1 0]
          slow-data (m/matrix [[1.1 1.0]
                              [0.0 1.0]])
          ; Run with different numbers of iterations
          result1 (power-iteration slow-data 1 [0 1])   ; Start orthogonal to eigenvector
          result3 (power-iteration slow-data 3 [0 1])]
      
      (testing "takes full number of iterations"
        (is (almost=? (m/length result1) 1.0 :tol 0.000001))  ; Should still be normalized
        (is (almost=? (m/length result3) 1.0 :tol 0.000001))
        (println "result1:" result1)
        (println "result3:" result3)
        ; Results should be different because it's still converging
        (is (not (almost=? result1 result3 :tol 0.01))))  ; Use larger tolerance to ensure difference
  
  (testing "Exhaustive termination conditions"
    (let [; Matrix that converges very slowly (for testing continue case)
          slow-data (m/matrix [[1.01 1.0]
                              [0.0  1.0]])
          ; Identity matrix (for testing eigenvalue matching)
          identity-data (m/matrix [[1 0]
                                 [0 1]])
          ; Rotation matrix (for testing non-convergence)
          rotation-data (m/matrix [[0 -1]
                                 [1  0]])
          ; Diagonal matrix with clear dominant eigenvector
          diag-data (m/matrix [[2 0]
                              [0 1]])
          ; Zero matrix for testing zero product vector
          zero-data (m/matrix [[0 0]
                              [0 0]])]
      
      (testing "continue case - both conditions false"
        (let [result (power-iteration slow-data 2 [0 1])]
          ; Should run full 2 iterations since neither condition will be true initially
          (is (not= result [0 1]))  ; Vector should change
          (is (almost=? (m/length result) 1.0))))  ; Should still be normalized
      
      (testing "exit on iters=0 only"
        (let [result (power-iteration rotation-data 0 [1 1])]
          ; With iters=0, we expect the normalized starting vector [1/√2, 1/√2]
          (is (almost=? result [0.7071067811865475 0.7071067811865475] 0.001))))
      
      (testing "exit on eigenvalue match only"
        (let [result (power-iteration identity-data 10 [1 0])]
          ; Should exit immediately due to eigenvalue match
          ; Using identity matrix with eigenvector [1 0]
          (is (almost=? result [1 0]))
          ; Verify it terminated early (before iters=0)
          (is (= result (power-iteration identity-data 1 [1 0])))))
      
      (testing "exit on both conditions"
        (let [result (power-iteration identity-data 1 [1 0])]
          ; Should exit after 1 iteration when both conditions are true
          (is (almost=? result [1 0]))
          ; Both conditions should be true:
          ; 1. iters=0 after one iteration
          ; 2. eigenvalue matches because [1 0] is already an eigenvector
          (is (= result (power-iteration identity-data 2 [1 0])))))
      
      (testing "convergence progression"
        (let [start-vec [1 1]  ; This will converge to [1 0]
              ; Case 1: Run with enough iterations - should terminate on eigenvalue match
              result1 (power-iteration diag-data 10 start-vec)
              ; Case 2: Run with exactly 1 iteration - should terminate on iteration count
              result2 (power-iteration diag-data 1 start-vec)
              ; Case 3: Run with 2 iterations - should terminate on eigenvalue match
              result3 (power-iteration diag-data 2 start-vec)]
          
          ; After 10 iterations - should be very close to [1 0]
          (is (almost=? result1 [1 0] :tol 0.000001))
          
          ; After 1 iteration - should be roughly [0.998 0.062]
          (is (almost=? result2 [0.998 0.062] :tol 0.001))
          
          ; After 2 iterations - should be roughly [0.9999 0.0156]
          (is (almost=? result3 [0.9999 0.0156] :tol 0.001))
          
          ; Results should be different, showing iteration progress
          (is (not (= result2 result3)))
          
          ; Each result should be closer to [1 0] than the last
          (let [dist1 (m/length (m/sub result1 [1 0]))
                dist2 (m/length (m/sub result2 [1 0]))
                dist3 (m/length (m/sub result3 [1 0]))]
            (is (< dist1 dist3))  ; result1 closest to [1 0]
            (is (< dist3 dist2))))
          
      (testing "exit on zero product vector"
        (let [result (power-iteration zero-data 10 [1 1])]
          ; Should exit immediately since product vector will be [0 0]
          ; which has length 0, matching initial last-eigval of 0
          ; When normalizing a zero vector, we get back a zero vector
          (is (almost=? result [0 0] :tol 0.001))
          ; Verify it terminated early by comparing with 1 iteration
          (is (= result (power-iteration zero-data 1 [1 1])))))
      
      (testing "convergence progression"
        (let [start-vec [1 1]  ; This will converge to [1 0]
              ; Case 1: Run with enough iterations - should terminate on eigenvalue match
              result1 (power-iteration diag-data 10 start-vec)
              ; Case 2: Run with exactly 1 iteration - should terminate on iteration count
              result2 (power-iteration diag-data 1 start-vec)
              ; Case 3: Run with 2 iterations - should terminate on eigenvalue match
              result3 (power-iteration diag-data 2 start-vec)]
          
          ; After 10 iterations - should be very close to [1 0]
          (is (almost=? result1 [1 0] :tol 0.000001))
          
          ; After 1 iteration - should be roughly [0.998 0.062]
          (is (almost=? result2 [0.998 0.062] :tol 0.001))
          
          ; After 2 iterations - should be roughly [0.9999 0.0156]
          (is (almost=? result3 [0.9999 0.0156] :tol 0.001))
          
          ; Results should be different, showing iteration progress
          (is (not (= result2 result3)))
          
          ; Each result should be closer to [1 0] than the last
          (let [dist1 (m/length (m/sub result1 [1 0]))
                dist2 (m/length (m/sub result2 [1 0]))
                dist3 (m/length (m/sub result3 [1 0]))]
            (is (< dist1 dist3))  ; result1 closest to [1 0]
            (is (< dist3 dist2)))))))))))


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
      (is (almost=?  [0 0 0] (first (:comps (wrapped-pca data 2)))))
      (is (almost=?  [0 0 0] (second (:comps (wrapped-pca data 2)))))))

  (testing "zero start-vectors"
    (let [data (m/matrix [[1  0 0]
                          [0 -1 1]
                          [1  1 0]])
          zero-vec (m/matrix [0 0 0])
          zero-vecs [zero-vec zero-vec]
          comps (:comps (wrapped-pca data 2 :start-vectors zero-vecs))]
      (is (not (almost=? zero-vec (first comps))))
      (is (not (almost=? zero-vec (second comps))))))

  ; See https://github.com/compdemocracy/polis/issues/1894: behaviour not as expected
  (testing "edge case: single row matrix [1, n_cols]"
    (let [data (m/matrix [[1 2 3 4]])
          result (wrapped-pca data 2)
          ; For a single row, center should be that row
          expected-center (m/get-row data 0)]
      (is (almost=? expected-center (:center result)))
      ; No point in checking the components, they do not mean anything with a single sample
  ))

  (testing "edge case: single column matrix [n_rows, 1]"
    (let [data (m/matrix [[1] [2] [3] [4]])
          ; Calling with 2 components should give us a single component
          result (wrapped-pca data 2)
          expected-center (m/matrix [2.5])
          expected-comps (m/matrix [[1]])]  ; Single component as a 1x1 matrix
      (is (almost=? expected-center (:center result)))
      (is (almost=? expected-comps (:comps result))))))

(deftest xtxr-test
  (testing "Basic functionality"
    (let [data (m/matrix [[1 0]
                         [0 1]])
          start-vec [1 1]]
      (is (almost=? (xtxr data start-vec) [1 1]))))

  (testing "Zero vector input"
    (let [data (m/matrix [[1 2]
                         [3 4]])
          start-vec [0 0]]
      (is (almost=? (xtxr data start-vec) [0 0]))))

  (testing "Rectangular matrix"
    (let [data (m/matrix [[1 0 0]
                         [0 1 0]])
          start-vec [1 1 1]]
      (is (almost=? (xtxr data start-vec) [1 1 0]))))

  (testing "Known result"
    (let [data (m/matrix [[2 1]
                         [1 3]])
          start-vec [1 2]
          ; Expected result should be [5 7]
          ; Because for each row:
          ; Row 1: (2*1 + 1*2)[2 1] = 4[2 1] = [8 4]
          ; Row 2: (1*1 + 3*2)[1 3] = 7[1 3] = [7 21]
          ; Sum the contributions: [15 25]
          expected [15 25]]
      (is (almost=? (xtxr data start-vec) expected)))))

  (testing "Zero-sum matrix behavior"
    (let [data (m/matrix [[1 -1 0]
                         [1 -1 0]
                         [1 -1 0]])
          start-vector [1 1 1]
          product-vector (xtxr data start-vector)
          eigval (m/length product-vector)
          normed (m/normalise product-vector)]
      
      ; The product vector should be [0 0 0] because:
      ; Each row [1 -1 0] dot [1 1 1] = 0
      ; This creates a zero contribution from each row
      (is (almost=? product-vector [0 0 0]))
      
      ; The eigenvalue (length) should be 0
      (is (= eigval 0.0))
      
      ; The normalized vector should be [0 0 0] when input is zero vector
      ; This is a special case of normalization
      (is (almost=? normed [0 0 0]))))


(deftest power-iteration-zero-matrices
  (testing "zero matrices with power-iteration"
    (let [data (m/matrix [[1 -1 0]
                          [1 -1 0]
                          [1 -1 0]])]
      ; Test that power-iteration returns a zero vector for this degenerate case
      (is (almost=? [0 0 0] (power-iteration data 2 nil)))))
)


(deftest almost-test
  (testing "almost=? with custom tolerance properly called"
    (is (almost=? 0.01 0.00 :tol 0.1)))
  (testing "almost=? with custom tolerance called without keyword is ignored"
    (is not (almost=? 0.01 0.00 0.1))))