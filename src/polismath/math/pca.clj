;; Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.math.pca
  (:refer-clojure :exclude [* - + == / min max])
  (:require [taoensso.timbre :as log]
            [polismath.utils :as utils]
            [clojure.core.match :refer [match]]
            [clojure.core.matrix :as matrix]
            [clojure.core.matrix.stats :as matrix-stats]
            [clojure.core.matrix.operators :refer :all]))

(matrix/set-current-implementation :vectorz)

(set! *unchecked-math* true)


(defn repeatv
  "Utility function for making a vector of length n composed entirely of x"
  [n x]
  (matrix/matrix (into [] (repeat n x))))


; Should maybe hide this inside power-iteration and have that function wrap it's current
; recursive functionality
(defn xtxr
  "Will need to rename this and some of the inner variables to be easier to read...
  Computes an inner step of the power-iteration process"
  [data start-vec]
  (let [n-cols (matrix/dimension-count data 1)
        curr-vec (matrix/transpose (repeatv n-cols 0))]
    (loop [data (matrix/rows data) curr-vec curr-vec]
      (if-let [row (first data)]
        (recur (rest data)
               (+ curr-vec (* (matrix/inner-product start-vec row) row)))
        curr-vec))))


(defn power-iteration
  "This function produces the first eigenvector of data using the power iteration method with
  iters iterations and starting vector start-vector (defaulting to 100 and 111111 resp)."
  [data & [iters start-vector]]
  ; need to clean up some of these variables names to be more descriptive
  (let [iters (or iters 100)
        n-cols (matrix/dimension-count data 1)
        start-vector (or start-vector (repeatv n-cols 1))
        ; XXX - this add extra cols to the start vector if we have new comments... should test
        start-vector (matrix/matrix
                       (concat start-vector
                               (repeatv (- n-cols (matrix/dimension-count start-vector 0)) 1)))]
    (loop [iters iters start-vector start-vector last-eigval 0]
      (let [product-vector (xtxr data start-vector)
            eigval (matrix/length product-vector)
            normed (matrix/normalise product-vector)]
        (if (or (= iters 0) (= eigval last-eigval))
          normed
          (recur (dec iters) normed eigval))))))


(defn proj-vec
  "This computes the projection of ys orthogonally onto the vector spanned by xs"
  [xs ys]
  (let [coeff (/ (matrix/dot xs ys) (matrix/dot xs xs))]
    (* coeff xs)))


(defn factor-matrix
  "As in the Gram-Shmidt process; we can 'factor out' the vector xs from all the vectors in data,
  such that there is no remaining variance in the xs direction within the data."
  [data xs]
  ; If we have a zero eigenvector, it's safe to just assume that 0 should remain the matrix
  (if (#{0 0.0} (matrix/dot xs xs))
    data
    ; Fucking weird... sometimes getting this "can't convert to persistent vector array: inconcsistent shape"
    ; error when we don't do the into [] here. Should need to though. Will have to figure out if there is some
    ; better solution
    (matrix/matrix (mapv #(into [] (- % (proj-vec xs %))) data))))


(defn rand-starting-vec [data]
  ;; Should really throw a parallelizable random number generator in the equation here...
  ;; With seeds fed in and persisted... XXX
  (matrix/matrix (for [x (range (matrix/dimension-count data 1))] (rand))))


; Will eventually also want to add last-pcs
(defn powerit-pca
  "Find the first n-comps principal components of the data matrix; iters defaults to iters of
  power-iteration"
  [data n-comps & {:keys [iters start-vectors]}]
  (let [center (matrix-stats/mean data)
        cntrd-data (- data center)
        start-vectors (or start-vectors [])
        data-dim (min (matrix/row-count cntrd-data) (matrix/column-count cntrd-data))]
    {:center center
     :comps
        (loop [data' cntrd-data n-comps' (min n-comps data-dim) pcs [] start-vectors start-vectors]
          ; may eventually want to return eigenvals...
          (let [start-vector (or (first start-vectors) (rand-starting-vec data))
                pc (power-iteration data' iters start-vector)
                pcs (conj pcs pc)]
            (if (= n-comps' 1)
              pcs ; return if done
              (let [data' (factor-matrix data' pc)
                    n-comps' (dec n-comps')]
                (recur data' n-comps' pcs (rest start-vectors))))))}))


(defn wrapped-pca
  "This function gracefully handles weird edge cases inherent in the messiness of real world data"
  [data n-comps & {:keys [iters start-vectors] :as kwargs}]
  (match (map (partial matrix/dimension-count data) [0 1])
    [1 n-cols]
    {:center (matrix/matrix (repeatv n-comps 0))
     :comps  (into [(matrix/normalise (matrix/get-row data 0))]
               (repeat (dec n-comps) (repeatv n-cols 0)))}
    [n-rows 1]
    {:center (matrix/matrix [0])
     :comps  (matrix/matrix [1])}
    :else
      (utils/apply-kwargs powerit-pca data n-comps
                    (assoc kwargs :start-vectors
                      (if start-vectors
                        (map #(if (every? #{0 0.0} %) nil %) start-vectors)
                        nil)))))


(defn pca-project
  "Apply the principal component projection specified by pcs to the data"
  [data {:keys [comps center]}]
  ; Here we map each row of data to its projection
  (matrix/mmul (- data center) (matrix/transpose comps)))


(defn sparsity-aware-project-ptpt
  [votes {:keys [comps center]}]
  ; reduce into the projected point [p1, p2]
  (let [n-cmnts   (count votes)
        [pc1 pc2] comps
        [n-votes p1 p2] ; (p1, p2) is the projection we build
        (reduce
          ; _-n is the nth entry in _
          (fn [[n-votes p1 p2] [x-n cntr-n pc1-n pc2-n]]
            ; if we have voted, do the thing
            (if x-n
              ; first subtract center
              (let [x-n' (- x-n cntr-n)]
                ; then do a step in the dot product, and inc n-votes seen
                [(inc n-votes)
                 (+ p1 (* x-n' pc1-n))
                 (+ p2 (* x-n' pc2-n))])
              ; ... ow (if haven't voted) return what was there
              [n-votes p1 p2]))
          [0 0.0 0.0]
          (utils/zip votes center pc1 pc2))]
    ; Now scale the projection by the following value, which pushes us out from the center
    (* (Math/sqrt (/ n-cmnts (max n-votes 1)))
       [p1 p2])))


(defn sparsity-aware-project-ptpts
  "Like pca-project, but only performs the projection on non-null values, and scales the projection
  according to how many responses we have gotten"
  [data pca]
  (mapv #(sparsity-aware-project-ptpt % pca) data))


(defn pca-project-cmnts
  [{:as pca :keys [comps center]}]
  (let [n-cols (matrix/column-count comps)]
    (sparsity-aware-project-ptpts
      (map
        (fn [i]
          (assoc
            (vec (repeat n-cols nil))
            i
            -1))
        (range n-cols))
      pca)))


:ok

