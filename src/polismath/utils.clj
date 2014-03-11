(ns polismath.utils)

(defn agree? [n]
  (< n 0))

(defn disagree? [n]
  (> n 0))

(defmacro time2
  [tag & expr]
  `(let [start# (. System (nanoTime))
         ret# ~@expr]
     (println (str (System/currentTimeMillis) " " ~tag " " (/ (double (- (. System (nanoTime)) start#)) 1000000.0) " msecs"))
     ret#))

(defn zip [& xss]
  ;;should we redo this like the with-indices below, using a map?
  (if (> (count xss) 1)
    (partition (count xss) (apply interleave xss))
    xss))

(defn replace-if-underscore [element val]
  (if (= element '_)
    val
    element))


(defn replace-underscores [form val]
  (map #(replace-if-underscore % val) form))


(defn convert-forms [val [next-form & other-forms]]
  (if (nil? next-form)
    val
    (let [next-val (gensym)]
          `(let [~next-val ~(replace-underscores next-form val)]
      ~(convert-forms next-val other-forms)))))


(defmacro ->>> [init & forms]
  (convert-forms init forms))


(defmacro endlessly [interval & forms]
  `(doseq [~'x (range)]
     ~@forms
     (Thread/sleep ~interval)))


(defn with-indices [coll]
  (map #(vector %1 %2) (range) coll))


(defn filter-by-index [coll idxs] 
  (->> (with-indices coll)
    (filter #((set idxs) (first %)))
    (map second)))


(defn apply-kwargs [f & args]
  "Takes a function f, any number of regular args, and a final kw-args argument which will be
  splatted in as a final argument"
  (apply (apply partial f (butlast args)) (apply concat (last args))))


; apply each function to the result of the previous
(defn snowball [obj fns] (reduce #(%2 %1) obj fns))



(defn prep-for-uploading-to-client [results]
  (let [base-clusters (get results :base-clusters)]
    (snowball
      results
      [
        #(dissoc %1 :mat :rating-mat :opts') ;remove things we don't want to publish

        ; REFORMAT PROJECTION
        #(dissoc %1 :proj) ; remove the original projection - we'll
                           ; provide buckets/base-clusters instead


        ; REFORMAT BASE CLUSTERS
        #(dissoc %1 :base-clusters)
        #(assoc-in %1 [:base-clusters "x"] (map (fn [x] (first (:center x))) base-clusters))
        #(assoc-in %1 [:base-clusters "y"] (map (fn [x] (second (:center x))) base-clusters))
        #(assoc-in %1 [:base-clusters "id"] (map :id base-clusters))
        #(assoc-in %1 [:base-clusters "members"] (map :members base-clusters))
        #(assoc-in %1 [:base-clusters "count"] (map (fn [c] (count (:members c))) base-clusters))        

        ; REFORMAT REPNESS
        ; make the array position of each cluster imply the cluster id
        #(assoc %1 :repness (map :repness (sort-by :id (:repness %1))))

        ])))
