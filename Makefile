conf = heroku config:get --app polisapp

upload:
	cd designlab/2013_winter/pitchdeck_style_landing && \
		s3cmd --noconfig=1 --access_key=`$(conf) AWS_ACCESS_KEY` --secret_key=`$(conf) AWS_SECRET_KEY` put *  s3://polisapp.com/  && \
		cd -
