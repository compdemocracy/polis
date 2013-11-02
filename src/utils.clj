(ns utils)

(defn zip [xss]
  (partition (count xss) (apply interleave xss)))

