#!/usr/bin/env python3
import os
import sys
import sqlite3
import time
import datetime
import json
import fcntl
import argparse
import keyring
import contextlib
from google import genai
from google.genai import types

# Configuration
BASE_DIR = os.path.expanduser("~/Documents/Anti-gravity/Personal Context/madrone-context")
DB_PATH = os.path.expanduser("~/Library/Application Support/OpenRecall/recall.db")
SCREENSHOTS_DIR = os.path.expanduser("~/Library/Application Support/OpenRecall/screenshots")
OUTPUT_DIR = os.path.join(BASE_DIR, "daily_summaries")
CURSOR_FILE = os.path.join(BASE_DIR, ".distiller_cursor.json")
LOCK_FILE = os.path.join(BASE_DIR, ".distiller.lock")
JSONL_STORE = os.path.join(OUTPUT_DIR, "summaries_store.jsonl")

RETENTION_DAYS = 7
RETENTION_SECONDS = RETENTION_DAYS * 86400
WINDOW_SECONDS = 3600  # 1-hour buckets

os.makedirs(OUTPUT_DIR, exist_ok=True)

def get_gemini_client():
    api_key_raw = keyring.get_password("AntiGravity", "gemini-api-key-Collective")
    if not api_key_raw:
        print("Error: Gemini API key not found in keyring.")
        sys.exit(1)
    try:
        api_key_data = json.loads(api_key_raw)
        api_key = api_key_data.get("api_key")
    except json.JSONDecodeError:
        api_key = api_key_raw

    if not api_key:
        print("Error: Could not extract API key from keyring data.")
        sys.exit(1)

    return genai.Client(api_key=api_key)

def get_cursor():
    if os.path.exists(CURSOR_FILE):
        try:
            with open(CURSOR_FILE, "r") as f:
                data = json.load(f)
                return data.get("last_id", 0)
        except Exception:
            return 0
    return 0

def save_cursor(last_id):
    with open(CURSOR_FILE, "w") as f:
        json.dump({"last_id": last_id}, f)

def extract_delta(cursor_id):
    """Extracts OCR text since the last processed ID."""
    # Use URI format for read-only connection
    uri = f"file:{DB_PATH}?mode=ro"
    
    # We must use uri=True to enable the URI filename parsing
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=10.0)
    except sqlite3.OperationalError as e:
        print(f"Could not connect to DB: {e}")
        return []

    cursor = conn.cursor()
    cursor.execute("""
        SELECT id, app, title, text, timestamp 
        FROM entries 
        WHERE id > ? AND text IS NOT NULL
        ORDER BY id ASC
    """, (cursor_id,))
    
    rows = cursor.fetchall()
    conn.close()
    return rows

def distill_window(rows, client, on_demand, start_time, model="gemini-3.6-flash"):
    """Uses Gemini to distill a specific window of context."""
    if not rows:
        return None
        
    compiled_text = ""
    for r_id, app, title, text, ts in rows:
        dt = datetime.datetime.fromtimestamp(ts).strftime('%H:%M:%S')
        compiled_text += f"[{dt}] [App: {app}] [Window: {title}]\n{text}\n---\n"
    
    if len(compiled_text) > 3000000:
        compiled_text = compiled_text[-3000000:]
        
    prompt = """
You are the Madrone Context Distiller. Review the OCR text captured from the user's screen over this specific time window and generate a high-level, lossy summary of their activities.

CRITICAL INSTRUCTIONS:
1. SCRUB ALL CREDENTIALS AND PII: Do not include any passwords, API keys, crypto seeds, bank account numbers, personal phone numbers, or private message contents.
2. SYNTHESIZE: Group activities by project, topic, or app.
3. OUTPUT FORMAT: Markdown. Use clear headers. Do not wrap the whole response in a markdown code block.
"""
    
    # Best-effort timeout for on-demand
    if on_demand:
        elapsed = time.time() - start_time
        if elapsed > 15:
            print("On-demand timeout exceeded before API call. Deferring distillation.")
            return None

    try:
        response = client.models.generate_content(
            model=model,
            contents=[prompt, compiled_text],
            config=types.GenerateContentConfig(temperature=0.2)
        )
        return response.text
    except Exception as e:
        print(f"Error calling Gemini: {e}")
        return None

def store_summary(window_start, window_end, min_id, max_id, summary_text):
    record = {
        "window_start": window_start,
        "window_end": window_end,
        "min_id": min_id,
        "max_id": max_id,
        "summary": summary_text,
        "created_at": int(time.time())
    }
    with open(JSONL_STORE, "a") as f:
        f.write(json.dumps(record) + "\n")

def render_markdown_days():
    """Renders the JSONL store into per-day markdown files."""
    if not os.path.exists(JSONL_STORE):
        return
        
    days = {}
    with open(JSONL_STORE, "r") as f:
        for line in f:
            if not line.strip(): continue
            record = json.loads(line)
            # Determine the day string in local time from window_start
            day_str = datetime.datetime.fromtimestamp(record["window_start"]).strftime("%Y-%m-%d")
            if day_str not in days:
                days[day_str] = []
            days[day_str].append(record)
            
    for day_str, records in days.items():
        # Sort by window start
        records.sort(key=lambda x: x["window_start"])
        
        md_content = f"# Context Summary: {day_str}\n\n"
        for r in records:
            w_start_str = datetime.datetime.fromtimestamp(r["window_start"]).strftime("%H:%M")
            w_end_str = datetime.datetime.fromtimestamp(r["window_end"]).strftime("%H:%M")
            md_content += f"## {w_start_str} - {w_end_str}\n\n"
            md_content += r["summary"].strip() + "\n\n---\n\n"
            
        out_file = os.path.join(OUTPUT_DIR, f"context_summary_{day_str}.md")
        # Write to temp and rename to prevent read contention from Madrone
        tmp_file = out_file + ".tmp"
        with open(tmp_file, "w") as f:
            f.write(md_content)
        os.rename(tmp_file, out_file)

def cleanup_cold_data(cursor_id):
    """Deletes entries and screenshots older than RETENTION_DAYS, strictly gated by cursor."""
    now = int(time.time())
    cutoff = now - RETENTION_SECONDS
    
    conn = sqlite3.connect(DB_PATH, timeout=20.0)
    cursor = conn.cursor()
    
    # Only delete if it's older than 7 days AND it has already been processed (id <= cursor_id)
    cursor.execute("SELECT id, timestamp FROM entries WHERE timestamp < ? AND id <= ?", (cutoff, cursor_id))
    rows_to_delete = cursor.fetchall()
    
    if not rows_to_delete:
        conn.close()
        return 0, 0
        
    # Batch delete to prevent long locks
    deleted_count = 0
    images_deleted = 0
    
    batch_size = 500
    for i in range(0, len(rows_to_delete), batch_size):
        batch = rows_to_delete[i:i+batch_size]
        ids = [r[0] for r in batch]
        
        placeholders = ",".join("?" * len(ids))
        cursor.execute(f"DELETE FROM entries WHERE id IN ({placeholders})", ids)
        conn.commit()
        deleted_count += len(ids)
        
        # Delete screenshots
        for r_id, ts in batch:
            img_path = os.path.join(SCREENSHOTS_DIR, f"{ts}.webp")
            if os.path.exists(img_path):
                try:
                    os.remove(img_path)
                    images_deleted += 1
                except Exception as e:
                    print(f"Failed to delete {img_path}: {e}")
                    
    # Vacuum periodically to reclaim space (only do this when large amounts deleted)
    if deleted_count > 0:
        cursor.execute("VACUUM")
        conn.commit()
        
    conn.close()
    return deleted_count, images_deleted

@contextlib.contextmanager
def acquire_lock(on_demand):
    f = open(LOCK_FILE, 'w')
    try:
        # Non-blocking lock
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    except BlockingIOError:
        if on_demand:
            print("Distiller is already running. Exiting on-demand run immediately.")
            sys.exit(0)
        else:
            print("Distiller is already running. Waiting for lock...")
            fcntl.flock(f, fcntl.LOCK_EX)
            yield
    finally:
        fcntl.flock(f, fcntl.LOCK_UN)
        f.close()

def main():
    parser = argparse.ArgumentParser(description="Madrone Context Broker")
    parser.add_argument("--on-demand", action="store_true", help="Run in fast on-demand mode (no purge, timeout)")
    parser.add_argument("--model", type=str, default="gemini-3.6-flash", help="Gemini model to use for distillation")
    args = parser.parse_args()
    
    start_time = time.time()
    print(f"Starting Context Broker (On-Demand: {args.on_demand}, Model: {args.model})...")
    
    with acquire_lock(args.on_demand):
        client = get_gemini_client()
        cursor_id = get_cursor()
        
        rows = extract_delta(cursor_id)
        print(f"Extracted {len(rows)} new screen captures since ID {cursor_id}.")
        
        if not rows:
            print("No new data to process.")
            if not args.on_demand:
                deleted, imgs = cleanup_cold_data(cursor_id)
                print(f"Cleanup: Deleted {deleted} DB rows and {imgs} screenshots.")
            sys.exit(0)
            
        # Bucket by hour
        buckets = {}
        for r in rows:
            r_id, app, title, text, ts = r
            # Align to top of the hour
            window_start = (ts // WINDOW_SECONDS) * WINDOW_SECONDS
            if window_start not in buckets:
                buckets[window_start] = []
            buckets[window_start].append(r)
            
        # Process each bucket
        sorted_windows = sorted(buckets.keys())
        new_cursor = cursor_id
        
        for w_start in sorted_windows:
            w_rows = buckets[w_start]
            w_end = w_start + WINDOW_SECONDS
            min_id = min(r[0] for r in w_rows)
            max_id = max(r[0] for r in w_rows)
            
            print(f"Distilling window {w_start} to {w_end} ({len(w_rows)} items) using {args.model}...")
            summary = distill_window(w_rows, client, args.on_demand, start_time, args.model)
            
            if summary:
                store_summary(w_start, w_end, min_id, max_id, summary)
                new_cursor = max(new_cursor, max_id)
                save_cursor(new_cursor)
            else:
                if args.on_demand:
                    print("Aborting further windows due to timeout or error.")
                    break
        
        # Render markdown from store
        render_markdown_days()
        
        # Cleanup (skipped if on-demand)
        if not args.on_demand:
            print("Running scheduled cold data cleanup...")
            deleted, imgs = cleanup_cold_data(new_cursor)
            print(f"Cleanup complete. Deleted {deleted} DB rows and {imgs} screenshots.")
        
    print("Context Broker pipeline complete.")

if __name__ == "__main__":
    main()
