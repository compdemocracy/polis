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
            [polismath.math.named-matrix :as nm]
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
  "Validate increasing vote cursors, with an explicit zero-checkpoint opt-in."
  ([slots n] (validate-slots slots n false))
  ([slots n allow-zero]
  (loop [prev (if allow-zero -1 0) [s & more] slots]
    (when s
      (when-not (<= (if allow-zero 0 1) s n)
        (throw (ex-info (str "cut slot " s " outside 1.." n) {:slot s :n n})))
      (when-not (> s prev)
        (throw (ex-info (str "schedule not strictly increasing at slot " s) {:slot s})))
      (recur s more)))))

(defn resolve-cut-slots
  "Mirror schedule.py: preserve order; zero and deduplication require opt-in."
  [votes cuts]
  (let [mode (get cuts "mode")
        at   (get cuts "at" [])
        n    (count votes)]
    (when-not (and (map? cuts) (vector? at))
      (throw (ex-info "cuts must be an object and cuts.at a list" {})))
    (when (seq (remove #{"mode" "at" "empty_checkpoint" "deduplicate"} (keys cuts)))
      (throw (ex-info "unknown cut fields" {:cuts cuts})))
    (doseq [flag ["empty_checkpoint" "deduplicate"]]
      (when (and (contains? cuts flag) (not (instance? Boolean (get cuts flag))))
        (throw (ex-info (str "cuts." flag " must be boolean") {}))))
    (when-not (valid-modes mode)
      (throw (ex-info (str "unknown cut mode " (pr-str mode)
                           "; expected one of " (sort valid-modes)) {:mode mode})))
    (let [raw (for [a at]
                (cond
                  (= a "end")
                  n
                  (#{"vote-count" "explicit-event-index"} mode)
                  (do (when-not (integer? a)
                        (throw (ex-info "vote cut must be an integer" {:cut a})))
                      (long a))
                  (= mode "fraction")
                  (let [f (double a)]
                    (when-not (and (< 0.0 f) (<= f 1.0))
                      (throw (ex-info (str "fraction cut " f " outside (0, 1]") {:f f})))
                    (py-round (* f n)))
                  (= mode "timestamp")
                  (count-votes-up-to votes (long a))))
          slots (vec (distinct raw))]
      (when (some (fn [[a b]] (> a b)) (partition 2 1 raw))
        (throw (ex-info "schedule not strictly increasing: preserve cut order" {:cuts cuts})))
      (when (and (not= (count raw) (count slots))
                 (not (true? (get cuts "deduplicate"))))
        (throw (ex-info "duplicate resolved cut slots" {:cuts cuts})))
      (when (and (some zero? slots) (not (true? (get cuts "empty_checkpoint"))))
        (throw (ex-info "zero cut requires explicit empty_checkpoint: true" {:cuts cuts})))
      (validate-slots slots n (true? (get cuts "empty_checkpoint")))
      slots)))

;; ---------------------------------------------------------------------------
;; Slicer: schedule + dataset → ordered steps (mirror slice_schedule; the tail
;; after the last cut is intentionally NOT a step — include "end" to close it).
;; ---------------------------------------------------------------------------

(defn slice-schedule
  "Mods weave per schedule.py:204-210: a mod event attaches to the FIRST cut
  whose cut-time reaches its :modified (and which is past the previous cut's
  time); events after the last cut are dropped, like tail votes."
  ([votes slots] (slice-schedule votes slots []))
  ([votes slots mod-events]
   (loop [prev 0 [cut & more] slots i 0 acc []]
     (if (nil? cut)
       acc
       (let [cut-time  (if (zero? cut) 0 (:t-ms (nth votes (dec cut))))
             prev-time (:cut-time-ms (peek acc))
             mods (filterv #(and (<= (long (:modified %)) (long cut-time))
                                 (or (nil? prev-time)
                                     (> (long (:modified %)) (long prev-time))))
                           mod-events)]
         (recur cut more (inc i)
                (conj acc {:index i
                           :prev-slot prev
                           :cut-slot cut
                           :votes (subvec votes prev cut)     ; (prev, cut] 0-based
                           :mods mods
                           :cut-time-ms cut-time})))))))

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

;; Q10 carve-out (CLOJURE_QUIRKS.md): conv-update's large-conv dispatch
;; (n-ptpts > 10000 OR n-cmts > 5000, conversation.clj:784-815) runs
;; mini-batch partial-pca on an UNSEEDED random row sample — no
;; deterministic reference exists on that path, even between two Clojure
;; runs. Certification pins both cutoffs huge so every step takes the
;; deterministic full-PCA (small-conv) path at any size. Logged per run
;; here and by certify.py's acceptance notice.
(def certify-conv-opts
  {:ptpt-cutoff 1000000000
   :cmt-cutoff  1000000000})

;; Q12 carve-out (CLOJURE_QUIRKS.md): the COLD-tick PCA start vector is
;; unseeded-random in production (rand-starting-vec, pca.clj:79-82 — the
;; original author's own "should really throw a [seeded] random number
;; generator in here... XXX" comment) — with a small eigengap, 100 power
;; iterations don't fully converge and the residual start-dependence makes
;; even two Clojure runs differ. Certification pins the cold start to the
;; ONES vector — the same value power-iteration pads new-comment columns
;; with (pca.clj:46-49) — by seeding the conv with single-element [1.0]
;; comps that the padding expands to all-ones at any width. Warm ticks are
;; untouched (real previous comps take over from tick 2). The Python replay
;; driver pins the same start.
(def certify-cold-start-pca
  {:comps [[1.0] [1.0]]})

(defn parse-blob-json
  "EXACTLY db/load-conv's key-fn (postgres.clj:419-433): numeric-string keys
  become longs, everything else keywords — including the keyword/long
  hash-map-key mismatches its own docstring warns about (e.g. :repness),
  which are part of production restart semantics."
  [s]
  (json/parse-string s (fn [x] (try (Long/parseLong x)
                                    (catch Exception _ (keyword x))))))

(defn restart-conv
  "Replicate conv-man's load-or-init restart (conv_man.clj:188-207)
  mid-schedule: rebuild the conv from its OWN just-computed math_main blob
  (prep-main → JSON round-trip → restructure-json-conv), :recompute :reboot,
  raw-rating-mat from the FULL vote log so far ([pid tid raw-db-vote] in
  dataset order — conv-poll's created-order equivalent), then mod-update with
  the FULL mod history so far (called even when empty, as load-or-init does).
  Everything restructure-json-conv drops (rating-mat, per-k
  :group-clusterings smoother memory, …) is LOST, exactly as in production."
  [conv steps-so-far]
  (let [votes-so-far (mapcat :votes steps-so-far)
        mods-so-far  (mapcat :mods steps-so-far)]
    (-> (cm/prep-main conv)
        json/generate-string
        parse-blob-json
        cm/restructure-json-conv
        (assoc :recompute :reboot)
        (assoc :raw-rating-mat
               (nm/update-nmat (nm/named-matrix)
                               (mapv (fn [{:keys [pid tid sign]}]
                                       [pid tid (- (long sign))])
                                     votes-so-far)))
        (conv/mod-update (vec mods-so-far)))))

(defn run-once
  "Returns a vector of [step conv-after-update] pairs, one per cut slot.
  The reduce threading the conv IS the implicit warm-start chain.
  conv-update runs with certify-conv-opts (Q10 full-PCA carve-out) and the
  seed conv carries certify-cold-start-pca (Q12 pinned cold start).
  Step semantics mirror conv-man's per-batch [:votes :moderation] order
  (conv_man.clj:361-371): votes → conv-update (recompute), then mods →
  conv/mod-update (sets+watermark ONLY, no recompute — the mods take effect
  at the NEXT votes recompute); ONE blob per step, recorded post-mods.
  After recording step `restart-after`, the chain continues from
  `restart-conv` (the production worker-restart seam)."
  ([zid meta-tids steps] (run-once zid meta-tids steps nil))
  ([zid meta-tids steps restart-after]
   (binding [*out* *err*]
     (println "Q10 carve-out: large-conv mini-batch PCA disabled"
              "(ptpt/cmt cutoffs pinned to 10^9; full PCA at every size)")
     (println "Q12 carve-out: cold-tick PCA start pinned to ones"
              "(production start is unseeded-random)"))
   (let [seed (-> (conv/new-conv)
                  (assoc :zid zid
                         :meta-tids (set meta-tids)
                         :pca certify-cold-start-pca))]
     (loop [conv seed [s & more] steps acc []]
       (if (nil? s)
         acc
         (let [conv' (conv/conv-update conv (->conv-votes (:votes s))
                                       certify-conv-opts)
               conv' (if (seq (:mods s))
                       (conv/mod-update conv' (vec (:mods s)))
                       conv')
               acc'  (conj acc [s conv'])
               conv'' (if (and restart-after (= (long (:index s)) (long restart-after)))
                        (do (binding [*out* *err*]
                              (println (format "restart seam after step %d (load-or-init replay)"
                                               (long (:index s)))))
                            (restart-conv conv' (map first acc')))
                        conv')]
           (recur conv'' more acc')))))))

;; ---------------------------------------------------------------------------
;; Recording.
;; ---------------------------------------------------------------------------

(defn write-blob!
  "Write the prep-main math_main view for one step, cheshire-encoded exactly as
  postgres.clj pg-json does (the DB blob's own serialization)."
  [dir step conv]
  (spit (io/file dir (format "step-%03d.blob.json" (:index step)))
        (json/generate-string (cm/prep-main conv)))
  ;; Identity sidecar: the raw prep-main blob deliberately remains unchanged.
  (spit (io/file dir (format "step-%03d.meta.json" (:index step)))
        (json/generate-string
          {:index (:index step) :prev_slot (:prev-slot step)
           :cut_slot (:cut-slot step) :batch_size (count (:votes step))
           :cut_time_ms (:cut-time-ms step)})))

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
           meta-tids-source warm-start repeats n-steps edn?
           moderation n-mod-events n-mod-skipped restart-after]}]
  {:engine "clj"
   :moderation (or moderation "none")
   :n_mod_events (or n-mod-events 0)
   :n_mod_skipped_no_modified (or n-mod-skipped 0)
   :restart_after restart-after
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
;; Moderation rows from the comments CSV (interleave-by-timestamp schedules).
;; ---------------------------------------------------------------------------

(defn read-mod-events
  "Raw moderation rows {:tid :is_meta :mod :modified} from the comments CSV,
  sorted by (modified, file order) — the conv-mod-poll stream equivalent.
  `modified` is the DB value in MILLISECONDS, compared directly against vote
  :t-ms at weave time (the py loader reads the same column identically).
  Rows with an empty `modified` cannot be woven and are SKIPPED (counted in
  :n-skipped for provenance). Columns: comment-id/tid, is-meta/is_meta,
  mod/moderated, modified."
  [comments-path]
  (with-open [rdr (io/reader comments-path)]
    (let [rows   (doall (csv/read-csv rdr))
          header (first rows)
          idx    (zipmap header (range))
          ci     (or (idx "comment-id") (idx "tid"))
          mi     (or (idx "is-meta") (idx "is_meta"))
          modi   (or (idx "mod") (idx "moderated"))
          tsi    (idx "modified")]
      (when (some nil? [ci modi tsi])
        (throw (ex-info (str "comments CSV lacks moderation columns "
                             "(need comment-id, mod/moderated, modified); header="
                             (vec header))
                        {:header header})))
      (let [parsed (->> (rest rows)
                        (keep-indexed
                          (fn [i r]
                            (let [modified-raw (str/trim (str (nth r tsi "")))]
                              (when (seq modified-raw)
                                {:tid (Long/parseLong (str/trim (nth r ci)))
                                 :is_meta (boolean
                                            (when mi
                                              (#{"1" "true" "t" "yes"}
                                               (str/lower-case (str/trim (str (nth r mi "")))))))
                                 :mod (Long/parseLong (str/trim (nth r modi)))
                                 :modified (Long/parseLong modified-raw)
                                 :file-idx i})))))
            events (->> parsed
                        (sort-by (juxt :modified :file-idx))
                        (mapv #(dissoc % :file-idx)))]
        {:events events
         :n-skipped (- (count (rest rows)) (count events))}))))

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

        (when-not (contains? #{"none" "interleave-by-timestamp" nil} moderation)
          (throw (ex-info
                   (str "Unknown moderation mode " (pr-str moderation)
                        ". Use \"none\" or \"interleave-by-timestamp\" "
                        "(mod rows from --comments, woven by modified timestamp).")
                   {:moderation moderation})))
        (when (and (= moderation "interleave-by-timestamp")
                   (nil? (:comments options)))
          (throw (ex-info "moderation=interleave-by-timestamp requires --comments"
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
              restart-after (get schedule "restart_after")
              {mod-events :events n-mod-skipped :n-skipped}
              (if (= moderation "interleave-by-timestamp")
                (read-mod-events (:comments options))
                {:events [] :n-skipped 0})
              steps (slice-schedule votes slots mod-events)
              ;; Under interleave moderation, meta-tids enter EXCLUSIVELY via
              ;; the woven mod-update rows (the production-reachable route) —
              ;; seeding them at conv creation as well would front-load every
              ;; is-meta comment into step 0's compute, which no production
              ;; state can produce (found on pc-meta-01 step 0, 2026-07-22 s4:
              ;; clj meta-tids = seed ∪ woven vs py's woven-only). The
              ;; creation-time seed remains for moderation="none" runs with
              ;; --comments (the original vw-compat path).
              [meta-tids meta-src]
              (if (= moderation "interleave-by-timestamp")
                [#{} "empty (interleave moderation: meta-tids via mod-update only)"]
                (read-meta-tids (:comments options)))]

          (when restart-after
            (when-not (and (integer? restart-after)
                           (<= 0 (long restart-after) (- (count steps) 2)))
              (throw (ex-info (str "restart_after must be a step index with at "
                                   "least one step after it; got "
                                   (pr-str restart-after) " for " (count steps)
                                   " steps")
                              {:restart_after restart-after :n-steps (count steps)}))))

          (binding [*out* *err*]
            (println (format "dataset=%s n_votes=%d schedule=%s cuts=%s"
                             dataset (count votes) schedule-id (pr-str slots)))
            (println (format "steps=%d repeats=%d edn=%s zid=%s meta-tids=%d"
                             (count steps) repeats edn? (pr-str zid) (count meta-tids)))
            (when (= moderation "interleave-by-timestamp")
              (println (format "moderation=interleave-by-timestamp mod-events=%d skipped-no-modified=%d woven=%d"
                               (count mod-events) (long n-mod-skipped)
                               (reduce + (map (comp count :mods) steps)))))
            (when restart-after
              (println (format "restart_after=%d (load-or-init seam)" (long restart-after)))))

          (.mkdirs clj-dir)
          ;; schedule.json verbatim (byte-faithful copy of the §4 input).
          (io/copy (io/file (:schedule options)) (io/file out "schedule.json"))

          ;; Run repeats. rep 0 is also written flat to clj/ (the canonical
          ;; cross-language surface); rep i>0 (and rep 0) go to clj/rep-i/.
          (dotimes [rep repeats]
            (let [results (run-once zid meta-tids steps restart-after)
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
                        :n-steps (count steps) :edn? edn?
                        :moderation moderation
                        :n-mod-events (count mod-events)
                        :n-mod-skipped n-mod-skipped
                        :restart-after restart-after})
                prov-json (json/generate-string prov {:pretty true})]
            (spit (io/file out "provenance.json") prov-json)
            (spit (io/file clj-dir "provenance.json") prov-json))

          (println (format "wrote %d steps (x%d reps) → %s"
                           (count steps) repeats (str clj-dir)))
          (System/exit 0))))))
