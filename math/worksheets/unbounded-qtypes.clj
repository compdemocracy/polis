;; gorilla-repl.fileformat = 1
;; Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.


;; **
;;; # Thoughts on unbounded numerical variables as custom question tpyes, as relates to Polis
;;; 
;;; Say we take a distribution @@X@@ with mean and variance @@\mu_X@@ and @@v_X@@, respectively.
;;; We would like to determine the most natural/normalized logistic transformation for this distribution into some fixed interval @@[a, -a]@@, such that these tranformed values are appropriate for analysis with typical Polis binary question data for PCA and clustering.
;;; Naturally, the logistic should be centered on @@\mu_X@@, giving
;;; 
;;; $$ f(x) = \frac{1}{1+e^{\mu_X - x}}$$
;;; 
;;; Additionally, we would like the limits to be @@[-a, a]@@, giving
;;; 
;;; $$ f(x) = \frac{2a}{1+e^{\mu_X - x}} - a$$
;;; 
;;; Lastly, we'll want to adjust things so that we datasets with different @@\mu@@ roughly on the same footing.
;;; Thus we introduce one more parameter, @@k@@, such that
;;; 
;;; $$ f(x) = \frac{2a}{1+ke^{\mu_X - x}} - a$$
;;; 
;;; This gives us something to start with.
;;; The most straight forward thing to do is set @@k = e^{-v_X}@@.
;;; This will have the effect of normalizing the part in the exponent to the mean value to be found therein.
;;; This won't completely normalize variances across data sets, but it should be relatively fair, and is simple.
;;; 
;;; ## Pontification on adjustusting the variance of the output distribution
;;; 
;;; > Future Self: I thought I might be able to do this analytically, but I don't think I can, so I'm just leaving the scratchings of what I managed to figure out here in case I feel like picking it up later.
;;; 
;;; Naturally, it would be good if we also had the variances of different distributions going in somewhat normalized.
;;; Let's see if we can figure out what the variance of the transformed distribution will be analytically:
;;; 
;;; $$ Var(X') = E[(X' - \mu_{X'})^2] $$
;;; $$         = E[(X')^2] $$
;;; $$         = E[(f(X))^2] $$
;;; 
;;; Well...
;;; 
;;; This is getting messy. I'm thinking we cut our losses here. But here's what I've come up with.
;;; 
;;; We basically want to add a scaling factor
;;; 
;;; Letting @@g(x)=\frac{1}{1+ke^{\mu_X - x}}@@, we can obtain from the above
;;; 
;;; $$ Var(X') = a^2 ( 4 E[g(x)^2] - 2 E[g(x)] + 1 )$$
;;; 
;;; Thus if we could analytically determine the value of @@E[g(x)]@@ and @@E[g(x)^2]@@, we could ensure we always have the same variance.
;;; 
;;; 
;; **

;; @@
(ns unbounded-qtypes
  (:require [gorilla-plot.core :as plot]))
;; @@
;; =>
;;; {"type":"html","content":"<span class='clj-nil'>nil</span>","value":"nil"}
;; <=

;; **
;;; Say we take a 
;; **
