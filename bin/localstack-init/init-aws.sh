#!/bin/bash
awslocal sqs create-queue \
    --queue-name import-jobs-queue \
    --attributes '{"VisibilityTimeout":"900"}'
echo "Queue initialized!"