;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.math.stats
  ;; XXX Moe to require
  (:require [plumbing.core :as pc]
            [clojure.core.matrix :as matrix]
            [taoensso.timbre :as log]))


(defn prop-test
  [succ n]
  (let [[succ n] (map inc [succ n])]
    (* 2
       (matrix/sqrt n)
       (+ (/ succ n) -0.5))))


(defn two-prop-test
  [succ-in succ-out pop-in pop-out]
  (let [[succ-in succ-out pop-in pop-out]
        (map inc [succ-in succ-out pop-in pop-out])
        pi1 (/ succ-in pop-in)
        pi2 (/ succ-out pop-out)
        pi-hat (/ (+ succ-in succ-out) (+ pop-in pop-out))]
    (if (= pi-hat 1)
      ; XXX - this isn't quite right... could actually solve this using limits. I think there is some theorem
      ; that lets you take the ratio of the derivatives or something...
      0
      (/ (- pi1 pi2)
         (matrix/sqrt
           (* pi-hat
              (- 1 pi-hat)
              (+ (/ 1 pop-in) (/ 1 pop-out))))))))


(defn z-sig-90?
  "Test whether z-statistic is significant at %90 confidence with alternative hypothesis >"
  [z-val]
  (> z-val 1.2816))


(defn z-sig-95?
  "Test whether z-statistic is significant at %95 confidence with alternative hypothesis >"
  [z-val]
  (> z-val 1.6449))


:ok

