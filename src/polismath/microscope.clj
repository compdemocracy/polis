(ns polismath.microscope
  (:require [polismath.conv-man :as cm]
            [polismath.queued-agent :as qa]
            [polismath.db :as db]
            [polismath.conversation :as conv]
            [polismath.named-matrix :as nm]
            [polismath.utils :refer :all]
            [korma.core :as ko]
            [korma.db :as kdb]
            [environ.core :as env]
            [clojure.tools.trace :as tr]
            [clojure.tools.logging :as log]
            [clojure.newtools.cli :refer [parse-opts]]))



(def cli-options
  [["-z" "--zid ZID" "ZID on which to do a rerun" :parse-fn #(Integer/parseInt %)]
   ["-Z" "--zinvite ZINVITE" "ZINVITE code on which to perform a rerun"]])


(defn conv-poll
  [zid]
  (kdb/with-db (db/db-spec)
    (ko/select db/votes
      (ko/where {:zid zid})
      (ko/order [:zid :tid :pid :created] :asc))))


(defn get-zid-from-zinvite
  [zinvite]
  (-> 
    (kdb/with-db (db/db-spec)
      (ko/select "zinvites"
        (ko/fields :zid :zinvite)
        (ko/where {:zinvite zinvite})))
    first
    :zid))


(defn recompute
  [& args]
  (let [{:keys [options arguments errors summary]} (parse-opts args cli-options)
        {:keys [zid zinvite]} options
        _          (assert (xor zid zinvite))
        zid        (or zid (get-zid-from-zinvite zinvite))
        new-votes  (conv-poll zid)
        conv-agent ((cm/new-conv-agent-builder zid))]
    (qa/enqueue conv-agent {:last-timestamp 0 :reactions new-votes})
    (qa/ping conv-agent)
    (add-watch
      (:agent conv-agent)
      :complete-watch
      (fn [k r o n]
        (println "Done recomputing")
        (shutdown-agents)))
    (:agent conv-agent)))


(defn load-conv
  [& {:keys [zid zinvite] :as args}]
  (assert (xor zid zinvite))
  (let [zid (or zid (get-zid-from-zinvite zinvite))]
    (load-conv zid)))


