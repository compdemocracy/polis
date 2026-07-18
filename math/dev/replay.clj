;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

(ns replay
  "Replay harness Phase H-B — the CLOJURE Mode A driver (REPLAY_HARNESS_DESIGN.md
  §5). Pure in-process: no Postgres, no poller, no Docker.

  Given a schedule JSON (§4) and a votes CSV, it seeds a conversation exactly as
  export.clj:624-632 (`get-export-data-at-time`) does — `(-> (conv/new-conv)
  (assoc :zid zid :meta-tids meta-tids))` — then reduces `conv/conv-update` over
  the schedule's vote batches (the pure pattern shown at dev/user.clj:416-428 and
  test/conversation_test.clj:40-168), recording per step:

    clj/step-NNN.blob.json  — the `prep-main` (conv_man.clj:43-74) key-whitelisted
                              production view, cheshire-encoded exactly as
                              postgres.clj pg-json does. This IS the `math_main`
                              blob shape and is the cross-language comparison
                              surface Python's `to_dict` targets.
    clj/step-NNN.edn        — (with --edn) full-fidelity conv state in the
                              `conv-update-dump` (conversation.clj:920) shape,
                              reloadable via `conv/load-conv-update`.

  BINDING SEMANTICS (verified against source, NOT guessed):

  * Vote signs — FLIP the CSV. Export CSVs (timestamp,datetime,comment-id,
    voter-id,vote) carry EXPORT/Delphi signs (AGREE=+1); the flip is export-only
    (export.clj:106-113). The Clojure math consumes RAW-DB signs (AGREE=-1), so
    each CSV value v is fed as -v. Recorded as vote_sign_convention \"raw-db\".
    (The Python driver feeds +v; each engine gets its own native convention, so
    the OUTPUT blobs stay comparable.)

  * Slicing mirrors the H-A Python slicer (schedule.py `resolve_cut_slots` /
    `slice_schedule`) EXACTLY: sort votes stably by (t_ms, input order), KEEP
    revotes (no dedup — later-vote-wins is resolved inside conv-update), CSV
    timestamps are SECONDS → ms via *1000 (mirror real_data.py). Cut modes
    vote-count | timestamp | fraction | explicit-event-index resolve the same
    way, including Python's round-half-to-even for `fraction`.

  * conv-update input shape (conversation_test.clj:18-21): a seq of maps
    `{:pid <int> :tid <int> :vote <int> :created <ms>}`. `:created` is REQUIRED
    (the :last-vote-timestamp fnk maxes over it, conversation.clj:161-165);
    `:zid` is taken from the seeded conv (`(or (:zid conv) (:zid (first votes)))`,
    conversation.clj:157-159) so votes need not carry it.

  * Chained warm start is IMPLICIT: the reduce threads the conv object, whose
    `:pca :comps` become the next step's `:start-vectors` (conversation.clj:381-387).
    That IS `warm_start: chain`. Step 0 has no prior comps → cold-start PCA uses
    unseeded `(rand)` (pca.clj:79-82), the §9 self-jitter source measured by
    --repeats.

  * meta-tids seed from the comments CSV `is-meta`/`is_meta` column when present;
    the public vw export has no such column, so the set is empty (documented in
    provenance meta_tids_source).

  Moderation: vw has none. `moderation` other than \"none\" raises a clear
  not-implemented error (Mode A mod-update interleaving is deferred, design §5).

  Run:  cd math && clojure -M:replay --schedule <s.json> --votes <v.csv> \\
                        --out <dir> [--repeats N] [--edn] [--zid Z] [--comments c.csv]"
  (:require [clojure.data.csv :as csv]
            [clojure.java.io :as io]
            [clojure.java.shell :as shell]
            [clojure.string :as str]
            [clojure.tools.cli :as cli]
            [cheshire.core :as json]
            [com.stuartsierra.component :as component]
            [clojure.core.matrix :as matrix]
            [polismath.math.conversation :as conv]
            [polismath.conv-man :as cm]
            [polismath.components.core-matrix-boot :as cmb])
  (:import [java.security MessageDigest]
           [java.math BigDecimal RoundingMode]
           [java.time Instant]))

;; ---------------------------------------------------------------------------
;; CSV → sorted vote stream (mirror ReplayDataset.build / real_data.py).
;; ---------------------------------------------------------------------------

(defn read-votes-csv
  "Read an export votes CSV into vote maps in FILE order. Columns
  timestamp,datetime,comment-id,voter-id,vote; timestamps are SECONDS → ms."
  [path]
  (with-open [rdr (io/reader path)]
    (let [rows   (csv/read-csv rdr)
          header (first rows)
          idx    (zipmap header (range))
          ti (idx "timestamp") ci (idx "comment-id")
          vi (idx "voter-id")  si (idx "vote")]
      (when (some nil? [ti ci vi si])
        (throw (ex-info "votes CSV missing a required column"
                        {:header header :need ["timestamp" "comment-id" "voter-id" "vote"]})))
      (mapv (fn [r]
              {:t-ms (* 1000 (Long/parseLong (str/trim (nth r ti))))
               :pid  (Long/parseLong (str/trim (nth r vi)))
               :tid  (Long/parseLong (str/trim (nth r ci)))
               :sign (Long/parseLong (str/trim (nth r si)))})
            (rest rows)))))

(defn build-dataset
  "Sort raw file-order vote maps stably by (t_ms, input index) and 1-index them.
  Revotes are KEPT — dedup is never applied (design §5). Returns a vector."
  [raw-rows]
  (->> raw-rows
       (map-indexed (fn [i row] (assoc row :file-idx i)))
       (sort-by (juxt :t-ms :file-idx))
       (map-indexed (fn [i row] (assoc row :k (inc i))))
       vec))

;; ---------------------------------------------------------------------------
;; Cut-mode resolution (mirror schedule.py resolve_cut_slots EXACTLY).
;; ---------------------------------------------------------------------------

(def ^:private valid-modes #{"vote-count" "explicit-event-index" "timestamp" "fraction"})

(defn ^long py-round
  "Round-half-to-even to a long — matches Python's built-in round() (banker's)."
  [^double x]
  (.longValueExact (.setScale (BigDecimal/valueOf x) 0 RoundingMode/HALF_EVEN)))

(defn count-votes-up-to
  "#votes with t_ms <= T in a time-sorted vector (linear; n is small)."
  [votes t-ms]
  (count (take-while #(<= (long (:t-ms %)) (long t-ms)) votes)))

(defn validate-slots
  "Mirror ReplayDataset.validate_schedule: 1<=s<=n, strictly increasing."
  [slots n]
  (loop [prev 0 [s & more] slots]
    (when s
      (when-not (<= 1 s n)
        (throw (ex-info (str "cut slot " s " outside 1.." n) {:slot s :n n})))
      (when-not (> s prev)
        (throw (ex-info (str "schedule not strictly increasing at slot " s) {:slot s})))
      (recur s more))))

(defn resolve-cut-slots
  "Resolve a §4 `cuts` map into strictly-increasing 1-based slots in 1..n.
  0-slots dropped as degenerate, duplicates collapsed (== schedule.py)."
  [votes cuts]
  (let [mode (get cuts "mode")
        at   (get cuts "at" [])
        n    (count votes)]
    (when-not (valid-modes mode)
      (throw (ex-info (str "unknown cut mode " (pr-str mode)
                           "; expected one of " (sort valid-modes)) {:mode mode})))
    (let [raw (for [a at]
                (cond
                  (= a "end")
                  n
                  (#{"vote-count" "explicit-event-index"} mode)
                  (long a)
                  (= mode "fraction")
                  (let [f (double a)]
                    (when-not (and (< 0.0 f) (<= f 1.0))
                      (throw (ex-info (str "fraction cut " f " outside (0, 1]") {:f f})))
                    (py-round (* f n)))
                  (= mode "timestamp")
                  (count-votes-up-to votes (long a))))
          slots (->> raw (filter pos?) (into (sorted-set)) vec)]
      (validate-slots slots n)
      slots)))

;; ---------------------------------------------------------------------------
;; Slicer: schedule + dataset → ordered steps (mirror slice_schedule; the tail
;; after the last cut is intentionally NOT a step — include "end" to close it).
;; ---------------------------------------------------------------------------

(defn slice-schedule
  [votes slots]
  (loop [prev 0 [cut & more] slots i 0 acc []]
    (if (nil? cut)
      acc
      (recur cut more (inc i)
             (conj acc {:index i
                        :prev-slot prev
                        :cut-slot cut
                        :votes (subvec votes prev cut)     ; (prev, cut] 0-based
                        :cut-time-ms (:t-ms (nth votes (dec cut)))})))))

;; ---------------------------------------------------------------------------
;; Feeding conv-update: FLIP the export sign to raw-DB (design §5).
;; ---------------------------------------------------------------------------

(defn ->conv-votes
  [batch]
  (mapv (fn [{:keys [pid tid sign t-ms]}]
          {:pid pid :tid tid :vote (- (long sign)) :created t-ms})
        batch))

;; ---------------------------------------------------------------------------
;; One full replay pass: seed → reduce conv-update, keeping conv per step.
;; ---------------------------------------------------------------------------

(defn run-once
  "Returns a vector of [step conv-after-update] pairs, one per cut slot.
  The reduce threading the conv IS the implicit warm-start chain."
  [zid meta-tids steps]
  (let [seed (-> (conv/new-conv) (assoc :zid zid :meta-tids (set meta-tids)))]
    (loop [conv seed [s & more] steps acc []]
      (if (nil? s)
        acc
        (let [conv' (conv/conv-update conv (->conv-votes (:votes s)))]
          (recur conv' more (conj acc [s conv'])))))))

;; ---------------------------------------------------------------------------
;; Recording.
;; ---------------------------------------------------------------------------

(defn write-blob!
  "Write the prep-main math_main view for one step, cheshire-encoded exactly as
  postgres.clj pg-json does (the DB blob's own serialization)."
  [dir step conv]
  (spit (io/file dir (format "step-%03d.blob.json" (:index step)))
        (json/generate-string (cm/prep-main conv))))

(defn write-edn!
  "Write full-fidelity conv state in the `conv-update-dump` shape
  (conversation.clj:920), reloadable via `conv/load-conv-update`. The
  core.matrix print-methods (conversation.clj:882-899) are already installed."
  [dir step conv fed-votes]
  (spit (io/file dir (format "step-%03d.edn" (:index step)))
        (prn-str
          {:conv  (into {}
                    (assoc-in conv [:pca :center]
                              (matrix/matrix (into [] (:center (:pca conv))))))
           :votes fed-votes
           :opts  {}
           :error nil})))

(defn write-results!
  [dir results edn?]
  (.mkdirs ^java.io.File dir)
  (doseq [[s conv] results]
    (write-blob! dir s conv)
    (when edn? (write-edn! dir s conv (->conv-votes (:votes s))))))

;; ---------------------------------------------------------------------------
;; Provenance.
;; ---------------------------------------------------------------------------

(defn sha256-file
  [path]
  (let [md (MessageDigest/getInstance "SHA-256")
        buf (byte-array 65536)]
    (with-open [in (io/input-stream path)]
      (loop []
        (let [n (.read in buf)]
          (when (pos? n) (.update md buf 0 n) (recur)))))
    (->> (.digest md) (map #(format "%02x" (bit-and % 0xff))) (apply str))))

(defn git-commit
  [dir]
  (try
    (let [{:keys [exit out]} (shell/sh "git" "-C" (str dir) "rev-parse" "HEAD")]
      (if (zero? exit) (str/trim out) "unknown"))
    (catch Exception _ "unknown")))

(defn build-provenance
  [{:keys [schedule schedule-id source votes-path comments-path zid meta-tids
           meta-tids-source warm-start repeats n-steps edn?]}]
  {:engine "clj"
   :mode "A"
   :schedule_id schedule-id
   :source source
   :dataset (get schedule "dataset")
   :zid zid
   :n_steps n-steps
   :repeats repeats
   :edn edn?
   :warm_start warm-start
   :warm_start_note "chain is implicit: the reduce threads conv; :pca :comps seed the next step's start-vectors (conversation.clj:381-387)"
   :vote_sign_convention "raw-db"
   :vote_sign_note "export CSV signs (AGREE=+1) are FLIPPED to raw-DB (AGREE=-1) before conv-update; the flip is export-only (export.clj:106-113)"
   :meta_tids (vec (sort meta-tids))
   :meta_tids_source meta-tids-source
   ;; Run from math/ (user.dir), which is inside the repo → HEAD is the math/
   ;; commit (delphi and math share one repo in this checkout).
   :math_git_commit (git-commit (System/getProperty "user.dir"))
   :clojure_version (clojure-version)
   :jvm_version (System/getProperty "java.version")
   :jvm_runtime_version (System/getProperty "java.runtime.version")
   :jvm_vm_name (System/getProperty "java.vm.name")
   :matrix_implementation "vectorz"
   :votes_file (.getName (io/file votes-path))
   :votes_sha256 (sha256-file votes-path)
   :comments_file (when comments-path (.getName (io/file comments-path)))
   :comments_sha256 (when comments-path (sha256-file comments-path))
   :created_at (str (Instant/now))})

;; ---------------------------------------------------------------------------
;; meta-tids from comments CSV (is-meta / is_meta column; else empty).
;; ---------------------------------------------------------------------------

(defn read-meta-tids
  "Returns [meta-tid-set source-description]. Empty when no comments CSV or no
  is-meta column (as for the public vw export)."
  [comments-path]
  (if (nil? comments-path)
    [#{} "empty (no comments CSV supplied)"]
    (with-open [rdr (io/reader comments-path)]
      (let [rows   (csv/read-csv rdr)
            header (first rows)
            idx    (zipmap header (range))
            ci     (or (idx "comment-id") (idx "tid"))
            mi     (or (idx "is-meta") (idx "is_meta"))]
        (if (or (nil? ci) (nil? mi))
          [#{} (str "empty (comments CSV has no is-meta column; header=" (vec header) ")")]
          [(->> (rest rows)
                (keep (fn [r]
                        (let [v (str/lower-case (str/trim (str (nth r mi ""))))]
                          (when (#{"1" "true" "t" "yes"} v)
                            (Long/parseLong (str/trim (nth r ci)))))))
                (into #{}))
           "comments CSV is-meta column"])))))

;; ---------------------------------------------------------------------------
;; CLI.
;; ---------------------------------------------------------------------------

(def cli-options
  [["-s" "--schedule PATH" "Path to the schedule JSON (§4)."]
   ["-v" "--votes PATH" "Path to the export votes CSV."]
   ["-o" "--out DIR" "Recording dir (…/<dataset>/<schedule_id>); clj/ is written under it."]
   [nil "--comments PATH" "Optional comments CSV (meta-tids via is-meta column)."]
   [nil "--zid ZID" "Conversation id to seed (default: schedule dataset name)."]
   ["-r" "--repeats N" "Full-replay repeats for §9 self-jitter (default 1)."
    :default 1 :parse-fn #(Integer/parseInt %)]
   [nil "--edn" "Also write per-step full-state EDN (conv-update-dump shape)."]
   ["-h" "--help"]])

(defn -main [& args]
  (let [{:keys [options errors summary]} (cli/parse-opts args cli-options)]
    (cond
      (:help options)
      (do (println "Replay harness — Clojure Mode A driver (Phase H-B)")
          (println summary)
          (System/exit 0))

      errors
      (do (binding [*out* *err*] (doseq [e errors] (println e)) (println summary))
          (System/exit 1))

      (some nil? [(:schedule options) (:votes options) (:out options)])
      (do (binding [*out* *err*]
            (println "ERROR: --schedule, --votes and --out are all required.")
            (println summary))
          (System/exit 1))

      :else
      (let [schedule    (json/parse-string (slurp (:schedule options)))
            dataset     (get schedule "dataset")
            schedule-id (get schedule "schedule_id")
            source      (get schedule "source" "votes-csv")
            cuts        (get schedule "cuts")
            moderation  (get schedule "moderation" "none")
            warm-start  (get-in schedule ["clojure" "warm_start"] "chain")
            zid         (or (:zid options) dataset)
            repeats     (:repeats options)
            edn?        (boolean (:edn options))
            out         (io/file (:out options))
            clj-dir     (io/file out "clj")]

        (when-not (contains? #{"none" nil} moderation)
          (throw (ex-info
                   (str "Moderation interleaving is NOT implemented in the Mode A "
                        "driver (the vw dataset has none). Got moderation="
                        (pr-str moderation) ". Use \"none\" or add mod-update interleaving.")
                   {:moderation moderation})))

        ;; Only "chain" warm-start is implemented (it is IMPLICIT: the reduce
        ;; threads the conv, whose :pca :comps seed the next step's start-vectors,
        ;; conversation.clj:381-387). Reject any other value loudly rather than
        ;; silently ignoring it — mirrors the moderation guard above.
        (when-not (contains? #{"chain" nil} warm-start)
          (throw (ex-info
                   (str "Only warm_start=\"chain\" is implemented in the Mode A "
                        "driver (chained warm start is implicit). Got warm_start="
                        (pr-str warm-start) ". Use \"chain\" (or omit it).")
                   {:warm_start warm-start})))

        ;; Register cheshire encoders for core.matrix (mikera.*) — WITHOUT this,
        ;; prep-main's :pca vectors fail to JSON-encode (postgres.clj relies on
        ;; the same CoreMatrixBooter at system start).
        (component/start
          (cmb/create-core-matrix-booter {:config {:math {:matrix-implementation :vectorz}}}))

        (let [raw   (read-votes-csv (:votes options))
              votes (build-dataset raw)
              slots (resolve-cut-slots votes cuts)
              steps (slice-schedule votes slots)
              [meta-tids meta-src] (read-meta-tids (:comments options))]

          (binding [*out* *err*]
            (println (format "dataset=%s n_votes=%d schedule=%s cuts=%s"
                             dataset (count votes) schedule-id (pr-str slots)))
            (println (format "steps=%d repeats=%d edn=%s zid=%s meta-tids=%d"
                             (count steps) repeats edn? (pr-str zid) (count meta-tids))))

          (.mkdirs clj-dir)
          ;; schedule.json verbatim (byte-faithful copy of the §4 input).
          (io/copy (io/file (:schedule options)) (io/file out "schedule.json"))

          ;; Run repeats. rep 0 is also written flat to clj/ (the canonical
          ;; cross-language surface); rep i>0 (and rep 0) go to clj/rep-i/.
          (dotimes [rep repeats]
            (let [results (run-once zid meta-tids steps)
                  rep-dir (if (> repeats 1) (io/file clj-dir (str "rep-" rep)) clj-dir)]
              (write-results! rep-dir results edn?)
              (when (and (> repeats 1) (zero? rep))
                (write-results! clj-dir results edn?))
              (binding [*out* *err*]
                (println (format "  rep %d/%d written → %s" (inc rep) repeats (str rep-dir))))))

          ;; Provenance (recording dir + a clj/ mirror so a later Python run's
          ;; provenance.json cannot clobber ours).
          (let [prov (build-provenance
                       {:schedule schedule :schedule-id schedule-id :source source
                        :votes-path (:votes options) :comments-path (:comments options)
                        :zid zid :meta-tids meta-tids :meta-tids-source meta-src
                        :warm-start warm-start :repeats repeats
                        :n-steps (count steps) :edn? edn?})
                prov-json (json/generate-string prov {:pretty true})]
            (spit (io/file out "provenance.json") prov-json)
            (spit (io/file clj-dir "provenance.json") prov-json))

          (println (format "wrote %d steps (x%d reps) → %s"
                           (count steps) repeats (str clj-dir)))
          (System/exit 0))))))
