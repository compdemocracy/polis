(ns test-helpers
  (:require [clojure.core.matrix :as m]))


(defn dimension-counts [xs]
  (map #(m/dimension-count xs %) (range (m/dimensionality xs))))


(defn dims-equal?
  "Checks that the dimension-counts are the same for all dimensions"
  [xs ys]
  (every? identity
    (map = (dimension-counts xs) (dimension-counts ys))))


(defmulti almost=?
  "Check if values are almost equal, regardless of dimension (supports tolerance)"
  (fn [xs ys & args]
    (let [dims (mapv m/dimensionality [xs ys])]
      (assert (= (first dims) (last dims))
              "xs and ys should have the same dimesnionality")
      dims)))
(defmethod almost=? [0 0]
  [x y & {:keys [tol] :or {tol 0.001}}]
  (or 
    (and (nil? x) (nil? y)) 
    (>= tol
      (m/abs (- (float x) (float y))))))
(defmethod almost=? :default
  [xs ys & {:keys [tol] :or {tol 0.001}}]
  (and
    (dims-equal? xs ys)
    (every? identity
      (map #(almost=? %1 %2 :tol tol) xs ys))))


(defn m=? [xs ys]
  (almost=? xs ys :tol 0))


