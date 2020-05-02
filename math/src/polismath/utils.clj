;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.utils
  (:use clojure.core.matrix)
  (:require [taoensso.timbre.profiling :as profiling
               :refer (pspy pspy* profile defnp p p*)]
            [clojure.core.matrix :as matrix]
            [clojure.math.numeric-tower :as math]
            [clojure.core.matrix :as mat]
            [clojure.tools.trace :as tr]))

(matrix/set-current-implementation :vectorz)


(defn xor
  [a b]
  (and
    (or a b)
    (not (and a b))))


(defn round-to
  "Round x to n demical places"
  [x n]
  (let [tens (math/expt 10.0 n)]
    (-> (* x tens)
        (math/round)
        (/ tens))))


(defn gets
  "Like get, but gives a coll mapped from all the keys"
  [m ks & [not-found]]
  (mapv #(get m % not-found) ks))


(defn exit [status msg]
  (println msg)
  (System/exit status))


(defn agree? [n]
  (and
    (not (nil? n))
    (< n 0)))


(defn disagree? [n]
  (and
    (not (nil? n))
    (> n 0)))


(defmacro time2
  [tag & expr]
  `(let [start# (. System (nanoTime))
         ret# ~@expr]
     (println (str (System/currentTimeMillis) " " ~tag " " (/ (double (- (. System (nanoTime)) start#)) 1000000.0) " msecs"))
     ret#))


(defmacro f?>>
  "Modified 'penguin' operator from plumbing.core, where do-it? is a function of the threaded value
  instead of a static value. E.g.: (->> nums (f?>> #(even? (count %)) (map inc)))"
  [do-it? & args]
  `(if (~do-it? ~(last args))
     (->> ~(last args) ~@(butlast args))
     ~(last args)))


(defmacro f?>
  "Modified 'penguin' operator from plumbing.core, where do-it? is a function of the threaded value
  instead of a static value. E.g.: (-> n inc (f?> even? (* 2)))"
  [arg do-it? & rest]
  `(if (~do-it? ~arg)
     (-> ~arg ~@rest)
     ~arg))


(defn zip [& xss]
  "Like haskell or python zip"
  ;;should we redo this like the with-indices below, using a map?
  (if (> (count xss) 1)
    (partition (count xss) (apply interleave xss))
    xss))


(defn map-rest
  "Like map, but the mapper function takes both the item and the rest of the items in the collection,
  letting you operate on each item in comparison with all the others easily"
  [f col]
  (for [i (range (count col))]
    (f (get col i)
       (concat
         (subvec col 0 i)
         (subvec col (inc i))))))


(defn mapv-rest
  "Like map-rest, but returns a vector instead of a lazy seq"
  [f col]
  (vec (map-rest f col)))


;; XX This should be an env variable
(let [greedy? true]
  (defn greedy [iter]
    (if greedy?
      (into [] iter)
      iter)))


(defn greedy-false [iter] iter)


(defn ^long typed-indexof [^java.util.List coll item]
  (.indexOf coll item))


(defmacro endlessly [interval & forms]
  `(doseq [~'x (range)]
     ~@forms
     (Thread/sleep ~interval)))


(defn with-indices [coll]
  (map #(vector %1 %2) (range) coll))


(defn filter-by-index [coll idxs] 
  (greedy-false
   (let [idx-set (set idxs)]
     (->> (with-indices coll)
       (filter #(idx-set (first %)))
       (map second)))))



(defn apply-kwargs
  "Takes a function f, any number of regular args, and a final kw-args argument which will be
  splatted in as a final argument"
  [f & args]
  (apply (apply partial f (butlast args)) (apply concat (last args))))


(defn hash-map-subset
    "Create a new map which is given by subsetting to the given keys (ks)"
    [m ks]
    (let [ks (set ks)]
      (into {}
        (filter
          (fn [[k v]] (ks k))
          m))))


(defn clst-trace
  ([clsts] (clst-trace "" clsts))
  ([k clsts]
   (println "TRACE" k ":")
   (doseq [c clsts]
     (println "   " c))
   clsts))


(comment
  (require '[cemerick.pomegranate :refer [add-dependencies]])
  (defn load-dep
    [dep]
    (add-dependencies :coordinates [dep] :repositories (merge cemerick.pomegranate.aether/maven-central {"clojars" "http://clojars.org/repo"})))
  (load-dep '[clj-time "0.10.0"])
  (load-dep '[clj-excel "0.0.1"]))


:ok

