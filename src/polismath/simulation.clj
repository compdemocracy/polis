(ns polismath.simulation
  (:use polismath.utils
        clj-time.coerce
        clj-time.local))


(defn random-reactions [n-ptpts n-cmts & {:keys [n-reactions n-convs] :or {n-convs 1}}]
  (let [n-reactions (or n-reactions (* n-convs n-ptpts n-cmts))]
    (letfn [(generator [wrapper-fn range]
              (take n-reactions (repeatedly #(wrapper-fn (rand-int range)))))]
      (map list
        (generator identity n-convs)
        (generator #(str "p" %) n-ptpts)
        (generator #(str "c" %) n-cmts)
        (generator #(- % 1) 3)))))


(defn random-poll [db-spec last-timestamp]
  (letfn [(rand-timestamp []
            (+ last-timestamp
               (rand-int (- (to-long (local-now)) last-timestamp))))]
    (sort-by :created
      (map (fn [rxn]
             (->>> rxn
              (apply #(hash-map :zid %1 :pid %2 :tid %3 :vote %4) _)
              (assoc _ :created (rand-timestamp))))
         (random-reactions 4 4 :n-convs 3)))))


(defn make-reaction-gen [n-convs start-n]
  "This function creates an infinite sequence of reations which models an increasing number of comments and
  people over time, over some number of conversations n-convs. The start-n argument sets the initial number of
  ptpts and cmts per conversation."
  ; I <3 clojure...
  (mapcat
    #(random-reactions % % :n-convs n-convs)
    (map #(+ % start-n) (range))))


