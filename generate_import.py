import re
import datetime

# ==========================================
# CONFIGURATION
# ==========================================
INPUT_FILE = 'raw_votes.txt' 
OUTPUT_FILE = 'import_votes.sql'
TARGET_ZID = 43549  # <--- [IMPORTANT] ENSURE THIS MATCHES YOUR CONVERSATION ID
# ==========================================

def parse_millis(iso_str):
    try:
        dt = datetime.datetime.strptime(iso_str, "%Y-%m-%dT%H:%M:%S.%fZ")
        return int(dt.timestamp() * 1000)
    except ValueError:
        return 0

def main():
    print(f"Reading {INPUT_FILE}...")
    with open(INPUT_FILE, 'r', encoding='utf-8') as f:
        content = f.read()

    # Regex (Same as before)
    regex = r"(?:[0-9a-f-]{36}::)?(user_[a-zA-Z0-9]+)\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(-?\d)\s+user_[a-zA-Z0-9]+\s+(\d+)"
    
    matches = re.findall(regex, content)
    print(f"Found {len(matches)} matches.")

    if not matches:
        print("Error: No matches found.")
        return

    unique_users = set()
    votes = []

    for m in matches:
        u_str = m[0]
        ts = parse_millis(m[1])
        vote = int(m[2])
        tid = int(m[3])
        
        unique_users.add(u_str)
        votes.append({'u': u_str, 'ts': ts, 'v': vote, 'tid': tid})

    print(f"Identified {len(unique_users)} unique users.")

    with open(OUTPUT_FILE, 'w') as f:
        f.write(f"-- Import for ZID {TARGET_ZID}\n")
        f.write("BEGIN;\n")

        # 1. Create Users (ON CONFLICT is safe here, no RULES on users table)
        for u in unique_users:
            f.write(f"INSERT INTO users (username, email, created) VALUES ('{u}', '{u}@import.local', {votes[0]['ts']}) ON CONFLICT (email) DO NOTHING;\n")

        # 2. Link Participants (ON CONFLICT is safe here too)
        for u in unique_users:
            f.write(f"INSERT INTO participants (uid, zid, created) SELECT uid, {TARGET_ZID}, {votes[0]['ts']} FROM users WHERE username = '{u}' ON CONFLICT (zid, uid) DO NOTHING;\n")

        # 3. Cast Votes (CHANGED: Removed ON CONFLICT, added WHERE NOT EXISTS)
        # This bypasses the 'Rule' limitation in Postgres
        for v in votes:
            f.write(
                f"INSERT INTO votes (zid, pid, tid, vote, created) "
                f"SELECT {TARGET_ZID}, p.pid, {v['tid']}, {v['v']}, {v['ts']} "
                f"FROM participants p "
                f"JOIN users u ON p.uid = u.uid "
                f"WHERE u.username = '{v['u']}' "
                f"AND p.zid = {TARGET_ZID} "
                f"AND NOT EXISTS ( "
                f"   SELECT 1 FROM votes v2 "
                f"   WHERE v2.zid = {TARGET_ZID} "
                f"   AND v2.pid = p.pid "
                f"   AND v2.tid = {v['tid']} "
                f");\n"
            )
        
        f.write("COMMIT;\n")

    print(f"Success! Generated {OUTPUT_FILE}")

if __name__ == "__main__":
    main()