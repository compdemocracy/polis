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

(defn prep-for-uploading [results]
  (let [proj (get results :proj)]
    (snowball
      results
      [
        #(dissoc %1 :mat :rating-mat :opts') ;remove things we don't want to publish
        #(dissoc %1 :proj) ; remove the original projection - we'll replace it
        #(assoc-in %1 [:proj :x] (map first proj))  ; create an array of x values
        #(assoc-in %1 [:proj :y] (map second proj)) ; create an array of y values
      ])))
