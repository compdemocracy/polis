;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

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


