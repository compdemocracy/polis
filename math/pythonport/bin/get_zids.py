import os
import csv
import psycopg2
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Get database connection parameters from environment variables
DB_USER = os.getenv('POSTGRES_USER')
DB_PASSWORD = os.getenv('POSTGRES_PASSWORD')
DB_NAME = os.getenv('POSTGRES_DB')
DB_PORT = os.getenv('POSTGRES_PORT')
DB_HOST = 'localhost'  # Since we're connecting to the container from host

# Establish database connection
conn = psycopg2.connect(
    dbname=DB_NAME,
    user=DB_USER,
    password=DB_PASSWORD,
    host=DB_HOST,
    port=DB_PORT
)
cursor = conn.cursor()

# Input and output file paths
input_file = 'conversations.csv'
output_file = 'conversations_zid.csv'

# Read input CSV and write output CSV
with open(input_file, 'r') as infile, open(output_file, 'w', newline='') as outfile:
    reader = csv.DictReader(infile)
    writer = csv.writer(outfile)
    
    # Write header
    writer.writerow(['zinvite', 'name', 'zid'])
    
    # Process each row
    for row in reader:
        zinvite = row['zinvite']
        name = row['name']
        
        # Query database to get zid using to_zid function
        cursor.execute("SELECT to_zid(%s)", (zinvite,))
        result = cursor.fetchone()
        zid = result[0] if result else None
        
        # Write row to output file
        writer.writerow([zinvite, name, zid])

# Close database connection
cursor.close()
conn.close()

print(f"Processing complete. Results written to {output_file}") 