#!/bin/bash
awslocal sqs create-queue --queue-name import-jobs-queue
echo "Queue initialized!"