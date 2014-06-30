#!/usr/bin/env Rscript

library(argparse)
library(cluster)

n <- 3
c <- 3

data <- matrix(sample(0:9, n * c, replace=T), nrow=n)
clusts <- kmeans(data, 2)
sil <- silhouette(clusts$cluster, dist(data))

print(data)
#      [,1] [,2] [,3]
# [1,]    5    9    3
# [2,]    3    2    7
# [3,]    5    7    1

print(clusts)
# K-means clustering with 2 clusters of sizes 2, 1
# Cluster means:
#   [,1] [,2] [,3]
# 1    5    8    2
# 2    3    2    7
# 
# Clustering vector:
# [1] 1 2 1
# 
# Within cluster sum of squares by cluster:
# [1] 4 0
#  (between_SS / total_SS =  91.5 %)

print(sil)

#      cluster neighbor sil_width
# [1,]       1        2 0.6594974
# [2,]       2        1 0.0000000
# [3,]       1        2 0.6491768

