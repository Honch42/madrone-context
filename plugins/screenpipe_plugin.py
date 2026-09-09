import os
import sqlite3
from .base import ContextPlugin

class ScreenpipePlugin(ContextPlugin):
    @property
    def name(self) -> str:
        return "Screenpipe Context"

    def fetch_rearward_context(self, since_timestamp: str) -> str:
        db_path = os.path.expanduser("~/.screenpipe/db.sqlite")
        if not os.path.exists(db_path):
            return "Screenpipe: No local database found."
            
        try:
            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()
            
            # Query for the most recent 15 frames with OCR text since the timestamp
            query = """
                SELECT timestamp, app_name, window_name, full_text 
                FROM frames 
                WHERE timestamp >= ? AND full_text IS NOT NULL AND full_text != ''
                ORDER BY timestamp DESC 
                LIMIT 15
            """
            cursor.execute(query, (since_timestamp,))
            rows = cursor.fetchall()
            conn.close()
            
            if not rows:
                return "Screenpipe: No desktop activity recorded in this timeframe."
                
            results = []
            for row in rows:
                timestamp, app_name, window_name, full_text = row
                app_name = app_name or "Unknown App"
                window_name = window_name or "Unknown Window"
                
                text = full_text.replace('\n', ' ').strip()
                if len(text) > 80:
                    text = text[:80] + "..."
                    
                results.append(f"- [{timestamp}] In {app_name} ({window_name}): {text}")
                
            return "Recent Screen Activity:\n" + "\n".join(results)
        except Exception as e:
            return f"Screenpipe: Failed to fetch data ({str(e)})"
