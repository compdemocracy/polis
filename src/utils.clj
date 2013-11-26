(ns utils)

(defn zip [xss]
  (if (> (count xss) 1)
    (partition (count xss) (apply interleave xss))
    xss))

