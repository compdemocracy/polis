(require '[babashka.pods :as pods])

(pods/load-pod 'org.babashka/aws "0.0.5")

(require '[pod.babashka.aws :as aws])

(def region "eu-central-1")

(def iam-client
  (aws/client {:api :iam :region region}))

(aws/doc iam-client :ListUsers)
(aws/invoke iam-client {:op :ListUsers})

