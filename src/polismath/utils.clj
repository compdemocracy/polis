(ns polismath.utils)

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


(defn with-indices [coll]
  (map #(vector %1 %2) (range) coll))


(defn filter-by-index [coll idxs] 
  (->> (with-indices coll)
    (filter #((set idxs) (first %)))
    (map second)))


