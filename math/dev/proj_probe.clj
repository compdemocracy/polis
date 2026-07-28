;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns proj-probe
  "Diagnostic probe (R1 goal, every-vote step-57 uniqify edge): replay the
  first N votes of a dataset through conv-update and print the FULL-PRECISION
  projection rows for selected pids at the final step.

  DELIBERATELY a separate file from replay.clj: the certify clj-recording
  cache manifests hash dev/replay.clj, so touching that file forces a full
  battery re-record. This probe reuses replay's own loaders via `load-file`
  and changes nothing.

  Usage (from math/):
    clojure -M dev/proj_probe.clj <votes-csv> <n-votes> <pid> [<pid> ...]"
  (:require [polismath.math.conversation :as conv]
            [polismath.math.clusters :as clusters]
            [polismath.math.named-matrix :as nm]
            [clojure.core.matrix :as matrix]))

(load-file "dev/replay.clj")

(defn -main [& args]
  (let [[csv-path n-votes & pids] args
        n-votes (Long/parseLong n-votes)
        pids    (set (map #(Long/parseLong %) pids))
        votes   (->> (replay/read-votes-csv csv-path)
                     replay/build-dataset
                     (take n-votes))
        seed    (-> (conv/new-conv) (assoc :zid 99999 :meta-tids #{}))
        ;; Replay ONE VOTE PER UPDATE — the warm-start chain is path-dependent
        ;; (PCA start-vectors thread tick to tick), so a cold single batch
        ;; does NOT reproduce the every-vote recording's state.
        conv'   (reduce
                  (fn [c v]
                    (conv/conv-update c (replay/->conv-votes [v])
                                      replay/certify-conv-opts))
                  seed
                  votes)
        rownames (nm/rownames (:rating-mat conv'))
        proj    (:proj conv')]
    (doseq [[pid row] (map vector rownames proj)
            :when (contains? pids pid)]
      (println (format "pid=%d proj=[%.17g %.17g]"
                       (long pid)
                       (double (first row))
                       (double (second row)))))
    (doseq [c (:base-clusters conv')]
      (println (format "cluster id=%d members=%s center=[%.17g %.17g]"
                       (long (:id c))
                       (pr-str (:members c))
                       (double (first (:center c)))
                       (double (second (:center c))))))
    ;; Phase-by-phase clean-start replay: chain to n-1 votes (prev state),
    ;; apply the final vote, then walk clean-start-clusters manually on the
    ;; new projection nmat with the PREV clusters, printing each phase.
    (let [prev  (reduce
                  (fn [c v]
                    (conv/conv-update c (replay/->conv-votes [v])
                                      replay/certify-conv-opts))
                  (-> (conv/new-conv) (assoc :zid 99999 :meta-tids #{}))
                  (butlast votes))
          cur   (conv/conv-update prev (replay/->conv-votes [(last votes)])
                                  replay/certify-conv-opts)
          pnmat (nm/named-matrix (nm/rownames (:rating-mat cur)) ["x" "y"]
                                 (:proj cur))
          inmat (nm/rowname-subset pnmat (:in-conv cur))
          rec   (clusters/safe-recenter-clusters inmat (:base-clusters prev))
          uniq  (clusters/uniqify-clusters rec)
          possible (min 100 (count (distinct (into [] (matrix/rows (nm/get-matrix inmat))))))]
      (println "PHASE safe-recenter:")
      (doseq [c rec]
        (println (format "  id=%d members=%s center=[%.17g %.17g]"
                         (long (:id c)) (pr-str (:members c))
                         (double (first (:center c))) (double (second (:center c))))))
      (println (format "PHASE uniqify: %d clusters (ids %s)"
                       (count uniq) (pr-str (mapv :id uniq))))
      (println (format "PHASE possible-clusters: %d (rows %d)"
                       possible (count (nm/rownames inmat))))
      (let [km (clusters/kmeans inmat 100
                                :last-clusters (:base-clusters prev)
                                :max-iters 100)]
        (println "PHASE full-kmeans:")
        (doseq [c (sort-by :id km)]
          (println (format "  id=%d members=%s"
                           (long (:id c)) (pr-str (:members c))))))
      (let [cs (clusters/clean-start-clusters inmat (:base-clusters prev) 100)
            data-iter (map vector (nm/rownames inmat)
                           (matrix/rows (matrix/matrix (nm/get-matrix inmat))))
            s1 (clusters/cluster-step data-iter 100 cs)]
        (println "PHASE clean-start-direct:" (pr-str (mapv (juxt :id :members) cs)))
        (println "PHASE cluster-step-1:" (pr-str (mapv (juxt :id :members) s1)))
        (let [c6 (first (filter #(= 6 (:id %)) cs))
              c8 (first (filter #(= 8 (:id %)) cs))
              row5 (nm/get-row-by-name inmat 5)]
          (println (format "PHASE centers: c6=[%.17g %.17g] c8=[%.17g %.17g]"
                           (double (first (:center c6))) (double (second (:center c6)))
                           (double (first (:center c8))) (double (second (:center c8)))))
          (println (format "PHASE dist: d(p5,c6)=%.20g d(p5,c8)=%.20g equal=%s"
                           (double (matrix/distance row5 (:center c6)))
                           (double (matrix/distance row5 (:center c8)))
                           (= (matrix/distance row5 (:center c6))
                              (matrix/distance row5 (:center c8)))))
          (let [cleared (clusters/cleared-clusters cs)
                after   (clusters/add-to-closest cleared [5 row5])
                winner  (first (filter (fn [[_ c]] (seq (:members c))) after))]
            (println "PHASE single-assign: pid 5 ->" (pr-str (key winner))
                     "map-type:" (str (type cleared))
                     "entry-order:" (pr-str (keys cleared)))
            (doseq [[cid c] cleared]
              (println (format "  d(p5, c%s)=%.20g"
                               (str cid)
                               (double (matrix/distance row5 (:center c))))))
            (let [names (nm/rownames inmat)
                  rows  (into [] (matrix/rows (matrix/matrix (nm/get-matrix inmat))))
                  mism  (for [[n r] (map vector names rows)
                              :when (not= (into [] r)
                                          (into [] (nm/get-row-by-name inmat n)))]
                          n)]
              (println "PHASE alignment: rownames=" (pr-str names)
                       "misaligned-names=" (pr-str (vec mism)))
              (let [view5 (nth rows 4)]
                (println (format "PHASE view-dist: d(view5,c6)=%.20g d(view5,c8)=%.20g types=%s/%s"
                                 (double (matrix/distance view5 (:center c6)))
                                 (double (matrix/distance view5 (:center c8)))
                                 (str (type view5)) (str (type (:center c6)))))
                (let [after (clusters/add-to-closest
                              (clusters/cleared-clusters cs) [5 view5])
                      winner (first (filter (fn [[_ c]] (seq (:members c))) after))]
                  (println "PHASE view-assign: pid 5 ->" (pr-str (key winner))))))))))))

(apply -main *command-line-args*)
