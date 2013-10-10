(ns matrix-utils)


(defn update-rating-matrix [new-reactions rating-matrix ptpts cmts] 
  (doseq [reaction new-reactions]
    (if (not (some #(= (nth reaction 0) %) @ptpts))
      (swap! ptpts conj (nth reaction 0)))
    (if (not (some #(= (nth reaction 1) %) @cmts))
      (swap! cmts conj (nth reaction 1))))
  
  (reset! rating-matrix (into @rating-matrix (repeat (- (count @ptpts) (count @rating-matrix) ) [])))
  (reset! rating-matrix (mapv #(into % (repeat (- (count @cmts) (count %)) 0)) @rating-matrix))
  (doseq [reaction new-reactions]
    (let [column (.indexOf @cmts (nth reaction 1))
          row (.indexOf @ptpts (nth reaction 0))]
      (swap! rating-matrix assoc-in [row column] (nth reaction 2)) 
      )))

