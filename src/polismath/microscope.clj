(ns polismath.microscope
  (:require [polismath.conv-man :as cm]
            [polismath.db :as db]
            [polismath.conversation :as conv]
            [polismath.named-matrix :as nm]
            [polismath.utils :refer :all]
            [plumbing.core :as pc]
            [korma.core :as ko]
            [korma.db :as kdb]
            [polismath.env :as env]
            [clojure.tools.trace :as tr]
            [clojure.tools.logging :as log]
            [clojure.newtools.cli :refer [parse-opts]]))


(defn conv-poll
  [zid]
  (kdb/with-db (db/db-spec)
    (ko/select db/votes
      (ko/where {:zid zid})
      (ko/order [:zid :tid :pid :created] :asc))))

;; XXX Should really move to db
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
  [& {:keys [zid zinvite recompute] :as args}]
  (assert (xor zid zinvite))
  (let [zid        (or zid (get-zid-from-zinvite zinvite))
        new-votes  (conv-poll zid)
        conv-actor (cm/new-conv-actor (partial cm/load-or-init zid :recompute recompute))]
    (println zid zinvite)
    (cm/snd conv-actor [:votes new-votes])
    (add-watch
      (:conv conv-actor)
      :complete-watch
      (fn [k r o n]
        (println "Done recomputing")))
    conv-actor))


(defn kw->int
  [kw]
  (-> kw
      (str)
      (clojure.string/replace ":" "")
      (Integer/parseInt)))


(defn load-conv
  [& {:keys [zid zinvite env-overrides] :or {env-overrides {}} :as args}]
  (assert (xor zid zinvite))
  (let [zid (or zid (get-zid-from-zinvite zinvite))]
    (env/with-env-overrides env-overrides
      (->
        (db/load-conv zid)
        ;; This should be ok here right?
        (cm/restructure-mongo-conv)
        (update-in
          [:repness]
          (partial pc/map-keys kw->int))))))


(defn replay-conv-update
  "Can be run as a shell command on a error file to replay what happened."
  [filename]
  (let [data (conv/load-conv-update filename)
        {:keys [conv votes opts]} data
        {:keys [rating-mat base-clusters pca]} conv]
    (println "Loaded conv:" filename)
    (println "Dimensions:" (count (nm/rownames rating-mat)) "x" (count (nm/colnames rating-mat)))
    (conv/conv-update conv votes)))


(def cli-options
  [["-z" "--zid ZID" "ZID on which to do a rerun" :parse-fn #(Integer/parseInt %)]
   ["-Z" "--zinvite ZINVITE" "ZINVITE code on which to perform a rerun"]
   ["-r" "--recompute" "If set, will run a full recompute"]])


(defn -main
  [& args]
  (let [{:keys [options arguments errors summary]} (parse-opts args cli-options)
        conv-actor (apply-kwargs recompute options)
        done? (atom false)]
    (add-watch
      (:conv conv-actor)
      :shutdown-watch
      (fn [k r o n]
        (println n)
        (swap! done? (fn [_] true))
        (shutdown-agents)))
    (loop []
      (Thread/sleep 1000)
      (when-not @done?
        (recur)))))


