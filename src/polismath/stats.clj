(ns polismath.stats
  (:use clojure.core.matrix)
  (:require [plumbing.core :as pc]))


(defn single-prop-test
  [succ pop-size]
  (* 2 succ (pow pop-size -0.5)))


(defn two-prop-test
  [succ-in succ-out pop-in pop-out]
  (let [[succ-in succ-out pop-in pop-out]
          (map inc [succ-in succ-out pop-in pop-out])
        pi1 (/ succ-in pop-in)
        pi2 (/ succ-out pop-out)
        pi-hat (/ (+ succ-in succ-out) (+ pop-in pop-out))]
    (/ (- pi1 pi2)
       (* pi-hat
          (- 1 pi-hat)
          (+ (/ 1 pop-in) (/ 1 pop-in))))))


