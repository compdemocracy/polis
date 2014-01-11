(ns utils)

(defn zip [xss]
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


