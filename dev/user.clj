(ns user
  (:require [polismath.runner :as runner]
            [polismath.system :as system]
            [polismath.meta.microscope :as microscope]
            [polismath.conv-man :as conv-man]
            [polismath.components.postgres :as postgres]))


(defn get-conv
  [{:keys [zid zinvite]}]
  (let [zid (or zid (postgres/get-zid-from-zinvite (:postgres runner/system) zinvite))]
    (-> runner/system :conversation-manager :conversations deref (get zid))))

(defn load-conv
  [{:as args :keys [zid zinvite]}]
  (let [zid (or zid (postgres/get-zid-from-zinvite (:postgres runner/system) zinvite))]
    (conv-man/load-or-init (:conversation-manager runner/system) zid)))

(comment
  (runner/run! system/base-system)
  (def args {:zid 15228})
  (load-conv args)
  (get-conv args)
  (-> runner/system :conversation-manager :conversations deref)
  :end)
