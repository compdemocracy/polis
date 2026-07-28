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

;; Auto-run only when invoked with args (clojure -M dev/proj_probe.clj ...);
;; library-style load-file (batch-probe callers) skips it.
(when (seq *command-line-args*)
  (apply -main *command-line-args*))

;; Batch-mode probe (pc-revote-01 split-loop tie): replay TWO vote-count
;; batches, then print the in-conv subset ROW ORDER and the clean-start
;; split-loop extraction sequence with runner-up gaps.
(defn batch-probe [csv-path cut1 cut2]
  (let [votes (->> (replay/read-votes-csv csv-path) replay/build-dataset)
        b1    (subvec votes 0 cut1)
        b2    (subvec votes cut1 cut2)
        seed  (-> (conv/new-conv)
                  (assoc :zid 99998 :meta-tids #{}
                         :pca replay/certify-cold-start-pca))
        prev  (conv/conv-update seed (replay/->conv-votes b1)
                                replay/certify-conv-opts)
        cur   (conv/conv-update prev (replay/->conv-votes b2)
                                replay/certify-conv-opts)
        pnmat (nm/named-matrix (nm/rownames (:rating-mat cur)) ["x" "y"]
                               (:proj cur))
        inmat (nm/rowname-subset pnmat (:in-conv cur))]
    (println "BATCH rownames-head:" (pr-str (take 20 (nm/rownames inmat))))
    (println "BATCH rownames-tail:" (pr-str (take-last 8 (nm/rownames inmat))))
    (println "BATCH n-clusters cur:" (count (:base-clusters cur)))
    (doseq [c (sort-by :id (:base-clusters cur))
            :when (> (count (:members c)) 1)]
      (println "  multi-member cluster id=" (:id c) "members=" (pr-str (:members c))))))

;; Mod-weaving distinct-rows probe (pc-modheavy-01 step-2 fork, journal
;; 2026-07-22 s4 What's Next #1): replay an N-cut prefix of a mod-interleave
;; schedule WITH woven moderation (replay's own read-mod-events +
;; slice-schedule; meta-tids empty — interleave schedules take meta via
;; mod-update only, as in replay/-main), then report, at the FINAL step, the
;; in-conv projection-row distinct count and every group of pids whose rows
;; are EQUAL in clj at %.17g — to diff against the python side (py: 92
;; distinct of 105 at step 2; 12 row-pairs collide in clj only).
(defn mod-distinct-probe [votes-csv comments-csv zid & cuts]
  (let [votes (->> (replay/read-votes-csv votes-csv) replay/build-dataset)
        {mods :events} (replay/read-mod-events comments-csv)
        slots (mapv long cuts)
        steps (replay/slice-schedule votes slots mods)
        results (replay/run-once zid #{} steps)
        [_ conv'] (last results)
        pnmat (nm/named-matrix (nm/rownames (:rating-mat conv')) ["x" "y"]
                               (:proj conv'))
        inmat (nm/rowname-subset pnmat (:in-conv conv'))
        names (nm/rownames inmat)
        raw-rows (matrix/rows (nm/get-matrix inmat))
        rows  (mapv #(into [] %) raw-rows)]
    (println "MODPROBE final-step: in-conv rows=" (count rows)
             "distinct(vectorz)=" (count (distinct (into [] raw-rows)))
             "distinct(vec)=" (count (distinct rows)))
    (doseq [[row prs] (->> (group-by second (map vector names rows))
                           (filter (fn [[_ prs]] (> (count prs) 1)))
                           (sort-by (fn [[_ prs]] (long (ffirst prs)))))]
      (println (format "COLLIDE pids=%s row=[%.17g %.17g]"
                       (pr-str (mapv first prs))
                       (double (nth row 0)) (double (nth row 1)))))))

;; Mod-weaving split-loop walk (pc-modheavy-01 step-2: clj records 80 base
;; clusters vs py 92 while BOTH see 92 distinct in-conv rows — so the clj
;; split loop stops early; this prints WHY). Replays an N-cut prefix with
;; woven mods, then at the FINAL step: runs the REAL clean-start-clusters
;; (count check), then mirrors clusters.clj:250-273 manually printing each
;; iteration's most-distal extraction (id/dist/clst-id at %.20g) up to the
;; stop, plus the remaining multi-member clusters at the stop.
(defn mod-split-probe [votes-csv comments-csv zid & cuts]
  (let [votes (->> (replay/read-votes-csv votes-csv) replay/build-dataset)
        {mods :events} (replay/read-mod-events comments-csv)
        slots (mapv long cuts)
        steps (replay/slice-schedule votes slots mods)
        results (replay/run-once zid #{} steps)
        [_ prev-conv] (nth results (- (count results) 2))
        [_ cur-conv]  (last results)
        pnmat (nm/named-matrix (nm/rownames (:rating-mat cur-conv)) ["x" "y"]
                               (:proj cur-conv))
        inmat (nm/rowname-subset pnmat (:in-conv cur-conv))
        prev-bc (:base-clusters prev-conv)
        real-cs (clusters/clean-start-clusters inmat prev-bc 100)
        rec  (clusters/safe-recenter-clusters inmat prev-bc)
        uniq (clusters/uniqify-clusters rec)
        possible (min 100 (count (distinct (into [] (matrix/rows (nm/get-matrix inmat))))))]
    (println "MODSPLIT prev-step clusters:" (count prev-bc)
             "safe-recenter:" (count rec) "uniqify:" (count uniq)
             "possible:" possible "rows:" (count (nm/rownames inmat))
             "REAL clean-start-clusters:" (count real-cs))
    (loop [clusters uniq, it 0]
      (let [clusters (clusters/recenter-clusters inmat clusters)]
        (if (> possible (count clusters))
          (let [outlier (clusters/most-distal inmat clusters)]
            (println (format "MODSPLIT iter %d: n=%d extract pid=%s d=%.20g clst=%s"
                             it (count clusters) (str (:id outlier))
                             (double (:dist outlier)) (str (:clst-id outlier))))
            (if (> (:dist outlier) 0)
              (recur
                (->
                  (mapv
                    (fn [clst]
                      (assoc clst :members
                        (remove (set [(:id outlier)]) (:members clst))))
                    clusters)
                  (conj {:id (inc (apply max (map :id clusters)))
                         :members [(:id outlier)]
                         :center (nm/get-row-by-name inmat (:id outlier))}))
                (inc it))
              (do
                (println "MODSPLIT STOPPED (zero-dist outlier) at n=" (count clusters))
                (doseq [c clusters
                        :when (> (count (:members c)) 1)]
                  (println "  multi-member id=" (:id c) "members=" (pr-str (:members c)))))))
          (println "MODSPLIT done (possible reached) n=" (count clusters)))))))

;; Step-1 lineage probe (pc-modheavy-01 {1,3,8,11} id 2-vs-8): replay an
;; N-cut prefix with woven mods, then at the FINAL step print the REAL
;; clean-start seed clusters holding the tracked pids (centers %.17g), the
;; distances of each tracked row to the tracked cluster ids under
;; matrix/distance (the add-to-closest path), and the final kmeans outcome
;; for those pids — to pin WHERE clj's id survives vs the py port.
(defn lineage-probe [votes-csv comments-csv zid track-pids track-ids & cuts]
  (let [votes (->> (replay/read-votes-csv votes-csv) replay/build-dataset)
        {mods :events} (replay/read-mod-events comments-csv)
        slots (mapv long cuts)
        steps (replay/slice-schedule votes slots mods)
        results (replay/run-once zid #{} steps)
        [_ prev-conv] (nth results (- (count results) 2))
        [_ cur-conv]  (last results)
        pnmat (nm/named-matrix (nm/rownames (:rating-mat cur-conv)) ["x" "y"]
                               (:proj cur-conv))
        inmat (nm/rowname-subset pnmat (:in-conv cur-conv))
        prev-bc (:base-clusters prev-conv)
        track-pids (set track-pids)
        track-ids (set track-ids)
        seed (clusters/clean-start-clusters inmat prev-bc 100)]
    (println "LINEAGE prev-step ids holding tracked pids:")
    (doseq [c prev-bc :when (seq (clojure.set/intersection track-pids (set (:members c))))]
      (println (format "  prev id=%d members=%s center=[%.17g %.17g]"
                       (long (:id c)) (pr-str (:members c))
                       (double (first (:center c))) (double (second (:center c))))))
    (println "LINEAGE seed clusters holding tracked pids or ids:")
    (doseq [c seed :when (or (seq (clojure.set/intersection track-pids (set (:members c))))
                             (contains? track-ids (:id c)))]
      (println (format "  seed id=%d members=%s center=[%.17g %.17g]"
                       (long (:id c)) (pr-str (:members c))
                       (double (first (:center c))) (double (second (:center c))))))
    (doseq [p track-pids]
      (let [row (nm/get-row-by-name inmat p)]
        (doseq [c seed :when (contains? track-ids (:id c))]
          (println (format "  d(row%s, c%d) = %.20g"
                           (str p) (long (:id c))
                           (double (matrix/distance row (:center c))))))))
    (let [km (clusters/kmeans inmat 100
                              :last-clusters prev-bc
                              :max-iters 100)]
      (println "LINEAGE final kmeans clusters holding tracked pids:")
      (doseq [c (sort-by :id km)
              :when (seq (clojure.set/intersection track-pids (set (:members c))))]
        (println (format "  final id=%d members=%s"
                         (long (:id c)) (pr-str (:members c))))))))

;; Split-loop probe (pc-revote-01 step-1 extraction tie): replay two vote-count
;; batches like batch-probe, then walk clean-start-clusters' split loop
;; MANUALLY (mirroring clusters.clj:250-273 verbatim) printing, per iteration,
;; the ACTUAL most-distal extraction (id/dist/clst-id) plus the top-3 candidate
;; ranking with runner-up gaps, so the sequence can be diffed against the
;; python probe (delphi/scratch/probe_revote_split.py).
(defn split-probe [csv-path cut1 cut2]
  (let [votes (->> (replay/read-votes-csv csv-path) replay/build-dataset)
        b1    (subvec votes 0 cut1)
        b2    (subvec votes cut1 cut2)
        seed  (-> (conv/new-conv)
                  (assoc :zid 99998 :meta-tids #{}
                         :pca replay/certify-cold-start-pca))
        prev  (conv/conv-update seed (replay/->conv-votes b1)
                                replay/certify-conv-opts)
        cur   (conv/conv-update prev (replay/->conv-votes b2)
                                replay/certify-conv-opts)
        pnmat (nm/named-matrix (nm/rownames (:rating-mat cur)) ["x" "y"]
                               (:proj cur))
        inmat (nm/rowname-subset pnmat (:in-conv cur))
        rec   (clusters/safe-recenter-clusters inmat (:base-clusters prev))
        uniq  (clusters/uniqify-clusters rec)
        possible (min 100 (count (distinct (into [] (matrix/rows (nm/get-matrix inmat))))))]
    (println "SPLIT start-clusters:" (count uniq) "possible:" possible
             "rows:" (count (nm/rownames inmat)))
    (loop [clusters uniq, it 0]
      (let [clusters (clusters/recenter-clusters inmat clusters)]
        (if (> possible (count clusters))
          (let [outlier (clusters/most-distal inmat clusters)
                ranks   (->> (nm/rownames inmat)
                             (map (fn [mem]
                                    (let [row (nm/get-row-by-name inmat mem)]
                                      [(apply min (map #(matrix/distance row (:center %))
                                                       clusters))
                                       mem])))
                             (sort-by first)
                             reverse
                             (take 3))
                [[d0 m0] [d1 m1] [d2 m2]] ranks]
            (println (format "SPLIT iter %d: extract pid=%s d=%.20g clst=%s | top3 %s:%.20g %s:%.20g %s:%.20g | gap01=%.3e"
                             it (str (:id outlier)) (double (:dist outlier))
                             (str (:clst-id outlier))
                             (str m0) (double d0) (str m1) (double d1)
                             (str m2) (double d2)
                             (double (- d0 d1))))
            (if (> (:dist outlier) 0)
              (recur
                (->
                  (mapv
                    (fn [clst]
                      (assoc clst :members
                        (remove (set [(:id outlier)]) (:members clst))))
                    clusters)
                  (conj {:id (inc (apply max (map :id clusters)))
                         :members [(:id outlier)]
                         :center (nm/get-row-by-name inmat (:id outlier))}))
                (inc it))
              (println "SPLIT done (zero-dist outlier) after iter" it)))
          (println "SPLIT done (possible reached) n=" (count clusters)))))))
