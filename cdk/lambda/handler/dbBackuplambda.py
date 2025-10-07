import os
import boto3
import json
import datetime
import psycopg2 # Import the library packaged by the CDK

# Initialize clients outside the handler for reuse on "warm" invocations
ssm_client = boto3.client('ssm')
secrets_client = boto3.client('secretsmanager')
s3_client = boto3.client('s3')

def lambda_handler(event, context):
    """
    Connects to an RDS instance, performs a data-only backup of all tables in the
    public schema using the COPY command, and uploads the result to S3.
    """
    conn = None
    filepath = None
    
    try:
        # --- Fetch All Configuration Programmatically ---
        print("Fetching configuration from SSM and Secrets Manager...")
        secret_arn = ssm_client.get_parameter(Name='/polis/db-secret-arn')['Parameter']['Value']
        db_host = ssm_client.get_parameter(Name='/polis/db-host')['Parameter']['Value']
        bucket_name = ssm_client.get_parameter(Name='/polis/db-backup-bucket-name')['Parameter']['Value']
        
        secret_payload = secrets_client.get_secret_value(SecretId=secret_arn)['SecretString']
        secret_data = json.loads(secret_payload)
        
        db_user = secret_data['username']
        db_password = secret_data['password']
        db_name = secret_data['dbname']
        print("Configuration fetched successfully.")
        
        # --- Create Filename and Connect to DB ---
        timestamp = datetime.datetime.now().strftime('%Y-%m-%d-%H-%M-%S')
        filename = f'polis-data-backup-{timestamp}.sql'
        filepath = f'/tmp/{filename}'
        
        print(f"Connecting to database '{db_name}' on host '{db_host}'...")
        conn = psycopg2.connect(
            dbname=db_name,
            user=db_user,
            password=db_password,
            host=db_host,
            port=5432,
            sslmode='require'
        )
        cur = conn.cursor()
        print("Database connection successful.")

        # --- Perform Backup using Pure Python ---
        print(f"Starting data backup to local file: {filepath}")
        with open(filepath, 'w') as f:
            # Get all table names from the 'public' schema
            cur.execute("""SELECT tablename FROM pg_catalog.pg_tables
                           WHERE schemaname = 'public'""")
            tables = [row[0] for row in cur.fetchall()]
            
            # For each table, dump its data to the file using the efficient COPY command
            for table in tables:
                print(f"Dumping data for table: {table}")
                f.write(f"\n-- Data for table: {table} --\n")
                # COPY is much faster than SELECT for dumping data
                cur.copy_expert(f"COPY {table} TO STDOUT", f)
        
        cur.close()
        print("Local backup file created successfully.")
        
        # --- Upload to S3 ---
        print(f"Uploading {filepath} to s3://{bucket_name}/{filename}...")
        s3_client.upload_file(filepath, bucket_name, filename)
        print("Upload to S3 complete.")
        
    except Exception as e:
        print(f"An error occurred: {e}")
        raise e
    finally:
        # --- Cleanup ---
        if conn:
            conn.close()
            print("Database connection closed.")
        if filepath and os.path.exists(filepath):
            os.remove(filepath)
            print(f"Cleaned up temporary file: {filepath}")

    return {'status': 'success', 'filename': filename}