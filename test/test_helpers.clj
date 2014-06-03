(ns test-helpers
  (require [clojure.core.matrix :as m]))


(defn v=? [v1 v2 & {:keys [tol] :or {tol 0.001}}]
  (every? identity
    (map 
      (fn [x y]
        (or 
          (and (nil? x) (nil? y)) 
          (>= tol
            (m/abs (- (float x) (float y))))))
      v1 v2)))


(defn m=? [m1 m2 & {:keys [tol] :or {tol 0.001}}]
  (every? identity (map #(v=? %1 %2 :tol tol) m1 m2)))

