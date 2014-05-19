(ns polismath.named-matrix
  (:require [clojure.core.matrix :as cm]
            [taoensso.timbre.profiling :as profiling
             :refer (pspy pspy* profile defnp p p*)])
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
  (rowname-subset [this names] "Get a new PNamedMatrix subsetting to just the given rownames"))

(defn- padding-dimcounts
  "Generate paddinbg dimension counts vector suitable for core.matrix/broadcast"
  [mat dim n]
  (let [d (cm/dimensionality mat)
        dcs (mapv #(cm/dimension-count mat %) (range d))]
    (assoc dcs dim n)))

(defn add-padding
  "Add padding to a matrix. Note that if mat has nils, this function only works if value is also nil."
  ; XXX - the nil thing might be able to be fixed (if we need it at some point) by manually turning the
  ; padding potions into vectors via into in this sitation. Catch?
  [mat dim n & [value]]
  (let [dimcounts (padding-dimcounts mat dim n)
        mat       (if (nil? value) (do (println "me") mat) (cm/matrix mat))
        padding   (cm/broadcast value dimcounts)
        padding   (if (number? value) (do (println "fuck") padding) (cm/matrix padding))]
    (cm/matrix (cm/join-along dim mat padding))))


(deftype NamedMatrix
  [^IndexHash row-index ^IndexHash col-index ^java.util.List matrix]
  PNamedMatrix
    (update-nmat [this values]
      (let [values (into [] values)]
        (println "count" (count values))
        (p :update-nmat
          ; First find the row and column names that aren't yet in the data
          (let [[missing-rows missing-cols]
                  (reduce
                    (fn [[missing-rows missing-cols] [row col value]]
                      (when (nil? (index (.row-index this) row))
                        (append missing-rows row))
                      (when (nil? (index (.col-index this) row))
                        (append missing-cols col)))
                    [[] []]
                    values)]
            ; Construct a new NamedMatrix
            (.NamedMatrix
              ; Construct new rowname and colname hash-indices
              (append-many (.row-index this) missing-rows)
              (append-many (.col-index this) missing-cols)
              ; Construct new matrix
              (as-> (.matrix this) mat
                ; First add padding of nils for new rows/cols
                (add-padding mat 1 (count missing-cols))
                (add-padding mat 0 (count missing-rows))
                ; Next assoc-in all of the new votes
                (reduce
                  (fn [mat' [row col value]]
                    (let [row-i (index (.row-index this) row)
                          col-i (index (.col-index this) col)]
                      (assoc-in [row-i col-i] value)))
                  mat
                  values)))))))
    (rownames [this] (get-names (.row-index this)))
    (colnames [this] (get-names (.col-index this)))
    (get-matrix [this] (.matrix this))
    (rowname-subset [this names]
      (let [row-indices (map (partial index (.row-index this)) names)
            row-index (subset (.row-index this) names)]
        (NamedMatrix.
          row-index
          (.col-index this)
          (filter-by-index (.matrix this) row-indices)))))

(defn named-matrix
  "Generator function for a new named matrix"
  [& [rows cols matrix]]
  (NamedMatrix.
    (index-hash (or rows []))
    (index-hash (or cols []))
    (or matrix [[]])))


; Put in interface? ...

(defnp safe-rowname-subset [nmat names]
  "This version of rowname-subset filters out negative indices, so that if not all names in row-names
  are in nmat, it just subsets to the rownames that are. Should scrap other one?"
  (let [safe-names (filter
                     ; XXX This is kinda bad; should only be using protocol
                     (partial index (.row-index nmat))
                     names)]
    (rowname-subset nmat names)))

(defn get-row-by-name [nmat row-name]
  ; XXX This is kinda bad; should only be using protocol
  (cm/get-row (get-matrix nmat) (index (.row-index nmat) row-name)))

(defn inv-rowname-subset [nmat row-names]
  "Returns named matrix which has been subset to all the rows not in row-names"
  (rowname-subset nmat
    (remove (set row-names) (rownames nmat))))


