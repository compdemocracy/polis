(ns polismath.named-matrix
  (:use polismath.utils))


(defn named-matrix [& [rows cols matrix]]
  "Convenience function for creating a named matrix (nmat). Shape of named matrix is {:rows :cols :matrix}.
  Might reimplement as a record in the future"
  (let [rows (or rows [])
        cols (or cols [])
        matrix (or matrix [[]])]
    {:rows rows :cols cols :matrix matrix}))


(defn update-nmat [nmat new-reactions]
  "This is a recursive function for taking new reactions and inserting them into the rating matrix."
  ; be careful about first v last wrt spout order; want to make sure the last thing in overrides
  ; anything earlier... If there are new reaactions, proceed
  (if-let [[rown coln val] (first new-reactions)]
    ; Long series of let assignments leading up to the recursive call
    (let [{:keys [rows cols matrix]} nmat
          [row-index col-index] (map 
                                   #(.indexOf %1 %2)
                                   [rows cols] [rown coln])
          [rows cols] (map (fn [xs x i] (if (= -1 i) (conj xs x) xs))
                            [rows cols] [rown coln] [row-index col-index])
          ; If necessary, insert new columns and/or rows of zeros
          matrix (if (= -1 col-index) (mapv #(conj % 0) matrix) matrix)
          matrix (if (> (count rows) (count matrix)) (conj matrix (into [] (repeat (count cols) 0))) matrix)
          ; Get the indices of the matrix position to be updated (note that .indexOf above gives
          ; us -1 if the item is not in the collection)
          indices (mapv (fn [xs i] (if (= -1 i) (- (count xs) 1) i))
                        [rows cols] [row-index col-index])
          matrix (assoc-in matrix indices val)]
      (recur (assoc nmat :rows rows :cols cols :matrix matrix) (rest new-reactions)))
    ; else nothing to add; return matrix as is
    nmat))


(defn row-subset [nmat row-indices]
  (assoc nmat 
    :rows (filter-by-index (:rows nmat) row-indices)
    :matrix (filter-by-index (:matrix nmat) row-indices)))


(defn rowname-subset [nmat row-names]
  (->> row-names
    (map #(.indexOf (:rows nmat) %))
    (row-subset nmat)))


(defn inv-rowname-subset [nmat row-names]
  (row-subset nmat
    (remove (set (map #(.indexOf (:rows nmat) %) row-names))
      (range (count (:rows nmat))))))


