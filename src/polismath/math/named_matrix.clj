;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns polismath.math.named-matrix
  (:require [clojure.core.matrix :as matrix]
            ;[clojure.core.matrix.select :as matrix]
            [taoensso.timbre.profiling :as profiling :refer (pspy pspy* profile defnp p p*)]
            [clojure.spec.alpha :as s]
            [clojure.spec.gen.alpha :as gen]
            [clojure.test.check.generators :as generators])
  ;; Again, move to 
  (:use polismath.utils))


(defprotocol AutoIncIndex
  "Things which implement this are intended to be used as data structures for use as rownames or colnames.
  They are basically overglorified hash maps"
  (get-names [this] "In order of index, the names associated with the data")
  (next-index [this] "Get the next available index")
  (index [this keyname] "Get the index corresponding to keyname")
  (append [this keyname] "Append keyname")
  (append-many [this keynames] "Append many")
  (subset [this keynames] "Subset the index, and update index/hash"))


(deftype IndexHash
  [^java.util.Vector names ^clojure.lang.PersistentArrayMap index-hash]
  AutoIncIndex
  (get-names [this] (.names this))
  (next-index [this] (count (.names this)))
  (index [this keyname] (index-hash keyname))
  (append [this keyname]
    (if ((.index-hash this) keyname)
      this
      (IndexHash.
        (conj (get-names this) keyname)
        (assoc (.index-hash this) keyname (next-index this)))))
  (append-many [this keynames]
    ; potentially faster
    ;(let [uniq-kns (distinct keynames)
          ;new-kns (remove (.index-hash this) uniq-kns)]
      ;(IndexHash.
        ;(into (.names this) new-kns)
        ;(into (.index-hash)
          ;(map
            ;#(vector %1 (+ (count (.names this)) %2))
            ;new-kns
            ;(range)))))
    ; much simpler
    (reduce append this keynames))
  (subset [this keynames]
    (let [kn-set (set keynames)
          new-kns (filter kn-set (.names this))]
      (IndexHash. new-kns (into {} (map vector new-kns (range)))))))

(defn index-hash
  "Construct a new IndexHash with the given keynames"
  [keynames]
  (let [uniq-kns (into [] (distinct keynames))]
    (IndexHash. uniq-kns
      (into {} (map vector uniq-kns (range))))))


(defprotocol PNamedMatrix
  ; should really just change to update, but for now...
  (update-nmat [this values]
    "Updates a nameable matrix given a seq of (rowname, colname, value) tuples")
  (rownames [this] "Vector of row names, in order")
  (colnames [this] "Vector of column names, in order")
  (get-matrix [this] "Extract the matrix object")
  ; XXX - Should probably set these up map [this key] -> (index (.row-index this) key) since that's whats needed
  (get-row-index [this] "Extract the row-index object")
  (get-col-index [this] "Extract the col-index object")
  (rowname-subset [this names] "Get a new PNamedMatrix subsetting to just the given rownames")
  (colname-subset [this names] "Get a new PNamedMatrix subsetting to just the given columns"))


(defn add-padding
  "Adds specified value padding to 2d matrices"
  [mat ^Integer dim ^Integer n & [value]]
  (let [other-dim (mod (inc dim) 2)
        other-dimcount (matrix/dimension-count mat other-dim)]
    (case dim
      0 (let [padding (into [] (repeat other-dimcount value))]
          (into mat (repeat n padding)))
      1 (let [padding (repeat n value)]
          (mapv #(into % padding) mat)))))


(deftype NamedMatrix
  [row-index col-index matrix]
  PNamedMatrix
  (update-nmat [this values]
    ; First find the row and column names that aren't yet in the data
    (let [[missing-rows missing-cols]
          (reduce
            (fn [[missing-rows missing-cols] [row col value]]
              [(if (nil? (index (.row-index this) row))
                 (conj missing-rows row)
                 missing-rows)
               (if (nil? (index (.col-index this) col))
                 (conj missing-cols col)
                 missing-cols)])
            [[] []]
            values)
          ; Construct new rowname and colname hash-indices
          new-row-index (append-many (.row-index this) missing-rows)
          new-col-index (append-many (.col-index this) missing-cols)
          new-row-count (count (set missing-rows))
          new-col-count (count (set missing-cols))]
      ; Construct a new NamedMatrix
      (NamedMatrix.
        new-row-index
        new-col-index
        ; Construct new matrix
        (as-> (.matrix this) mat
          (if (= 0 (matrix/dimension-count mat 1))
            ; If the matrix is empty, just create the shape needed
            (matrix/coerce [[]]
              (matrix/broadcast nil [new-row-count new-col-count]))
            ; OW, add padding of nils for new rows/cols
            (-> mat
              (add-padding 1 (count (set missing-cols)))
              (add-padding 0 (count (set missing-rows)))))
          ; Next assoc-in all of the new votes
          (reduce
            (fn [mat' [row col value]]
              (let [row-i (index new-row-index row)
                    col-i (index new-col-index col)]
                (assoc-in mat' [row-i col-i] value)))
            mat
            values)))))
  (rownames [this] (get-names (.row-index this)))
  (colnames [this] (get-names (.col-index this)))
  (get-matrix [this] (.matrix this))
  (get-row-index [this] (.row-index this))
  (get-col-index [this] (.col-index this))
  (rowname-subset [this names]
    (let [row-indices (map (partial index (.row-index this)) names)
          row-index (subset (.row-index this) names)]
      (NamedMatrix.
        row-index
        (.col-index this)
        (filter-by-index (.matrix this) row-indices))))
  (colname-subset [this names]
    (let [col-indices (map (partial index (.col-index this)) names)
          col-index (subset (.col-index this) names)]
      (NamedMatrix.
        (.row-index this)
        col-index
        (matrix/select (.matrix this) :all col-indices)))))


(defn named-matrix
  "Generator function for a new named matrix"
  [& [rows cols matrix]]
  (NamedMatrix.
    (index-hash (or rows []))
    (index-hash (or cols []))
    (or matrix [[]])))



(defn named-matrix-gen-of
  [gen]
  (gen/bind
    (gen/tuple
      (gen/such-that not-empty (gen/vector-distinct (gen/such-that pos? (gen/int))))
      (gen/such-that not-empty (gen/vector-distinct (gen/such-that pos? (gen/int)))))
    (fn [[rownames colnames]]
      (gen/fmap
        (fn [matrix] (named-matrix rownames colnames matrix))
        (gen/vector
          (gen/vector gen (count colnames))
          (count rownames))))))

;(gen/sample (named-matrix-gen-of (s/gen #{-1 0 1 nil})))


(s/def ::NamedMatrix
  (s/with-gen
    (s/and
      (partial satisfies? PNamedMatrix)
      ;(comp get-matrix matrix/matrix?)
      (comp matrix/vec? rownames)
      (comp matrix/vec? colnames)
      (comp distinct rownames)
      (comp distinct colnames))
    ;; Silly... need way smarter generators here; And maybe actually the generator shouldn't be on this entity, since a named
    ;(clojure.test.check.generators/elements)
    #(named-matrix-gen-of (gen/double))))

;(gen/sample (s/gen ::NamedMatrix))


;(gen/frequency)
;(gen/double*)
;(gen/vector-of)
;(gen/sample (gen/double* {:min 0 :max 1 :NaN? false :infinite? false}) 100)


(defmethod print-method NamedMatrix
  [nm ^java.io.Writer w]
  (.write w
    (str "#polismath.named-matrix.NamedMatrix "
      "{:rownames " (into [] (rownames nm))
      " :colnames " (into [] (colnames nm))
      " :matrix " (get-matrix nm)
      "}")))

;(gen/sample (s/gen (s/cat :nm ::NamedMatrix :columns coll?)))

(s/fdef zero-out-columns
  :args (s/cat :nm ::NamedMatrix :columns coll?)
  :ret ::NamedMatrix)

(defn zero-out-columns
  "Creates a new rating matrix which has had the specied columns zeroed out"
  [nm columns]
  (let [m (get-matrix nm)
        cols (colnames nm)
        rows (rownames nm)
        col-index (get-col-index nm)
        m'
        (reduce
          (fn [m' col]
            ;; It's possible to is_meta out a comment that hasn't yet been repsonded to
            (if-let [i (index col-index col)]
              (matrix/set-column m' i 0)
              m'))
          m
          columns)]
    (named-matrix rows cols m')))

; Just trying to figure out how the hell function checking really works... 
(require '[clojure.spec.test.alpha :as stest])
(stest/check `zero-out-columns)


(s/fdef whatever
  :args (s/cat :x (s/and number? #(not= ##NaN %) #(not= 0 %)))
  :ret number?
  :fn #(= (-> % :ret (* 2) (-> % :args :x))))
(defn whatever
  [x]
  (/ 2 x))

;(gen/sample (s/gen number?))
(stest/check `whatever)




(defn named-matrix-reader
  [{:keys [rownames colnames matrix]}]
  (named-matrix rownames colnames matrix))


; Put in interface? ...

(defn safe-rowname-subset
  "This version of rowname-subset filters out negative indices, so that if not all names in row-names
  are in nmat, it just subsets to the rownames that are. Should scrap other one?"
  [nmat names]
  (let [safe-names (filter
                     (partial index (get-row-index nmat))
                     names)]
    (rowname-subset nmat names)))


(defn get-row-by-name [nmat row-name]
  (matrix/get-row (get-matrix nmat) (index (get-row-index nmat) row-name)))


(defn inv-rowname-subset [nmat row-names]
  "Returns named matrix which has been subset to all the rows not in row-names"
  (rowname-subset nmat
    (remove (set row-names) (rownames nmat))))

:ok

