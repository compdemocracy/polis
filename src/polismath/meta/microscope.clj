(ns polismath.meta.microscope
  (:require [polismath.conv-man :as cm]
            [polismath.components.env :as env]
            [polismath.components.db :as db]
            [polismath.math.conversation :as conv]
            [polismath.math.named-matrix :as nm]
            [polismath.utils :as utils]
            [clojure.tools.trace :as tr]
            [clojure.tools.logging :as log]
            [clojure.newtools.cli :refer [parse-opts]]
            [com.stuartsierra.component :as component]
            [plumbing.core :as pc]
            [korma.core :as ko]
            [korma.db :as kdb]))



(defrecord Microscope [postgres mongo conversation-manager config]
  component/Lifecycle
  ;; Don't know if there will really be any important state here;
  ;; Seems like an anti-pattern and like we should just be operating on some base-system...
  (start [this] this)
  (stop [this] this))

;; XXX Should really move to db
(defn get-zid-from-zinvite
  [{:as microscope :keys [postgres]} zinvite]
  (-> 
    (kdb/with-db (:db-spec postgres)
      (ko/select "zinvites"
        (ko/fields :zid :zinvite)
        (ko/where {:zinvite zinvite})))
    first
    :zid))


(defn recompute
  [{:as microscope :keys [conversation-manager postgres]} & {:keys [zid zinvite recompute] :as args}]
  (assert (utils/xor zid zinvite))
  (let [zid        (or zid (get-zid-from-zinvite microscope zinvite))
        new-votes  (db/conv-poll postgres zid)]
    (println zid zinvite)
    (cm/queue-message-batch! conversation-manager :votes zid new-votes)
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
  (assert (utils/xor zid zinvite))
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
        conv-actor (utils/apply-kwargs recompute options)
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


