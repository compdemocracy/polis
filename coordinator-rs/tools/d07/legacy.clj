;; Public D07 launcher. The actual poller/actor/publisher are unchanged.
(require '[polismath.system :as system]
         '[com.stuartsierra.component :as component]
         '[cheshire.core :as json]
         '[polismath.math.named-matrix :as nm]
         '[clojure.core.matrix :as matrix])
(def zid (Long/parseLong (System/getenv "D07_ZID")))
(def running
  (system/create-and-run-system! system/poller-system
    {:math-env :legacy
     :database {:url "postgres://d07_legacy:@postgres:5432/p027" :pool-size 3}
     :logging {:level :info :file "/tmp/d07.log"}
     :recompute (= "true" (System/getenv "D07_RECOMPUTE"))
     :poller {:poll-from-days-ago 50000 :zid-allowlist #{zid}
              :votes {:polling-interval 250} :moderation {:polling-interval 250}}}))
;; Observe actual actor registration without changing actor creation control flow.
(add-watch (:conversations (:conversation-manager running)) ::registration
  (fn [_ _ old new]
    (when (and (get new zid) (not (identical? (get old zid) (get new zid))))
      (locking *out*
        (spit "/state/actor-registration.jsonl"
          (str (json/generate-string
            {:zid zid :previous (when (get old zid) (System/identityHashCode (get old zid)))
             :registered (System/identityHashCode (get new zid))}) "\n") :append true)))))
(println (json/generate-string {:schema "polis-d07-legacy-process/1"
                               :pid (.pid (java.lang.ProcessHandle/current)) :zid zid
                               :clojure (clojure-version)
                               :java (System/getProperty "java.runtime.version")}))
(.addShutdownHook (Runtime/getRuntime)
  (Thread. (fn [] (component/stop running))))
;; Read the completed actor state after its ordinary publisher returns.
;; This observer never invokes compute, replaces a function, or changes state.
(loop []
  (when-let [actor (get @(:conversations (:conversation-manager running)) zid)]
    (let [conv @(:conv actor)
          raw (:raw-rating-mat conv)
          cells (when raw
                  (vec (sort (for [[ri pid] (map-indexed vector (nm/rownames raw))
                                   [ci tid] (map-indexed vector (nm/colnames raw))
                                   :let [vote (matrix/mget (nm/get-matrix raw) ri ci)]
                                   :when (number? vote)] [pid tid vote]))))]
      (spit "/state/legacy-state.tmp" (json/generate-string
        {:schema "polis-d07-legacy-state/1" :zid zid :cells cells
         :last_vote_timestamp (:last-vote-timestamp conv)
         :pid (.pid (java.lang.ProcessHandle/current))}))
      (java.nio.file.Files/move (.toPath (java.io.File. "/state/legacy-state.tmp"))
        (.toPath (java.io.File. "/state/legacy-state.json"))
        (into-array java.nio.file.CopyOption [java.nio.file.StandardCopyOption/REPLACE_EXISTING]))))
  (Thread/sleep 100)
  (recur))
