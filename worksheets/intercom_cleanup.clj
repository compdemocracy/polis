;; gorilla-repl.fileformat = 1
;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.


;; **
;;; # Intercom data cleanup
;;; 
;;; The intercom data is currently a bit of mess. This is my attempt to clean that up a bit.
;; **

;; @@
(ns intercom-cleanup
  (:require [gorilla-plot.core :as plot]
            [polismath.intercom :as ic]
            [polismath.db :as db]
            [polismath.pretty-printers :as pp]
            [polismath.utils :refer :all]
            [environ.core :as env]))
;; @@
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; @@
; Defining some helpers
(defn head [data & [n]] (take (or n 10) data))
;; @@
;; =>
;;; {"type":"html","content":"<span class='clj-var'>#&#x27;intercom-cleanup/head</span>","value":"#'intercom-cleanup/head"}
;; <=

;; @@
; Load the data, and do preliminary parsing
(def users        (ic/get-intercom-users))
(def valid-ids    (ic/valid-user-ids users))
(def users-w-ids  (filter #(get % "user_id") users))
(def users-wo-ids (filter #(not (get % "user_id")) users))
;; @@
;; =>
;;; {"type":"html","content":"<span class='clj-var'>#&#x27;intercom-cleanup/users-wo-ids</span>","value":"#'intercom-cleanup/users-wo-ids"}
;; <=

;; @@

; Now digging down a little more... We'd like to find out what's going on with the various discrepencies

(def good-id-by-email (db/get-users-by-email (map #(get % "email") users-w-ids)))
(def good-id-by-email-ids (set (map :uid good-id-by-email)))
(def bad-emails-good-ids-users (remove #(good-id-by-email-ids (Integer/parseInt (get % "user_id"))) users-w-ids))
(def bad-emails-good-ids-ids (set (map #(get % "user_id") bad-emails-good-ids-users)))
(def bad-emails-good-ids-dbrecs
  (db/get-users-by-uid
    (map #(Integer/parseInt (get % "user_id")) bad-emails-good-ids-users)))

(println (map :email bad-emails-good-ids-dbrecs))
(println (map #(get % "email") bad-emails-good-ids-users))


;; @@
;; ->
;;; (light24bulbs@gmail.com m@bjorkegren.com colinmegill@gmail.com timo.erkkila@gmail.com metasoarous@gmail.com sameubank@gmail.com andrew.j.smith@outlook.com mike@pol.is rosas.ben@gmail.com nina@elanprojects.com.au adrian@principalcreative.com.au rosiehoyem@gmail.com oasidjfoiasdjfio@aosidjfiosjdf nil nil nil nil)
;;; (                )
;;; 
;; <-
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; **
;;; 
;; **

;; **
;;; There are a number of ways we could hack this up. It seems like we have those ic records for which there are `user_id`s, and those for whom there are not. For the former, updating the emails and times based on the records fetched by the `user_id -> uid` mapping, should be good, as long as there aren't any such mappings that are bad. On the other hand, for the set fetched by email, they should have the correct `user_id` values, so doing the matching by email should be fine. It's really then just the last set, which don't match by ID or email that we have to worry about. 
;;; 
;;; Let's see what those look like as well.
;;; 
;;; ## Those matching by id have either no email or the correct email?
;; **

;; @@
; This is for figuring out if all the email matching for the good IDs work

(let [ic-users users-w-ids
      db-users (db/get-users-by-uid
                 (map #(Integer/parseInt (get % "user_id")) ic-users))
      get-dbuser-email-from-icuser-by-id
        (fn [u]
          (->> db-users
               (filter #(= (:uid %) (Integer/parseInt (get u "user_id"))))
               (first)
               (:email)))]
  (doseq [u ic-users]
    (let [ic-email (get u "email")
          db-email (get-dbuser-email-from-icuser-by-id u)]
      (when-not
        (or (empty? ic-email)
            (= ic-email db-email))
        (println [ic-email db-email])))))

;; @@
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; **
;;; OK! That seems to settle it! For every ic user for which we have an id that maps to a user in the db, either we don't have the email for the ic record, or the email matches. That means we should be able to safely just update these by passing the email and id together in the update hash, and it will take care of the emails.
;;; 
;;; ## Now for the ones without ID or email matches:
;; **

;; @@
; Now we figure out what's going on with the ones without ID or email matches
(let [ic-users users-wo-ids
      db-users (db/get-users-by-email
                 (map #(get % "email") ic-users))
      db-users-emails (set (map :email db-users))
      ic-users-bademail (filter
                 #(not (db-users-emails (get % "email")))
                 ic-users)]
  (println "Count difference of" (count ic-users)
           "in intercom and" (count db-users) "in db is"
           (- (count ic-users) (count db-users)))
  (doseq [u ic-users-bademail]
    (println
      (ic/gets u ["id" "name" "email"]))))
;; @@
;; ->
;;; Count difference of 87 in intercom and 83 in db is 4
;;; [53518179fd3643755a00a286 Brian Hayashi brian.hayashi@realtimevegas.co]
;;; [5352186115e25868ca030190 Sheikh Shuvo sheikh@startupweekend.org]
;;; [53ce51450083083acd0003d2 Matti Nelimarkka matti.nelimarkka@hiit.fi]
;;; [53ff62bb7f4310150100083d Julien Brinas julien@castle.ventures]
;;; 
;; <-
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; **
;;; 
;;; Ah... I think these may be more bad email uniformity issues. I find this:
;;; 
;;; 
;;;     polisapp::BLUE=> select uid, hname, username, email, is_owner, created, plan from users where email like '%clark%';                                               
;;;       uid  |     hname      | username |           email           | is_owner |    created    | plan 
;;;     -------+----------------+----------+---------------------------+----------+---------------+------
;;;       3021 | Arianna Clark  |          | arianna.clark@example.com | f        | 1383284862972 |    0
;;;      26566 | Don            |          | Donclark@gmail.com        | t        | 1397801313466 |    0
;;;      26630 | Andrew Clarke  |          | aclarke@samuelfrench.com  | t        | 1398110554656 |    0
;;;      50862 | Clark Mitchell |          | clarkcsmitchell@gmail.com | t        | 1409111052941 |    0
;;;      84497 | Quinn Rohlf    |          | qrohlf@lclark.edu         | t        | 1409672505722 |    0
;;;     (5 rows)
;;; 
;;; I'm guessing the others are going to have similar issues. Time to normalize...
;;; 
;;; Interesting...
;;; 
;;;     polisapp::BLUE=> select uid, hname, username, email, is_owner, created, plan from users where hname = 'Brian Hayashi';                                            
;;;       uid  |     hname     | username |         email          | is_owner |    created    | plan 
;;;     -------+---------------+----------+------------------------+----------+---------------+------
;;;      26586 | Brian Hayashi |          | brian@realtimevegas.co | t        | 1397845450433 |    0
;;;     (1 row)
;;; 
;;; Looks like maybe we need to catch email updates? brian vs brian.hayashi works. Will have to manually take care of this one through our intercom update function.
;;; 
;;; Also this one:
;;; 
;;;     polisapp::BLUE=> select uid, hname, username, email, is_owner, created, plan from users where hname = 'Sheikh Shuvo';
;;;       uid  |    hname     | username |    email     | is_owner |    created    | plan 
;;;     -------+--------------+----------+--------------+----------+---------------+------
;;;      26571 | Sheikh Shuvo |          | sheikh@up.co | t        | 1397823287771 |    0
;;;     (1 row)
;;; 
;;; ### Caps fixes
;;; * Don (donclark)
;;; * Don/Dave Evins
;;; * Loki Astari
;;; 
;;; > Note: I reran the panel above this to get the intercom ids, and now only 4 show up there. There were 7 before.
;;; 
;;; ### Wrong address period:
;;; * **Brian Hayashi**: brian@realtimevegas.co -> brian.hayashi@realtimevegas.co
;;; * **Sheikh Shuvo**: sheikh@startupweekend.org -> sheikh@up.co
;;; * **Matti**: matti.nelimarkka@hiit.fi -> matti.nelimarkka@gmail.com
;;; * **Julien Brinas**: julien@castle.ventures -> julien@togetheraway.com
;;; 
;;; Woah.. Wait, ok. There are two entries in Intercom for Julien. One with the bad address, the other not. So did he put his email address in incorrectly, leaving the user not in the database? Cause I can't find the other email address in the database (`castle.ventures`). Let's see if we have this problem with the others:
;;; 
;;; Ah... interesting. Those names appear elsewhere in the IC db. So people are entering bad/old email addresses that don't save to the DB, and then correcting with more recent ones? OR something!!!
;;; 
;;; In any case, it seems like we can ignore these 4, since there are updated records for them. We _should_ probably delete the old ones though.
;;; 
;;; 
;;; 
;; **

;; @@

;; @@
